import readline from "node:readline";

import { AudioPlayer, startRecording, type Recording } from "./audio.js";
import { loadVoiceAssistantConfig, VoiceAssistantConfigError } from "./config.js";
import { createVoiceAssistantRuntime } from "./runtime.js";
import { RoutineScheduler } from "./scheduler.js";
import { AudioTagFilter, SpeechPipeline } from "./speech-pipeline.js";

const HELP = `Press Enter to start talking and Enter again to stop, or type a message.
Commands: /mute  /routines  /run <routine>  /memory  /forget <id|all>
          /google connect|status|disconnect  /help  /quit`;

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

  const runtime = await createVoiceAssistantRuntime(config, {
    onMemoryError: (error) => console.error(`Memory: ${errorMessage(error)}`),
    onNotice: (message) => console.log(`\n${message}`),
  });
  const { assistant, voice, profile } = runtime;
  if (runtime.createdProfile) console.log(`Created ${config.profilePath}`);
  const memory = runtime.memory;
  const player = new AudioPlayer();
  let muted = process.argv.includes("--mute") || !player.available;
  if (!player.available) console.log("No audio player found; replies will be text only.");

  let speech: SpeechPipeline | null = null;
  const stopSpeaking = () => {
    speech?.cancel();
    speech = null;
    player.stop();
  };

  /** Prints the reply as it streams and speaks it sentence by sentence; playback never blocks input. */
  const streamReply = async (produce: (onText: (delta: string) => void) => Promise<string | null>) => {
    stopSpeaking();
    const pipe = muted
      ? null
      : new SpeechPipeline({
        synthesize: (text, context) => voice.synthesize(text, { previousText: context.previousText }),
        play: (wav, onStart) => player.play(wav, onStart),
      });
    speech = pipe;
    const filter = new AudioTagFilter();
    let started = false;
    const write = (delta: string) => {
      const visible = started ? delta : delta.trimStart();
      if (!visible) return;
      if (!started) {
        started = true;
        process.stdout.write("\nJarvis: ");
      }
      process.stdout.write(visible);
    };
    let text: string | null;
    try {
      text = await produce((delta) => {
        pipe?.push(delta);
        write(filter.push(delta));
      });
    } finally {
      write(filter.flush());
      if (started) process.stdout.write("\n\n");
    }
    if (text === null) return stopSpeaking();
    void pipe?.end().catch((error) => console.error(`Voice error: ${errorMessage(error)}`));
  };

  const respond = async (transcript: string) => {
    try {
      await streamReply(async (onText) => {
        const reply = await assistant.handle(transcript, { onText });
        return reply.source === "stop" ? null : reply.text;
      });
    } catch (error) {
      console.error(`Error: ${errorMessage(error)}`);
    }
  };

  const runRoutine = async (name: string, logFile: string) => {
    const report = await runtime.runRoutine({ name, logFile });
    await streamReply(async (onText) => {
      onText(report);
      return report;
    });
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
      stopSpeaking();
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
      if (muted) stopSpeaking();
      console.log(muted ? "Voice off." : "Voice on.");
    } else if (text === "/routines") {
      console.log(profile.routines.map((routine) => `${routine.time}  ${routine.name} → ${routine.logFile}`).join("\n") || "No routines configured.");
    } else if (text === "/memory") {
      if (!memory) console.log("Memory is off (JARVIS_MEMORY=off).");
      else console.log(memory.facts.map((fact) => `[${fact.id}] ${fact.text}`).join("\n") || `Nothing remembered yet. (${memory.path})`);
    } else if (text.startsWith("/forget ")) {
      const target = text.slice(8).trim();
      if (!memory) console.log("Memory is off.");
      else if (target === "all") {
        await memory.forgetAll();
        console.log("Forgot everything, including the saved conversation.");
      } else {
        const removed = await memory.forget(target);
        console.log(removed ? `Forgot: ${removed.text}` : `No memory ${target}. Use /memory to list ids.`);
      }
    } else if (text.startsWith("/google")) {
      const google = runtime.google;
      const command = text.slice(7).trim() || "status";
      if (!google) console.log("Google Calendar is not configured. Set GOOGLE_CLIENT_ID (and GOOGLE_CLIENT_SECRET) from a Desktop OAuth client.");
      else if (command === "connect") {
        console.log("Opening your browser for Google sign-in…");
        await google.connect().then(
          () => console.log("Google Calendar connected."),
          (error) => console.error(`Google sign-in failed: ${errorMessage(error)}`),
        );
      } else if (command === "disconnect") {
        await google.disconnect();
        console.log("Google Calendar disconnected and access revoked.");
      } else {
        console.log((await google.isConnected()) ? "Google Calendar: connected." : "Google Calendar: not connected. Use /google connect.");
      }
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
    stopSpeaking();
    process.exit(0);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
