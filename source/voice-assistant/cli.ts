import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { runCommand } from "./actions.js";
import { stripAudioTags, VoiceAssistant } from "./assistant.js";
import { AudioPlayer, startRecording, type Recording } from "./audio.js";
import { loadVoiceAssistantConfig, VoiceAssistantConfigError } from "./config.js";
import { ElevenLabsClient } from "./elevenlabs.js";
import { GrokClient } from "./grok.js";
import { DEFAULT_ASSISTANT_PROFILE, parseAssistantProfile } from "./profile.js";
import { RoutineScheduler } from "./scheduler.js";

const HELP = `Press Enter to start talking and Enter again to stop, or type a message.
Commands: /mute  /routines  /run <routine>  /help  /quit`;

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadVoiceAssistantConfig();
    } catch (error) {
      if (error instanceof VoiceAssistantConfigError) {
        console.error(`${error.message}\nSee source/voice-assistant/README.md for setup.`);
        return null;
      }
      throw error;
    }
  })();
  if (!config) {
    process.exitCode = 1;
    return;
  }

  const profileDirectory = path.dirname(config.profilePath);
  await mkdir(profileDirectory, { recursive: true });
  const profileMarkdown = await readFile(config.profilePath, "utf8").catch(async () => {
    await writeFile(config.profilePath, DEFAULT_ASSISTANT_PROFILE);
    console.log(`Created ${config.profilePath}`);
    return DEFAULT_ASSISTANT_PROFILE;
  });
  const profile = parseAssistantProfile(profileMarkdown);

  const grok = new GrokClient({ apiKey: config.xaiApiKey, baseUrl: config.xaiBaseUrl, model: config.grokModel });
  const voice = new ElevenLabsClient({
    apiKey: config.elevenLabsApiKey,
    baseUrl: config.elevenLabsBaseUrl,
    voiceId: config.elevenLabsVoiceId,
    ttsModel: config.elevenLabsTtsModel,
    sttModel: config.elevenLabsSttModel,
    language: config.language,
  });
  const assistant = new VoiceAssistant({
    grok,
    profile,
    language: config.language,
    historyLimit: config.historyLimit,
    actions: {
      platform: process.platform,
      run: runCommand,
      notesPath: path.join(profileDirectory, "notes.md"),
      now: () => new Date(),
      locale: config.language,
    },
  });
  const player = new AudioPlayer();
  let muted = process.argv.includes("--mute") || !player.available;
  if (!player.available) console.log("No audio player found; replies will be text only.");

  const speak = async (text: string) => {
    const display = stripAudioTags(text);
    if (display) console.log(`\nJarvis: ${display}\n`);
    if (muted || !text) return;
    try {
      await player.play(await voice.synthesize(text));
    } catch (error) {
      console.error(`Voice error: ${errorMessage(error)}`);
    }
  };

  const respond = async (transcript: string) => {
    try {
      const reply = await assistant.handle(transcript);
      if (reply.source === "stop") player.stop();
      else void speak(reply.text);
    } catch (error) {
      console.error(`Error: ${errorMessage(error)}`);
    }
  };

  const runRoutine = async (name: string, logFile: string) => {
    const report = await assistant.runRoutine(name);
    await appendFile(path.join(profileDirectory, logFile), `\n## ${new Date().toISOString()} — ${name}\n\n${stripAudioTags(report)}\n`);
    void speak(report);
  };

  const scheduler = new RoutineScheduler({
    routines: profile.routines,
    run: (routine) => runRoutine(routine.name, routine.logFile),
    onError: (routine, error) => console.error(`Routine "${routine.name}" failed: ${errorMessage(error)}`),
  });
  scheduler.start();

  console.log(`Jarvis ready · Grok ${config.grokModel} · ElevenLabs ${config.elevenLabsTtsModel} · ${profile.routines.length} routine(s)\n${HELP}`);

  const input = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let recording: Recording | null = null;
  // Lines are handled one at a time so a typed /quit cannot overtake a pending reply.
  let queue = Promise.resolve();
  let closing = false;
  const handleLine = async (line: string) => {
    const text = line.trim();
    if (recording) {
      const current = recording;
      recording = null;
      try {
        const transcript = await voice.transcribe(await current.stop());
        console.log(`You: ${transcript || "(nothing heard)"}`);
        if (transcript) await respond(transcript);
      } catch (error) {
        console.error(`Transcription error: ${errorMessage(error)}`);
      }
    } else if (!text) {
      player.stop();
      try {
        recording = await startRecording();
        console.log("Listening… press Enter to stop.");
        return;
      } catch (error) {
        console.error(errorMessage(error));
      }
    } else if (text === "/quit" || text === "/exit") {
      input.close();
      return;
    } else if (text === "/help") {
      console.log(HELP);
    } else if (text === "/mute") {
      muted = !muted;
      if (muted) player.stop();
      console.log(muted ? "Voice off." : "Voice on.");
    } else if (text === "/routines") {
      console.log(profile.routines.map((routine) => `${routine.time}  ${routine.name} → ${routine.logFile}`).join("\n") || "No routines configured.");
    } else if (text.startsWith("/run ")) {
      const name = text.slice(5).trim();
      const routine = profile.routines.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
      await runRoutine(routine?.name ?? name, routine?.logFile ?? "log.md").catch((error) => console.error(`Error: ${errorMessage(error)}`));
    } else {
      await respond(text);
    }
    if (!closing) input.prompt();
  };
  input.prompt();
  input.on("line", (line) => {
    queue = queue.then(() => handleLine(line));
  });
  input.on("close", async () => {
    closing = true;
    await queue;
    scheduler.stop();
    player.stop();
    process.exit(0);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
