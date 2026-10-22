import { stripAudioTags } from "./assistant.js";
import { AudioPlayer, startRecording as startSystemRecording, type Recording } from "./audio.js";
import { loadVoiceAssistantConfig, type VoiceAssistantConfig } from "./config.js";
import { createVoiceAssistantRuntime, type VoiceAssistantRuntime } from "./runtime.js";
import { RoutineScheduler } from "./scheduler.js";

// Global push-to-talk for the desktop app. Electron's globalShortcut only
// reports key-down, so the shortcut toggles: press to listen, press again to
// send. Pressing while Jarvis speaks interrupts it and starts listening.

export const DEFAULT_VOICE_SHORTCUT = "Alt+Space";
export const VOICE_SECRET_KEYS = ["XAI_API_KEY", "ELEVENLABS_API_KEY"] as const;
const MIN_SPEECH_BYTES = 8_000; // ~0.25 s of 16 kHz mono PCM

export type DesktopVoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface DesktopVoiceShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface DesktopVoiceDeps {
  readonly shortcut: DesktopVoiceShortcutPort;
  readonly notify: (title: string, body: string) => void;
  readonly readSecret: (key: string) => Promise<string | null>;
  readonly requestMicrophoneAccess: () => Promise<boolean>;
  readonly reportFailure: (leg: string, error: unknown) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly cue?: (kind: "start" | "stop") => void;
  readonly onStateChange?: (state: DesktopVoiceState) => void;
  readonly createRuntime?: (config: VoiceAssistantConfig) => Promise<Pick<VoiceAssistantRuntime, "assistant" | "voice" | "profile" | "runRoutine">>;
  readonly startRecording?: () => Promise<Recording>;
  readonly player?: { play(mp3: Uint8Array): Promise<void>; stop(): void };
  readonly maxRecordingMs?: number;
}

export interface DesktopVoiceAssistant {
  readonly accelerator: string;
  readonly state: DesktopVoiceState;
  toggle(): Promise<void>;
  dispose(): void;
}

export type DesktopVoiceStartResult =
  | { readonly status: "started"; readonly assistant: DesktopVoiceAssistant }
  | { readonly status: "disabled" | "missing-keys" | "shortcut-unavailable"; readonly detail: string };

/** Resolves API keys from the environment first, then the app's encrypted secrets. */
export async function resolveVoiceEnv(env: NodeJS.ProcessEnv, readSecret: (key: string) => Promise<string | null>): Promise<NodeJS.ProcessEnv> {
  const resolved: NodeJS.ProcessEnv = { ...env };
  for (const key of VOICE_SECRET_KEYS) {
    if (resolved[key]?.trim()) continue;
    const secret = await readSecret(key).catch(() => null);
    if (secret?.trim()) resolved[key] = secret.trim();
  }
  return resolved;
}

export async function startDesktopVoiceAssistant(deps: DesktopVoiceDeps): Promise<DesktopVoiceStartResult> {
  const env = deps.env ?? process.env;
  const accelerator = env.JARVIS_SHORTCUT?.trim() || DEFAULT_VOICE_SHORTCUT;
  if (accelerator.toLowerCase() === "off") return { status: "disabled", detail: "JARVIS_SHORTCUT=off" };

  const voiceEnv = await resolveVoiceEnv(env, deps.readSecret);
  const missing = VOICE_SECRET_KEYS.filter((key) => !voiceEnv[key]?.trim());
  if (missing.length > 0) return { status: "missing-keys", detail: `Add ${missing.join(" and ")} as secrets to enable the voice assistant.` };

  const runtime = await (deps.createRuntime ?? createVoiceAssistantRuntime)(loadVoiceAssistantConfig(voiceEnv));
  const record = deps.startRecording ?? startSystemRecording;
  const player = deps.player ?? new AudioPlayer();
  const maxRecordingMs = deps.maxRecordingMs ?? 30_000;

  let state: DesktopVoiceState = "idle";
  let recording: Recording | null = null;
  let recordingTimer: NodeJS.Timeout | null = null;
  let microphoneGranted = false;
  let disposed = false;
  // Bumped whenever a new interaction starts, so a stale reply never resets a newer state.
  let generation = 0;

  const setState = (next: DesktopVoiceState) => {
    state = next;
    deps.onStateChange?.(next);
  };
  const fail = (leg: string, error: unknown) => {
    deps.reportFailure(leg, error);
    deps.notify("Jarvis", error instanceof Error ? error.message : String(error));
    setState("idle");
  };

  const speak = async (text: string, turn: number) => {
    if (!text) return;
    deps.notify("Jarvis", stripAudioTags(text));
    const audio = await runtime.voice.synthesize(text);
    if (turn !== generation || disposed) return;
    setState("speaking");
    await player.play(audio);
    if (turn === generation && state === "speaking") setState("idle");
  };

  const startListening = async () => {
    player.stop();
    const turn = ++generation;
    if (!microphoneGranted) {
      microphoneGranted = await deps.requestMicrophoneAccess();
      if (!microphoneGranted) {
        deps.notify("Jarvis", "Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.");
        return;
      }
    }
    recording = await record();
    if (turn !== generation || disposed) {
      void recording.stop().catch(() => undefined);
      recording = null;
      return;
    }
    setState("listening");
    deps.cue?.("start");
    recordingTimer = setTimeout(() => void finishListening(), maxRecordingMs);
  };

  const finishListening = async () => {
    if (state !== "listening" || !recording) return;
    if (recordingTimer) clearTimeout(recordingTimer);
    recordingTimer = null;
    const current = recording;
    recording = null;
    const turn = generation;
    setState("thinking");
    deps.cue?.("stop");
    try {
      const audio = await current.stop();
      if (audio.length < MIN_SPEECH_BYTES) return setState("idle");
      const transcript = await runtime.voice.transcribe(audio);
      if (!transcript) return setState("idle");
      const reply = await runtime.assistant.handle(transcript);
      if (turn !== generation) return;
      setState("idle");
      if (reply.source !== "stop") await speak(reply.text, turn);
    } catch (error) {
      if (turn === generation) fail("turn", error);
    }
  };

  const assistant: DesktopVoiceAssistant = {
    accelerator,
    get state() {
      return state;
    },
    async toggle() {
      if (disposed) return;
      try {
        if (state === "listening") await finishListening();
        else if (state === "idle" || state === "speaking") await startListening();
        // While thinking, presses are ignored rather than queued.
      } catch (error) {
        fail("toggle", error);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      scheduler.stop();
      deps.shortcut.unregister(accelerator);
      if (recordingTimer) clearTimeout(recordingTimer);
      void recording?.stop().catch(() => undefined);
      recording = null;
      player.stop();
    },
  };

  if (!deps.shortcut.register(accelerator, () => void assistant.toggle())) {
    return { status: "shortcut-unavailable", detail: `${accelerator} is already used by another application. Set JARVIS_SHORTCUT to another accelerator.` };
  }

  const scheduler = new RoutineScheduler({
    routines: runtime.profile.routines,
    run: async (routine) => {
      const report = await runtime.runRoutine(routine);
      if (state === "idle") await speak(report, generation);
      else deps.notify(`Jarvis · ${routine.name}`, stripAudioTags(report));
    },
    onError: (routine, error) => deps.reportFailure(`routine:${routine.name}`, error),
  });
  scheduler.start();

  return { status: "started", assistant };
}
