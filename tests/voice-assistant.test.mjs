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
    const wav = await eleven.synthesize("[sighs] olá");
    assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
    assert.deepEqual([...wav.subarray(44)], [1, 2, 3]);
    assert.equal(Buffer.from(wav).readUInt32LE(24), 22050);
    assert.equal(seen[1].url, "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=pcm_22050");
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
    const sox = module.recorderCommand("darwin", (name) => name === "sox");
    assert.equal(sox.file, "sox");
    assert.deepEqual(sox.args, ["-q", "-d", "-t", "raw", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", "-"]);
    const ffmpeg = module.recorderCommand("darwin", (name) => name === "ffmpeg");
    assert.deepEqual(ffmpeg.args.slice(2, 6), ["-f", "avfoundation", "-i", ":0"]);
    assert.deepEqual(ffmpeg.args.slice(-3), ["-f", "s16le", "-"]);
    assert.equal(module.recorderCommand("win32", (name) => name === "ffmpeg"), null);
    assert.equal(module.playerCommand("r.wav", "darwin", () => false).file, "afplay");
    assert.equal(module.playerCommand("r.wav", "linux", (name) => name === "aplay").file, "aplay");
    assert.equal(module.playerCommand("r.wav", "linux", () => false), null);
    assert.match(module.toolEnv({ PATH: "/usr/bin" }, "darwin").PATH, /^\/usr\/bin:.*\/opt\/homebrew\/bin/);
  } finally {
    await dispose();
  }
});

