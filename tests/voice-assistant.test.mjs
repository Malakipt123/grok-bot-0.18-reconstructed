import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(relative) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-voice-assistant-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/voice-assistant", relative)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, temporary, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function actionContext(overrides = {}) {
  const calls = [];
  return {
    calls,
    context: {
      platform: "darwin",
      run: async (file, args) => { calls.push([file, ...args]); },
      notesPath: path.join(os.tmpdir(), "unused-notes.md"),
      now: () => new Date("2026-10-22T09:30:00"),
      locale: "pt",
      ...overrides,
    },
  };
}

test("intent router handles obvious commands locally and defers questions to Grok", async () => {
  const { module, dispose } = await loadModule("intent-router.ts");
  try {
    assert.deepEqual(module.routeIntent("Abre o Spotify"), { kind: "action", action: "open_app", args: { name: "Spotify" } });
    assert.deepEqual(module.routeIntent("open github.com/x"), { kind: "action", action: "open_url", args: { url: "https://github.com/x" } });
    assert.deepEqual(module.routeIntent("põe o volume a 40%"), { kind: "action", action: "set_volume", args: { level: 40 } });
    assert.deepEqual(module.routeIntent("volume 140"), { kind: "llm" });
    assert.deepEqual(module.routeIntent("Que horas são?"), { kind: "action", action: "get_time", args: {} });
    assert.deepEqual(module.routeIntent("toma nota comprar leite"), { kind: "action", action: "take_note", args: { text: "comprar leite" } });
    assert.deepEqual(module.routeIntent("Para!"), { kind: "stop" });
    assert.deepEqual(module.routeIntent("abre o relatório que escrevi ontem à noite"), { kind: "llm" });
    assert.deepEqual(module.routeIntent("Qual é a capital da Austrália?"), { kind: "llm" });
  } finally {
    await dispose();
  }
});

test("actions run argv-only commands and reject unsafe input", async () => {
  const { module, temporary, dispose } = await loadModule("actions.ts");
  try {
    const { calls, context } = actionContext({ notesPath: path.join(temporary, "notes", "notes.md") });
    assert.equal(await module.executeAction("open_app", { name: "Visual Studio Code" }, context), "Opened Visual Studio Code.");
    await module.executeAction("set_volume", { level: 35 }, context);
    await module.executeAction("open_url", { url: "https://x.ai/api" }, context);
    assert.deepEqual(calls, [
      ["open", "-a", "Visual Studio Code"],
      ["osascript", "-e", "set volume output volume 35"],
      ["open", "https://x.ai/api"],
    ]);
    await assert.rejects(module.executeAction("open_app", { name: "Safari; rm -rf ~" }, context));
    await assert.rejects(module.executeAction("open_url", { url: "file:///etc/passwd" }, context));
    await assert.rejects(module.executeAction("set_volume", { level: "100; beep" }, context));
    assert.equal(calls.length, 3);

    await module.executeAction("take_note", { text: "comprar\nleite" }, context);
    assert.equal(await readFile(context.notesPath, "utf8"), `- ${context.now().toISOString()} comprar leite\n`);
  } finally {
    await dispose();
  }
});

test("profile parser reads persona, capabilities and routines", async () => {
  const { module, dispose } = await loadModule("profile.ts");
  try {
    const profile = module.parseAssistantProfile(`# ASSISTANT.md
## Persona
You are Jarvis.
## What it does
Triage inbox · Daily brief
## When it runs
07:00 — Daily brief → log.md
- 12:30 - Inbox triage -> inbox.md
25:00 — Impossible
08:00 — Escape → ../../etc/passwd
18:00 — End-of-day
`);
    assert.equal(profile.persona, "You are Jarvis.");
    assert.equal(profile.capabilities, "Triage inbox · Daily brief");
    assert.deepEqual(profile.routines.map(({ time, name, logFile }) => [time, name, logFile]), [
      ["07:00", "Daily brief", "log.md"],
      ["12:30", "Inbox triage", "inbox.md"],
      ["18:00", "End-of-day", "log.md"],
    ]);
    assert.equal(module.parseAssistantProfile(module.DEFAULT_ASSISTANT_PROFILE).routines.length, 2);
  } finally {
    await dispose();
  }
});

