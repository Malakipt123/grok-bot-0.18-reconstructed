import readline from "node:readline";

import { stripAudioTags } from "./assistant.js";
import { AudioPlayer, startRecording, type Recording } from "./audio.js";
import { loadVoiceAssistantConfig, VoiceAssistantConfigError } from "./config.js";
import { createVoiceAssistantRuntime } from "./runtime.js";
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

  const runtime = await createVoiceAssistantRuntime(config);
  const { assistant, voice, profile } = runtime;
  if (runtime.createdProfile) console.log(`Created ${config.profilePath}`);
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
    void speak(await runtime.runRoutine({ name, logFile }));
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