// A WAV of n loud-then-silent samples at 1 kHz, enough for a few envelope windows.
function wavOf(samples) {
  const pcm = Buffer.alloc(Math.max(200, samples) * 2);
  for (let index = 0; index < pcm.length / 4; index += 1) pcm.writeInt16LE(index % 2 ? 20000 : -20000, index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(1000, 24);
  header.writeUInt32LE(2000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}

async function waitFor(condition, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function desktopHarness(overrides = {}) {
  const events = [];
  const shortcuts = new Map();
  let playResolve = null;
  let released = false;
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
    startRecording: async (options) => {
      options.onLevel?.(0.5);
      return { stop: async () => new Uint8Array(16_000) };
    },
    player: {
      play: (audio, onStart) => new Promise((resolve) => {
        events.push(["play", audio.length]);
        onStart?.();
        if (released) setTimeout(resolve, 5);
        else playResolve = resolve;
      }),
      stop: () => { events.push(["player-stop"]); playResolve?.(); playResolve = null; },
    },
    createRuntime: async (config) => {
      events.push(["config", config.xaiApiKey, config.elevenLabsApiKey]);
      return {
        profile: { persona: "", capabilities: "", routines: [] },
        voice: { transcribe: async () => "que horas são?", synthesize: async (text) => wavOf(text.length) },
        assistant: {
          handle: async (text, options = {}) => {
            const reply = `[laughs] ${text} 09:30`;
            options.onText?.(reply);
            return { text: reply, source: "local" };
          },
        },
        runRoutine: async () => "",
      };
    },
    ...overrides,
  };
  // Releases the sentence that is playing and lets every later sentence finish on its own.
  return { deps, events, shortcuts, finishPlayback: () => { released = true; playResolve?.(); playResolve = null; } };
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
    await waitFor(() => result.assistant.state === "speaking");
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
    await waitFor(() => assistant.state === "speaking");
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

test("PCM helpers round-trip WAV and measure loudness for the waveform", async () => {
  const { module, dispose } = await loadModule("audio.ts");
  try {
    const pcm = new Uint8Array(Buffer.from(new Int16Array([0, 16000, -16000, 0]).buffer));
    const wav = module.wavFromPcm(pcm, 16000);
    assert.equal(wav.length, 44 + pcm.length);
    assert.deepEqual(module.pcmFromWav(wav), { pcm, sampleRate: 16000 });
    assert.equal(module.pcmFromWav(new Uint8Array(10)), null);
    assert.equal(module.pcmLevel(new Uint8Array(0)), 0);
    assert.equal(module.pcmLevel(new Uint8Array(400)), 0);
    const loud = module.pcmLevel(new Uint8Array(Buffer.from(new Int16Array(200).fill(30000).buffer)));
    const quiet = module.pcmLevel(new Uint8Array(Buffer.from(new Int16Array(200).fill(300).buffer)));
    assert.ok(loud > 0.9 && loud <= 1, `loud=${loud}`);
    assert.ok(quiet > 0 && quiet < loud / 3, `quiet=${quiet}`);
    const envelope = module.pcmEnvelope(new Uint8Array(1000 * 2), 1000, 50);
    assert.equal(envelope.length, 20);
  } finally {
    await dispose();
  }
});

test("desktop controller streams states, levels and both sides of the conversation to the HUD", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    const hudEvents = [];
    const harness = desktopHarness({ hud: { update: (event) => hudEvents.push(event), dispose: () => hudEvents.push({ type: "disposed" }) } });
    const { assistant } = await module.startDesktopVoiceAssistant(harness.deps);
    await assistant.toggle();
    const turn = assistant.toggle();
    await waitFor(() => assistant.state === "speaking");
    await new Promise((resolve) => setTimeout(resolve, 120));
    harness.finishPlayback();
    await turn;

    const states = hudEvents.filter((event) => event.type === "state").map((event) => event.state);
    assert.deepEqual(states, ["listening", "thinking", "speaking", "idle"]);
    assert.deepEqual(hudEvents.filter((event) => event.type === "text"), [{ type: "text", speaker: "you", text: "que horas são?" }]);
    assert.deepEqual(hudEvents.filter((event) => event.type.startsWith("reply")), [
      { type: "reply-start" },
      { type: "reply-delta", text: " que horas são? 09:30" },
    ]);
    const spoken = hudEvents.filter((event) => event.type === "spoken").map((event) => event.words);
    assert.ok(spoken.length >= 2 && spoken.at(-1) === 1_000_000, `spoken=${spoken}`);
    const levels = hudEvents.filter((event) => event.type === "level").map((event) => event.level);
    assert.equal(levels[0], 0.5, "microphone level is forwarded");
    assert.ok(levels.length >= 2, "playback envelope is streamed while speaking");
    assert.ok(!harness.events.some((event) => event[0] === "notify"), "replies go to the HUD, not notifications");

    assistant.dispose();
    assert.deepEqual(hudEvents.at(-1), { type: "disposed" });
  } finally {
    await dispose();
  }
});

test("HUD window is click-through, created on demand and destroyed after going idle", async () => {
  const { module, dispose } = await loadModule("../electron-main/voice-assistant/hud-window.ts");
  try {
    const windows = [];
    class FakeWindow {
      constructor(options) {
        this.options = options; this.calls = []; this.scripts = []; this.destroyed = false;
        this.webContents = { executeJavaScript: async (code) => { this.scripts.push(code); } };
        windows.push(this);
      }
      async loadURL(url) { this.url = url; }
      showInactive() { this.calls.push("showInactive"); }
      hide() {}
      destroy() { this.destroyed = true; }
      isDestroyed() { return this.destroyed; }
      setPosition(x, y) { this.position = [x, y]; }
      setAlwaysOnTop(flag, level) { this.calls.push(`top:${level}`); }
      setVisibleOnAllWorkspaces() { this.calls.push("allSpaces"); }
      setIgnoreMouseEvents(ignore) { this.calls.push(`ignoreMouse:${ignore}`); }
    }
    const screen = { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) };
    const hud = new module.JarvisHudWindow({ BrowserWindow: FakeWindow, screen }, "pt-PT");

    hud.update({ type: "level", level: 0.4 });
    hud.update({ type: "state", state: "idle" });
    assert.equal(windows.length, 0, "no window until there is something to show");

    hud.update({ type: "state", state: "listening" });
    hud.update({ type: "level", level: 0.42 });
    hud.update({ type: "level", level: 2 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const [window] = windows;
    assert.equal(window.options.focusable, false);
    assert.equal(window.options.transparent, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.deepEqual(window.position, [500, 43]);
    assert.ok(window.calls.includes("ignoreMouse:true") && window.calls.includes("top:screen-saver") && window.calls.includes("showInactive"));
    assert.match(decodeURIComponent(window.url), /A ouvir…/);
    assert.ok(window.scripts.includes('window.hud && window.hud.update({"type":"state","state":"listening"})'));
    assert.ok(window.scripts.includes('window.hud && window.hud.update({"type":"levels","levels":[0.42,1]})'));

    hud.update({ type: "text", speaker: "jarvis", text: "</script><img src=x onerror=alert(1)>" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(window.scripts.at(-1).includes('"text":"</script><img src=x onerror=alert(1)>"'), "text is passed as JSON data");

    hud.update({ type: "state", state: "idle" });
    assert.equal(window.destroyed, false);
    hud.dispose();
    assert.equal(window.destroyed, true);
  } finally {
    await dispose();
  }
});

function sseBody(events, splitAt = 7) {
  const text = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Deliberately cut chunks mid-line and mid-UTF-8 sequence.
      for (let offset = 0; offset < bytes.length; offset += splitAt) controller.enqueue(bytes.slice(offset, offset + splitAt));
      controller.close();
    },
  });
}

test("Grok streaming parses SSE deltas and assembles tool calls split across chunks", async () => {
  const { module, dispose } = await loadModule("grok.ts");
  try {
    const deltas = [];
    const completion = await module.readChatCompletionStream(sseBody([
      { choices: [{ delta: { role: "assistant", content: "Já " } }] },
      { choices: [{ delta: { content: "está, ação!" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "open_", arguments: "{\"url\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "url", arguments: "\"https://x.ai\"}" } }] } }] },
      { choices: [], usage: { total_tokens: 3 } },
      "[DONE]",
    ]), (delta) => deltas.push(delta));
    assert.deepEqual(deltas, ["Já ", "está, ação!"]);
    assert.equal(completion.content, "Já está, ação!");
    assert.deepEqual(completion.toolCalls, [{ id: "call_9", type: "function", function: { name: "open_url", arguments: "{\"url\":\"https://x.ai\"}" } }]);

    let body;
    const client = new module.GrokClient({
      apiKey: "k", baseUrl: "https://api.x.ai/v1", model: "grok-4",
      fetch: async (_url, init) => { body = JSON.parse(init.body); return new Response(sseBody([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])); },
    });
    assert.equal((await client.stream([{ role: "user", content: "hi" }])).content, "ok");
    assert.equal(body.stream, true);
  } finally {
    await dispose();
  }
});