test("assistant answers locally, runs Grok tool calls, and keeps tool-safe history", async () => {
  const { module, dispose } = await loadModule("assistant.ts");
  try {
    const requests = [];
    const replies = [
      { content: null, toolCalls: [{ id: "call_1", type: "function", function: { name: "open_url", arguments: "{\"url\":\"https://news.ycombinator.com\"}" } }] },
      { content: "[laughs] Já está aberto.", toolCalls: [] },
      { content: "Canberra.", toolCalls: [] },
    ];
    const grok = {
      async complete(messages, tools) {
        requests.push({ messages: structuredClone(messages), tools: tools.map((tool) => tool.function.name) });
        return replies.shift();
      },
    };
    const { calls, context } = actionContext();
    const assistant = new module.VoiceAssistant({
      grok,
      profile: { persona: "You are Jarvis.", capabilities: "", routines: [] },
      actions: context,
      language: "pt",
      historyLimit: 20,
    });

    assert.deepEqual(await assistant.handle("abre o Safari"), { text: "Opened Safari.", source: "local" });
    assert.equal(requests.length, 0);

    assert.deepEqual(await assistant.handle("mostra-me as notícias de tecnologia"), { text: "[laughs] Já está aberto.", source: "grok" });
    assert.deepEqual(calls.at(-1), ["open", "https://news.ycombinator.com/"]);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.includes("open_url"));
    assert.match(requests[0].messages[0].content, /language with code "pt"/);
    assert.deepEqual(requests[1].messages.at(-1), { role: "tool", tool_call_id: "call_1", content: "Opened news.ycombinator.com." });

    await assistant.handle("Qual é a capital da Austrália?");
    const last = requests.at(-1).messages;
    assert.deepEqual(last.slice(1).map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(module.stripAudioTags("[laughs] Já está aberto."), "Já está aberto.");

    assert.deepEqual(await assistant.handle("cala-te"), { text: "", source: "stop" });
  } finally {
    await dispose();
  }
});

test("trimHistory never starts on an orphaned tool message", async () => {
  const { module, dispose } = await loadModule("assistant.ts");
  try {
    const history = [
      { role: "user", content: "a" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "1", content: "x" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    assert.deepEqual(module.trimHistory(history, 4).map((message) => message.content), ["c", "d"]);
    assert.equal(module.trimHistory(history, 10).length, 6);
  } finally {
    await dispose();
  }
});

test("scheduler fires each routine once per day and skips times already passed at startup", async () => {
  const { module, dispose } = await loadModule("scheduler.ts");
  try {
    let now = new Date("2026-10-22T08:00:00");
    const fired = [];
    const routines = [
      { time: "07:00", hour: 7, minute: 0, name: "Daily brief", logFile: "log.md" },
      { time: "12:00", hour: 12, minute: 0, name: "Inbox triage", logFile: "log.md" },
    ];
    const scheduler = new module.RoutineScheduler({ routines, now: () => now, run: async (routine) => { fired.push(routine.name); } });
    assert.deepEqual(await scheduler.tick(), []);
    now = new Date("2026-10-22T12:00:30");
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(fired, ["Inbox triage"]);
    now = new Date("2026-10-23T07:01:00");
    await scheduler.tick();
    assert.deepEqual(fired, ["Inbox triage", "Daily brief"]);
  } finally {
    await dispose();
  }
});

test("Grok and ElevenLabs clients send the documented request shapes", async () => {
  const grokModule = await loadModule("grok.ts");
  const elevenModule = await loadModule("elevenlabs.ts");
  try {
    const seen = [];
    const fakeFetch = async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "Olá" } }] });
      if (url.includes("/text-to-speech/")) return new Response(new Uint8Array([1, 2, 3]));
      if (url.endsWith("/speech-to-text")) return Response.json({ text: " olá jarvis " });
      return new Response("nope", { status: 404 });
    };

    const grok = new grokModule.module.GrokClient({ apiKey: "xai-key", baseUrl: "https://api.x.ai/v1", model: "grok-4", fetch: fakeFetch });
    assert.deepEqual(await grok.complete([{ role: "user", content: "hi" }]), { content: "Olá", toolCalls: [] });
    assert.equal(seen[0].init.headers.authorization, "Bearer xai-key");
    assert.deepEqual(JSON.parse(seen[0].init.body), { model: "grok-4", messages: [{ role: "user", content: "hi" }] });

    const eleven = new elevenModule.module.ElevenLabsClient({
      apiKey: "el-key", baseUrl: "https://api.elevenlabs.io/v1", voiceId: "voice/1",
      ttsModel: "eleven_v3", sttModel: "scribe_v1", language: "pt", fetch: fakeFetch,
    });
    assert.deepEqual([...await eleven.synthesize("[sighs] olá")], [1, 2, 3]);
    assert.equal(seen[1].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128");
    assert.equal(seen[1].init.headers["xi-api-key"], "el-key");
    assert.deepEqual(JSON.parse(seen[1].init.body), { text: "[sighs] olá", model_id: "eleven_v3" });

    assert.equal(await eleven.transcribe(new Uint8Array([0])), "olá jarvis");
    const form = seen[2].init.body;
    assert.equal(form.get("model_id"), "scribe_v1");
    assert.equal(form.get("language_code"), "pt");

    const failing = new grokModule.module.GrokClient({ apiKey: "k", baseUrl: "https://bad", model: "m", fetch: async () => new Response("rate limited", { status: 429 }) });
    await assert.rejects(failing.complete([]), /429.*rate limited/);
  } finally {
    await grokModule.dispose();
    await elevenModule.dispose();
  }
});