test("sentence chunker emits speakable sentences without splitting numbers or abbreviations", async () => {
  const { module, dispose } = await loadModule("speech-pipeline.ts");
  try {
    const chunker = new module.SentenceChunker();
    const out = [];
    for (const delta of ["São 9", ".30 da manhã. ", "Ok. O ", "tempo está ótimo hoje! Quer", " o resumo?", " Diga"]) out.push(...chunker.push(delta));
    // "9.30" is not a sentence end, and the too-short "Ok." joins the next sentence.
    assert.deepEqual(out, ["São 9.30 da manhã.", "Ok. O tempo está ótimo hoje!", "Quer o resumo?"]);
    assert.equal(chunker.flush(), "Diga");
    assert.equal(chunker.flush(), null);

    const long = new module.SentenceChunker();
    const first = long.push("Primeiro, vou verificar o calendário, depois os emails importantes, e por fim as notícias do dia de hoje");
    assert.equal(first.length, 1, "the first sentence is cut early at a comma");
    assert.ok(first[0].endsWith(","));

    const filter = new module.AudioTagFilter();
    assert.equal(filter.push("[la") + filter.push("ughs] Olá [si") + filter.push("ghs] tudo bem? [nota longa que não é uma etiqueta de áudio nenhuma]"), " Olá  tudo bem? [nota longa que não é uma etiqueta de áudio nenhuma]");
    assert.equal(filter.push("[aberta"), "");
    assert.equal(filter.flush(), "[aberta");
    assert.deepEqual(module.displayWords("[laughs] Olá,  mundo"), ["Olá,", "mundo"]);
  } finally {
    await dispose();
  }
});

test("speech pipeline plays sentences in order while synthesising ahead, and can be cancelled", async () => {
  const { module, dispose } = await loadModule("speech-pipeline.ts");
  try {
    const played = [];
    const started = [];
    let active = 0, peak = 0;
    const contexts = [];
    const pipeline = new module.SpeechPipeline({
      synthesize: async (text, context) => {
        contexts.push(context.previousText);
        active += 1; peak = Math.max(peak, active);
        // Later sentences finish synthesis first, playback must still be in order.
        await new Promise((resolve) => setTimeout(resolve, text.startsWith("Um") ? 40 : 5));
        active -= 1;
        return wavOf(100);
      },
      play: async (wav, onStart) => { onStart(); played.push(wav.length); await new Promise((resolve) => setTimeout(resolve, 5)); },
      onSentenceStart: (sentence) => started.push([sentence.index, sentence.text, sentence.words, sentence.durationMs]),
    });
    pipeline.push("Um primeiro bloco aqui. Dois segundo bloco ali. Três terceiro bloco");
    pipeline.push(" final.");
    await pipeline.end();
    assert.deepEqual(started.map(([index, text]) => [index, text]), [[0, "Um primeiro bloco aqui."], [1, "Dois segundo bloco ali."], [2, "Três terceiro bloco final."]]);
    assert.deepEqual(started.map((entry) => entry[2]), [4, 4, 4]);
    assert.equal(started[0][3], 200, "duration comes from the WAV header and sample count");
    assert.ok(peak <= 2, `peak concurrency ${peak}`);
    assert.deepEqual(contexts, ["", "Um primeiro bloco aqui.", "Um primeiro bloco aqui. Dois segundo bloco ali."]);

    const cancelled = new module.SpeechPipeline({ synthesize: async () => wavOf(10), play: async () => { throw new Error("must not play"); } });
    cancelled.push("Isto nunca deve tocar. Nem isto.");
    cancelled.cancel();
    await cancelled.end();

    const failing = new module.SpeechPipeline({ synthesize: async () => { throw new Error("tts down"); }, play: async () => {} });
    failing.push("Uma frase completa aqui.");
    await assert.rejects(failing.end(), /tts down/);
  } finally {
    await dispose();
  }
});

test("assistant streams Grok deltas, including text spoken before a tool call", async () => {
  const { module, dispose } = await loadModule("assistant.ts");
  try {
    const rounds = [
      { deltas: ["Vou abrir. "], completion: { content: "Vou abrir. ", toolCalls: [{ id: "c1", type: "function", function: { name: "get_time", arguments: "" } }] } },
      { deltas: ["São ", "9h30."], completion: { content: "São 9h30.", toolCalls: [] } },
    ];
    const grok = {
      complete: async () => { throw new Error("streaming client must be used"); },
      stream: async (_messages, _tools, options) => {
        const round = rounds.shift();
        for (const delta of round.deltas) options.onText(delta);
        return round.completion;
      },
    };
    const { context } = actionContext();
    const assistant = new module.VoiceAssistant({ grok, profile: { persona: "", capabilities: "", routines: [] }, actions: context, language: "pt", historyLimit: 20 });
    const deltas = [];
    const reply = await assistant.handle("diz-me uma coisa e as horas", { onText: (delta) => deltas.push(delta) });
    assert.deepEqual(deltas, ["Vou abrir. ", "São ", "9h30."]);
    assert.deepEqual(reply, { text: "Vou abrir. São 9h30.", source: "grok" });
    assert.equal(assistant.history.at(-1).content, "Vou abrir. São 9h30.");

    const local = [];
    await assistant.handle("abre o Safari", { onText: (delta) => local.push(delta) });
    assert.deepEqual(local, ["Opened Safari."]);
  } finally {
    await dispose();
  }
});