test("config requires both API keys and applies defaults", async () => {
  const { module, dispose } = await loadModule("config.ts");
  try {
    assert.throws(() => module.loadVoiceAssistantConfig({ XAI_API_KEY: "x" }), /ELEVENLABS_API_KEY/);
    const config = module.loadVoiceAssistantConfig({ XAI_API_KEY: " x ", ELEVENLABS_API_KEY: "e", XAI_BASE_URL: "https://proxy/v1/" });
    assert.equal(config.xaiApiKey, "x");
    assert.equal(config.xaiBaseUrl, "https://proxy/v1");
    assert.equal(config.grokModel, "grok-4");
    assert.equal(config.elevenLabsTtsModel, "eleven_v3");
    assert.equal(config.language, "pt");
    assert.equal(config.historyLimit, 20);
  } finally {
    await dispose();
  }
});

test("audio command selection prefers sox and falls back to ffmpeg", async () => {
  const { module, dispose } = await loadModule("audio.ts");
  try {
    assert.equal(module.recorderCommand("o.wav", "darwin", (name) => name === "sox").file, "sox");
    assert.deepEqual(module.recorderCommand("o.wav", "darwin", (name) => name === "ffmpeg").args.slice(3, 7), ["-f", "avfoundation", "-i", ":0"]);
    assert.equal(module.recorderCommand("o.wav", "win32", (name) => name === "ffmpeg"), null);
    assert.equal(module.playerCommand("r.mp3", "darwin", () => false).file, "afplay");
    assert.equal(module.playerCommand("r.mp3", "linux", (name) => name === "mpg123").file, "mpg123");
    assert.equal(module.playerCommand("r.mp3", "linux", () => false), null);
  } finally {
    await dispose();
  }
});

function desktopHarness(overrides = {}) {
  const events = [];
  const shortcuts = new Map();
  let playResolve = null;
  const deps = {
    env: { XAI_API_KEY: "x" },
    readSecret: async (key) => (key === "ELEVENLABS_API_KEY" ? "from-secrets" : null),
    reportFailure: (leg, error) => events.push(["failure", leg, String(error)]),
    notify: (title, body) => events.push(["notify", body]),
    requestMicrophoneAccess: async () => { events.push(["mic"]); return true; },
    cue: (kind) => events.push(["cue", kind]),
    shortcut: {
      register: (accelerator, callback) => { shortcuts.set(accelerator, callback); return true; },
      unregister: (accelerator) => shortcuts.delete(accelerator),
    },
    startRecording: async () => ({ stop: async () => new Uint8Array(16_000) }),
    player: {
      play: (audio) => new Promise((resolve) => { events.push(["play", audio.length]); playResolve = resolve; }),
      stop: () => { events.push(["player-stop"]); playResolve?.(); playResolve = null; },
    },
    createRuntime: async (config) => {
      events.push(["config", config.xaiApiKey, config.elevenLabsApiKey]);
      return {
        profile: { persona: "", capabilities: "", routines: [] },
        voice: { transcribe: async () => "que horas são?", synthesize: async (text) => new Uint8Array(text.length) },
        assistant: { handle: async (text) => ({ text: `[laughs] ${text} 09:30`, source: "local" }) },
        runRoutine: async () => "",
      };
    },
    ...overrides,
  };
  return { deps, events, shortcuts, finishPlayback: () => { playResolve?.(); playResolve = null; } };
}