test("desktop controller starts speaking before Grok finishes and aborts the stream on interrupt", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    let finishGrok;
    let aborted = false;
    const harness = desktopHarness({
      createRuntime: async () => ({
        profile: { persona: "", capabilities: "", routines: [] },
        voice: { transcribe: async () => "conta-me tudo", synthesize: async () => wavOf(400) },
        runRoutine: async () => "",
        assistant: {
          handle: (_text, options) => new Promise((resolve, reject) => {
            options.onText("Primeira frase completa. ");
            options.onText("Segunda ainda a");
            options.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
            finishGrok = () => { options.onText(" chegar."); resolve({ text: "", source: "grok" }); };
          }),
        },
      }),
    });
    const { assistant } = await module.startDesktopVoiceAssistant(harness.deps);
    await assistant.toggle();
    void assistant.toggle();
    await waitFor(() => assistant.state === "speaking");
    assert.ok(finishGrok, "Grok is still streaming while the first sentence plays");

    await assistant.toggle();
    assert.equal(aborted, true, "the Grok request is aborted");
    assert.equal(assistant.state, "listening");
    assert.ok(!harness.events.some((event) => event[0] === "failure"), "an interrupt is not reported as a failure");
    assistant.dispose();
  } finally {
    await dispose();
  }
});

test("an interrupt during transcription never reaches Grok", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    let releaseTranscript;
    let handled = 0;
    const harness = desktopHarness({
      createRuntime: async () => ({
        profile: { persona: "", capabilities: "", routines: [] },
        voice: { transcribe: () => new Promise((resolve) => { releaseTranscript = () => resolve("abre o Spotify"); }), synthesize: async () => wavOf(10) },
        runRoutine: async () => "",
        assistant: { handle: async () => { handled += 1; return { text: "", source: "local" }; } },
      }),
    });
    const { assistant } = await module.startDesktopVoiceAssistant(harness.deps);
    await assistant.toggle();
    const first = assistant.toggle();
    await waitFor(() => releaseTranscript !== undefined);
    await assistant.toggle();
    releaseTranscript();
    await first;
    assert.equal(handled, 0);
    assert.equal(assistant.state, "listening");
    assistant.dispose();
  } finally {
    await dispose();
  }
});

function alignmentFor(text, startsByWord, includeTags = true) {
  // One entry per character; every character of a word shares a time just after the word's start.
  const characters = [];
  const starts = [];
  let word = -1;
  let inWord = false;
  const source = includeTags ? text : text.replace(/\[[^\]\n]{1,30}\]/g, "");
  let inTag = false;
  for (const character of source) {
    if (character === "[") inTag = true;
    const separator = inTag || /\s/.test(character);
    if (!separator && !inWord) word += 1;
    inWord = !separator;
    characters.push(character);
    starts.push(separator ? 0 : (startsByWord[word] ?? 0) / 1000 + 0.001 * (characters.length % 3));
    if (character === "]") inTag = false;
  }
  return { characters, characterStartTimesSeconds: starts };
}

test("ElevenLabs with-timestamps returns WAV audio and character alignment", async () => {
  const { module, dispose } = await loadModule("elevenlabs.ts");
  try {
    const seen = [];
    const client = new module.ElevenLabsClient({
      apiKey: "k", baseUrl: "https://api.elevenlabs.io/v1", voiceId: "v", ttsModel: "eleven_v3", sttModel: "scribe_v1", language: "pt",
      fetch: async (url, init) => {
        seen.push({ url, body: JSON.parse(init.body) });
        if (url.includes("broken")) return new Response("nope", { status: 404 });
        return Response.json({
          audio_base64: Buffer.from([7, 8, 9, 10]).toString("base64"),
          alignment: { characters: ["O", "l", "á"], character_start_times_seconds: [0, 0.05, 0.1], character_end_times_seconds: [0.05, 0.1, 0.2] },
        });
      },
    });
    const speech = await client.synthesizeWithTimestamps("Olá");
    assert.equal(seen[0].url, "https://api.elevenlabs.io/v1/text-to-speech/v/with-timestamps?output_format=pcm_22050");
    assert.deepEqual(seen[0].body, { text: "Olá", model_id: "eleven_v3" });
    assert.deepEqual([...speech.wav.subarray(44)], [7, 8, 9, 10]);
    assert.deepEqual(speech.alignment, { characters: ["O", "l", "á"], characterStartTimesSeconds: [0, 0.05, 0.1] });

    const broken = new module.ElevenLabsClient({ apiKey: "k", baseUrl: "https://broken", voiceId: "v", ttsModel: "m", sttModel: "s", language: "pt", fetch: async () => new Response("nope", { status: 404 }) });
    await assert.rejects(broken.synthesizeWithTimestamps("x"), (error) => error.status === 404);
  } finally {
    await dispose();
  }
});

test("character alignment maps to visible word start times, with or without audio tags", async () => {
  const { module, dispose } = await loadModule("speech-pipeline.ts");
  try {
    const text = "[laughs] Olá, Tony.  Tudo[sighs]bem?";
    const words = module.displayWords(text);
    assert.deepEqual(words, ["Olá,", "Tony.", "Tudo", "bem?"]);
    const starts = [120, 480, 900, 1300];
    const round = (values) => values?.map((value) => Math.round(value / 10) * 10);
    assert.deepEqual(round(module.alignWordStarts(text, alignmentFor(text, starts))), starts);
    // An alignment that leaves tags out still lines up when the tags sat between spaces…
    const spaced = "[laughs] Olá, Tony. [sighs] Tudo bem?";
    assert.deepEqual(round(module.alignWordStarts(spaced, alignmentFor(spaced, starts, false))), starts);
    // …but "Tudo[sighs]bem" would collapse into one word there, so it falls back instead of guessing.
    assert.equal(module.alignWordStarts(text, alignmentFor(text, starts, false)), null);
    assert.equal(module.alignWordStarts(text, null), null);
    assert.equal(module.alignWordStarts(text, { characters: ["O", "l", "á"], characterStartTimesSeconds: [0, 0.1, 0.2] }), null, "a word-count mismatch falls back");
    assert.equal(module.alignWordStarts(text, { characters: [], characterStartTimesSeconds: [] }), null);
  } finally {
    await dispose();
  }
});

test("HUD highlights each word at its aligned start time and falls back when timestamps are refused", async () => {
  const { module, dispose } = await loadModule("desktop-controller.ts");
  try {
    const sentence = "Um dois três quatro.";
    const timings = [0, 120, 260, 420];
    const run = async (synthesizeWithTimestamps, expectSpeech = true) => {
      const hudEvents = [];
      const plain = [];
      const harness = desktopHarness({
        hud: { update: (event) => hudEvents.push({ ...event, at: Date.now() }), dispose: () => {} },
        createRuntime: async () => ({
          profile: { persona: "", capabilities: "", routines: [] },
          runRoutine: async () => "",
          voice: {
            transcribe: async () => "conta",
            synthesize: async (text) => { plain.push(text); return wavOf(600); },
            synthesizeWithTimestamps,
          },
          assistant: { handle: async (_text, options) => { options.onText(sentence); return { text: sentence, source: "grok" }; } },
        }),
      });
      const { assistant } = await module.startDesktopVoiceAssistant(harness.deps);
      await assistant.toggle();
      const turn = assistant.toggle();
      if (expectSpeech) {
        await waitFor(() => assistant.state === "speaking");
        await new Promise((resolve) => setTimeout(resolve, 520));
        harness.finishPlayback();
      }
      await turn;
      const finalState = assistant.state;
      assistant.dispose();
      return { hudEvents, plain, finalState, failures: harness.events.filter((event) => event[0] === "failure") };
    };

    const exact = await run(async (text) => ({ wav: wavOf(600), alignment: alignmentFor(text, timings) }));
    const spoken = exact.hudEvents.filter((event) => event.type === "spoken" && event.words > 0 && event.words < 1_000_000);
    assert.deepEqual(spoken.map((event) => event.words), [1, 2, 3, 4]);
    const playbackStart = exact.hudEvents.find((event) => event.type === "state" && event.state === "speaking").at;
    const offsets = spoken.map((event) => event.at - playbackStart);
    timings.forEach((timing, index) => {
      assert.ok(offsets[index] >= timing - 3 && offsets[index] <= timing + 30, `word ${index + 1} at ${offsets[index]}ms, expected ~${timing}ms`);
    });
    assert.deepEqual(exact.plain, [], "aligned synthesis replaces the plain request");

    let timestampCalls = 0;
    const refused = await run(async () => {
      timestampCalls += 1;
      throw Object.assign(new Error("timestamps not available"), { status: 403 });
    });
    assert.equal(timestampCalls, 1);
    assert.deepEqual(refused.plain, [sentence], "falls back to plain synthesis");
    assert.equal(refused.failures.length, 1);
    assert.equal(refused.failures[0][1], "word-timestamps");
    assert.ok(refused.hudEvents.some((event) => event.type === "spoken" && event.words === 4), "even spreading still highlights every word");

    const outage = await run(async () => { throw Object.assign(new Error("server down"), { status: 503 }); }, false);
    assert.deepEqual(outage.plain, [], "server errors are not mistaken for an unsupported endpoint");
    assert.equal(outage.failures[0][1], "turn");
    assert.equal(outage.finalState, "idle");
  } finally {
    await dispose();
  }
});