test("desktop voice assistant toggles listening on the global shortcut and speaks the reply", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    const harness = desktopHarness();
    const result = await module.startDesktopVoiceAssistant(harness.deps);
    assert.equal(result.status, "started");
    assert.equal(result.assistant.accelerator, "Alt+Space");
    assert.ok(harness.shortcuts.has("Alt+Space"));
    assert.deepEqual(harness.events[0], ["config", "x", "from-secrets"]);

    await result.assistant.toggle();
    assert.equal(result.assistant.state, "listening");
    const finished = result.assistant.toggle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.assistant.state, "speaking");
    harness.finishPlayback();
    await finished;
    assert.equal(result.assistant.state, "idle");
    assert.ok(harness.events.some((event) => event[0] === "notify" && event[1] === "que horas são? 09:30"));
    assert.deepEqual(harness.events.filter((event) => event[0] === "cue").map((event) => event[1]), ["start", "stop"]);
    assert.equal(harness.events.filter((event) => event[0] === "mic").length, 1);

    result.assistant.dispose();
    assert.equal(harness.shortcuts.size, 0);
  } finally {
    await dispose();
  }
});

test("pressing the shortcut while Jarvis speaks interrupts playback and listens again", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    const harness = desktopHarness();
    const { assistant } = await module.startDesktopVoiceAssistant(harness.deps);
    await assistant.toggle();
    const firstTurn = assistant.toggle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(assistant.state, "speaking");
    await assistant.toggle();
    await firstTurn;
    assert.equal(assistant.state, "listening");
    assert.ok(harness.events.some((event) => event[0] === "player-stop"));
    assistant.dispose();
  } finally {
    await dispose();
  }
});

test("desktop voice assistant stays off without keys, when disabled, or when the shortcut is taken", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    const noKeys = desktopHarness({ env: {}, readSecret: async () => null });
    assert.equal((await module.startDesktopVoiceAssistant(noKeys.deps)).status, "missing-keys");
    assert.equal(noKeys.shortcuts.size, 0);

    const disabled = desktopHarness({ env: { JARVIS_SHORTCUT: "off", XAI_API_KEY: "x", ELEVENLABS_API_KEY: "e" } });
    assert.equal((await module.startDesktopVoiceAssistant(disabled.deps)).status, "disabled");

    const taken = desktopHarness();
    taken.deps.shortcut.register = () => false;
    assert.equal((await module.startDesktopVoiceAssistant(taken.deps)).status, "shortcut-unavailable");

    const silent = desktopHarness({ startRecording: async () => ({ stop: async () => new Uint8Array(100) }) });
    const { assistant } = await module.startDesktopVoiceAssistant(silent.deps);
    await assistant.toggle();
    await assistant.toggle();
    assert.equal(assistant.state, "idle");
    assert.ok(!silent.events.some((event) => event[0] === "play"));
    assistant.dispose();

    const denied = desktopHarness({ requestMicrophoneAccess: async () => false });
    const deniedStart = await module.startDesktopVoiceAssistant(denied.deps);
    await deniedStart.assistant.toggle();
    assert.equal(deniedStart.assistant.state, "idle");
    assert.match(denied.events.find((event) => event[0] === "notify")[1], /Microphone access/);
    deniedStart.assistant.dispose();
  } finally {
    await dispose();
  }
});

test("Electron adapter maps globalShortcut, notifications and macOS microphone access", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-voice-electron-"));
  try {
    const output = path.join(temporary, "adapter.mjs");
    await build({
      entryPoints: [path.join(repoRoot, "source/electron-main/voice-assistant/electron-voice-assistant.ts")],
      outfile: output, bundle: true, format: "esm", platform: "node", target: "node22",
    });
    const adapter = await import(pathToFileURL(output).href);
    const calls = [];
    class FakeNotification {
      constructor(options) { this.options = options; }
      static isSupported() { return true; }
      show() { calls.push(["notification", this.options.title, this.options.body, this.options.silent]); }
    }
    const electron = {
      globalShortcut: { register: (accelerator) => { calls.push(["register", accelerator]); return true; }, unregister: (accelerator) => calls.push(["unregister", accelerator]) },
      Notification: FakeNotification,
      systemPreferences: { getMediaAccessStatus: () => "not-determined", askForMediaAccess: async () => { calls.push(["ask"]); return true; } },
    };
    const bindings = { readSecret: async () => null, reportFailure: () => {}, env: {}, platform: "darwin" };
    const deps = adapter.createElectronVoiceAssistantDeps(bindings, electron);
    assert.equal(deps.shortcut.register("Alt+Space", () => {}), true);
    deps.shortcut.unregister("Alt+Space");
    deps.notify("Jarvis", "Olá");
    assert.equal(await deps.requestMicrophoneAccess(), true);
    assert.deepEqual(calls, [["register", "Alt+Space"], ["unregister", "Alt+Space"], ["notification", "Jarvis", "Olá", true], ["ask"]]);
    const linux = adapter.createElectronVoiceAssistantDeps({ ...bindings, platform: "linux" }, electron);
    assert.equal(await linux.requestMicrophoneAccess(), true);
    assert.equal(calls.length, 4);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