test("memory store persists facts atomically and privately, dedupes, evicts and refuses secrets", async () => {
  const { module, temporary, dispose } = await loadModule("memory.ts");
  try {
    let clock = Date.parse("2026-10-23T08:00:00Z");
    const now = () => new Date(clock);
    const file = path.join(temporary, "profile", "memory.json");
    const store = await module.MemoryStore.open(file, { now, maxFacts: 3 });
    assert.deepEqual(store.facts, []);

    assert.equal((await store.remember("O utilizador chama-se Malaki.")).fact.id, "m1");
    clock += 1000;
    const duplicate = await store.remember("  o utilizador   chama-se malaki ");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.fact.id, "m1");
    clock += 1000;
    await store.remember("Prefere café sem açúcar");
    clock += 1000;
    await store.remember("A irmã chama-se Ana");
    clock += 1000;
    await store.remember("Trabalha em Lisboa");
    assert.deepEqual(store.facts.map((fact) => fact.id), ["m2", "m3", "m4"], "with maxFacts 3, the oldest untouched fact (m1) is evicted");

    await assert.rejects(store.remember("A minha password do banco é hunter2"), /password/);
    await assert.rejects(store.remember("Cartão 4111 1111 1111 1111"), /card number/);
    await assert.rejects(store.remember("x".repeat(301)), /at most 300/);
    assert.equal(store.facts.length, 3);
    assert.equal(module.looksSecret("O código postal é 1000-001"), false);

    const stat = await (await import("node:fs/promises")).stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual((await (await import("node:fs/promises")).readdir(path.dirname(file))).sort(), ["memory.json"], "no temp files left behind");

    const reopened = await module.MemoryStore.open(file, { now });
    assert.deepEqual(reopened.facts.map((fact) => fact.text), ["Prefere café sem açúcar", "A irmã chama-se Ana", "Trabalha em Lisboa"]);
    clock += 1000;
    assert.equal((await reopened.remember("Gosta de jazz")).fact.id, "m5", "ids keep increasing after a restart");
    assert.equal((await reopened.forget("[m3]")).text, "A irmã chama-se Ana");
    assert.equal(await reopened.forget("m99"), null);
    assert.match(reopened.promptBlock(), /^\[m5\] Gosta de jazz\n/);
    assert.equal(reopened.promptBlock(25), "[m5] Gosta de jazz");
  } finally {
    await dispose();
  }
});

test("memory store restores only a recent conversation and keeps unreadable files aside", async () => {
  const { module, temporary, dispose } = await loadModule("memory.ts");
  try {
    let clock = Date.parse("2026-10-23T08:00:00Z");
    const file = path.join(temporary, "memory.json");
    const store = await module.MemoryStore.open(file, { now: () => new Date(clock) });
    await store.saveConversation([
      { role: "assistant", content: "orphan" },
      { role: "user", content: "Olá" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "1", content: "x" },
      { role: "assistant", content: "Olá, Malaki." },
    ]);
    clock += 2 * 3_600_000;
    const later = await module.MemoryStore.open(file, { now: () => new Date(clock) });
    assert.deepEqual(later.restoreConversation(12 * 3_600_000), [{ role: "user", content: "Olá" }, { role: "assistant", content: "Olá, Malaki." }]);
    assert.deepEqual(later.restoreConversation(3_600_000), [], "older than the TTL starts fresh");
    assert.deepEqual(later.restoreConversation(0), []);
    await later.forgetAll();
    assert.deepEqual((await module.MemoryStore.open(file)).restoreConversation(1e12), []);

    const { writeFile, readdir } = await import("node:fs/promises");
    await writeFile(file, "{ not json");
    const backups = [];
    const recovered = await module.MemoryStore.open(file, { onCorruptFile: (backup) => backups.push(backup) });
    assert.deepEqual(recovered.facts, []);
    assert.equal(backups.length, 1);
    assert.ok((await readdir(temporary)).some((name) => name.startsWith("memory.json.corrupt-")), "the unreadable file is kept");
  } finally {
    await dispose();
  }
});

test("intent router stores explicit facts locally but sends reminders and secrets to Grok", async () => {
  const { module, dispose } = await loadModule("intent-router.ts");
  try {
    assert.deepEqual(module.routeIntent("Lembra-te que o meu nome é Malaki."), { kind: "remember", fact: "o meu nome é Malaki" });
    assert.deepEqual(module.routeIntent("remember that I take my coffee black"), { kind: "remember", fact: "I take my coffee black" });
    assert.deepEqual(module.routeIntent("lembra-te de comprar leite amanhã"), { kind: "llm" });
    assert.deepEqual(module.routeIntent("lembra-te que a minha senha é 1234"), { kind: "llm" });
  } finally {
    await dispose();
  }
});

test("assistant uses memory across a restart: prompt facts, remember/forget tools and restored conversation", async () => {
  const assistantModule = await loadModule("assistant.ts");
  const memoryModule = await loadModule("memory.ts");
  try {
    const file = path.join(memoryModule.temporary, "memory.json");
    const { context } = actionContext();
    const profile = { persona: "You are Jarvis.", capabilities: "", routines: [] };
    const requests = [];
    const replies = [];
    const grok = { async complete(messages, tools) { requests.push({ messages: structuredClone(messages), tools: tools.map((tool) => tool.function.name) }); return replies.shift(); } };

    const memory = await memoryModule.module.MemoryStore.open(file);
    const first = new assistantModule.module.VoiceAssistant({ grok, profile, actions: context, language: "pt", historyLimit: 20, memory, rememberedReply: "Fica registado." });
    assert.deepEqual(await first.handle("Lembra-te que o meu nome é Malaki"), { text: "Fica registado.", source: "local" });
    assert.equal(requests.length, 0);

    replies.push(
      { content: null, toolCalls: [{ id: "t1", type: "function", function: { name: "remember", arguments: "{\"fact\":\"O utilizador vive no Porto\"}" } }] },
      { content: "Anotado, o Porto é lindo.", toolCalls: [] },
    );
    await first.handle("Mudei-me para o Porto");
    assert.ok(requests[0].tools.includes("remember") && requests[0].tools.includes("forget"));
    assert.match(requests[0].messages[0].content, /\[m1\] o meu nome é Malaki/);
    assert.deepEqual(requests[1].messages.at(-1), { role: "tool", tool_call_id: "t1", content: "Saved as [m2]." });

    // Restart: new store and assistant from the same file.
    const memoryAfterRestart = await memoryModule.module.MemoryStore.open(file);
    const second = new assistantModule.module.VoiceAssistant({
      grok, profile, actions: context, language: "pt", historyLimit: 20,
      memory: memoryAfterRestart, initialHistory: memoryAfterRestart.restoreConversation(3_600_000),
    });
    replies.push(
      { content: null, toolCalls: [{ id: "t2", type: "function", function: { name: "forget", arguments: "{\"id\":\"m2\"}" } }] },
      { content: "Esquecido.", toolCalls: [] },
    );
    await second.handle("Esquece onde eu moro");
    const afterRestart = requests[2].messages;
    assert.match(afterRestart[0].content, /\[m2\] O utilizador vive no Porto/);
    assert.deepEqual(afterRestart.slice(1, 3).map((message) => message.content), ["Mudei-me para o Porto", "Anotado, o Porto é lindo."], "the previous conversation is restored");
    assert.deepEqual(memoryAfterRestart.facts.map((fact) => fact.id), ["m1"]);
  } finally {
    await assistantModule.dispose();
    await memoryModule.dispose();
  }
});
