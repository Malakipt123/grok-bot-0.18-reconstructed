import { stripAudioTags } from "./assistant.js";
import { AudioPlayer, pcmEnvelope, pcmFromWav, startRecording as startSystemRecording, type Recording, type RecordingOptions } from "./audio.js";
import { AudioTagFilter, SpeechPipeline, type SpokenSentence, type SynthesizedSpeech } from "./speech-pipeline.js";
import { loadVoiceAssistantConfig, type VoiceAssistantConfig } from "./config.js";
import { createVoiceAssistantRuntime, type VoiceAssistantRuntime } from "./runtime.js";
import { RoutineScheduler } from "./scheduler.js";

// Global push-to-talk for the desktop app. Electron's globalShortcut only
// reports key-down, so the shortcut toggles: press to listen, press again to
// send. Pressing while Jarvis thinks or speaks interrupts it and starts listening.
//
// Replies stream: Grok's tokens go to the HUD word by word as they arrive, and
// each finished sentence is synthesised and played while the next is written.

export const DEFAULT_VOICE_SHORTCUT = "Alt+Space";
export const VOICE_SECRET_KEYS = ["XAI_API_KEY", "ELEVENLABS_API_KEY"] as const;
/** Read from the app's secrets too, but not required to start. */
export const OPTIONAL_VOICE_SECRET_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
const MIN_SPEECH_BYTES = 8_000; // ~0.25 s of 16 kHz mono PCM

export type DesktopVoiceState = "idle" | "listening" | "thinking" | "speaking";

/** What the HUD window draws: the state ring, the live waveform, and the last lines spoken. */
export type DesktopVoiceHudEvent =
  | { readonly type: "state"; readonly state: DesktopVoiceState }
  | { readonly type: "level"; readonly level: number }
  | { readonly type: "text"; readonly speaker: "you" | "jarvis"; readonly text: string }
  /** A new Jarvis reply begins; following deltas append to it. */
  | { readonly type: "reply-start" }
  | { readonly type: "reply-delta"; readonly text: string }
  /** How many words of the current reply have been spoken so far. */
  | { readonly type: "spoken"; readonly words: number };

export interface DesktopVoiceHudPort {
  update(event: DesktopVoiceHudEvent): void;
  dispose(): void;
}

const ENVELOPE_WINDOW_MS = 50;
const SPOKEN_TICK_MS = 60;
const ALL_WORDS = 1_000_000;

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
  /** When present, replies go to the HUD instead of OS notifications. */
  readonly hud?: DesktopVoiceHudPort;
  readonly createRuntime?: (config: VoiceAssistantConfig) => Promise<Pick<VoiceAssistantRuntime, "assistant" | "voice" | "profile" | "runRoutine">>;
  readonly startRecording?: (options: RecordingOptions) => Promise<Recording>;
  readonly player?: { play(wav: Uint8Array, onStart?: () => void): Promise<void>; stop(): void };
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
  for (const key of [...VOICE_SECRET_KEYS, ...OPTIONAL_VOICE_SECRET_KEYS]) {
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

  const createRuntime = deps.createRuntime
    ?? ((config: VoiceAssistantConfig) => createVoiceAssistantRuntime(config, {
      onMemoryError: (error) => deps.reportFailure("memory", error),
      onNotice: (message) => deps.notify("Jarvis", message),
    }));
  const runtime = await createRuntime(loadVoiceAssistantConfig(voiceEnv));
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

  let envelopeTimer: NodeJS.Timeout | null = null;
  const stopEnvelope = () => {
    if (envelopeTimer) clearInterval(envelopeTimer);
    envelopeTimer = null;
  };
  const hud = deps.hud;
  const setState = (next: DesktopVoiceState) => {
    state = next;
    if (next !== "speaking") stopEnvelope();
    deps.onStateChange?.(next);
    hud?.update({ type: "state", state: next });
  };

  const fail = (leg: string, error: unknown) => {
    deps.reportFailure(leg, error);
    deps.notify("Jarvis", error instanceof Error ? error.message : String(error));
    setState("idle");
  };

  let spokenTimer: NodeJS.Timeout | null = null;
  let wordTimers: NodeJS.Timeout[] = [];
  const stopSpoken = () => {
    if (spokenTimer) clearInterval(spokenTimer);
    spokenTimer = null;
    for (const timer of wordTimers) clearTimeout(timer);
    wordTimers = [];
  };
  let pipeline: SpeechPipeline | null = null;
  let abort: AbortController | null = null;

  const startEnvelope = (wav: Uint8Array, turn: number) => {
    const decoded = hud ? pcmFromWav(wav) : null;
    const envelope = decoded ? pcmEnvelope(decoded.pcm, decoded.sampleRate, ENVELOPE_WINDOW_MS) : [];
    stopEnvelope();
    if (envelope.length === 0) return;
    const startedAt = Date.now();
    envelopeTimer = setInterval(() => {
      const level = envelope[Math.floor((Date.now() - startedAt) / ENVELOPE_WINDOW_MS)];
      if (level === undefined || turn !== generation) return stopEnvelope();
      hud?.update({ type: "level", level });
    }, ENVELOPE_WINDOW_MS);
  };

  // Words light up at their exact start time when ElevenLabs returned alignment,
  // otherwise spread evenly across the sentence's audio.
  const startSpoken = (wordsBefore: number, sentence: SpokenSentence, turn: number) => {
    stopSpoken();
    if (!hud) return;
    const starts = sentence.wordStartsMs;
    if (starts) {
      // One timer per word, fired at the moment ElevenLabs says the word begins.
      wordTimers = starts.map((startMs, index) => setTimeout(() => {
        if (turn === generation) hud.update({ type: "spoken", words: wordsBefore + index + 1 });
      }, startMs));
      return;
    }
    const startedAt = Date.now();
    let last = -1;
    const tick = () => {
      if (turn !== generation) return stopSpoken();
      const fraction = sentence.durationMs > 0 ? Math.min(1, (Date.now() - startedAt) / sentence.durationMs) : 1;
      const words = wordsBefore + Math.min(sentence.words, Math.ceil(fraction * sentence.words));
      if (words !== last) hud.update({ type: "spoken", words });
      last = words;
      if (fraction >= 1) stopSpoken();
    };
    tick();
    spokenTimer = setInterval(tick, SPOKEN_TICK_MS);
  };

  // Word timing needs /with-timestamps; if that endpoint is refused once, plain synthesis is used from then on.
  let timestampsAvailable = Boolean(hud) && typeof runtime.voice.synthesizeWithTimestamps === "function";
  const synthesize = async (text: string, previousText: string, signal: AbortSignal): Promise<SynthesizedSpeech> => {
    if (timestampsAvailable) {
      try {
        return await runtime.voice.synthesizeWithTimestamps(text, { previousText, signal });
      } catch (error) {
        // Only a client error (endpoint or plan refuses timestamps) disables them; outages and rate limits are real failures.
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) throw error;
        timestampsAvailable = false;
        deps.reportFailure("word-timestamps", error);
      }
    }
    return runtime.voice.synthesize(text, { previousText, signal });
  };

  /**
   * Streams one reply: `produce` feeds text deltas and resolves with the full
   * text, or null when the user said "stop". Speech starts with the first sentence.
   */
  const reply = async (turn: number, produce: (onText: (delta: string) => void, signal: AbortSignal) => Promise<string | null>) => {
    const controller = new AbortController();
    abort = controller;
    let wordsBefore = 0;
    const speech = new SpeechPipeline({
      synthesize: (text, context) => synthesize(text, context.previousText, controller.signal),
      play: (wav, onStart) => player.play(wav, onStart),
      onSentenceStart: (sentence) => {
        if (turn !== generation) return;
        if (state !== "speaking") setState("speaking");
        startEnvelope(sentence.wav, turn);
        startSpoken(wordsBefore, sentence, turn);
        wordsBefore += sentence.words;
      },
    });
    pipeline = speech;
    const filter = new AudioTagFilter();
    let started = false;
    let display = "";
    const showDelta = (visible: string) => {
      if (!visible || turn !== generation) return;
      if (!started) {
        started = true;
        hud?.update({ type: "reply-start" });
      }
      display += visible;
      hud?.update({ type: "reply-delta", text: visible });
    };
    try {
      const text = await produce((delta) => {
        if (turn !== generation) return;
        speech.push(delta);
        showDelta(filter.push(delta));
      }, controller.signal);
      if (text === null || turn !== generation) {
        speech.cancel();
        return;
      }
      showDelta(filter.flush());
      if (!hud && display.trim()) deps.notify("Jarvis", display.trim());
      await speech.end();
      if (turn === generation) hud?.update({ type: "spoken", words: ALL_WORDS });
    } finally {
      stopSpoken();
      if (pipeline === speech) pipeline = null;
      if (abort === controller) abort = null;
    }
    if (turn === generation && state !== "idle" && state !== "listening") setState("idle");
  };

  const interrupt = () => {
    abort?.abort();
    abort = null;
    pipeline?.cancel();
    pipeline = null;
    stopSpoken();
    player.stop();
  };

  const startListening = async () => {
    const turn = ++generation;
    interrupt();
    if (!microphoneGranted) {
      microphoneGranted = await deps.requestMicrophoneAccess();
      if (!microphoneGranted) {
        deps.notify("Jarvis", "Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.");
        return;
      }
    }
    recording = await record({ onLevel: (level) => hud?.update({ type: "level", level }) });
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
      // An interrupt during transcription must not still reach Grok (or run its actions).
      if (turn !== generation) return;
      if (!transcript) return setState("idle");
      hud?.update({ type: "text", speaker: "you", text: transcript });
      // Stays in "thinking" until the first sentence plays, so the HUD does not flicker.
      await reply(turn, async (onText, signal) => {
        const answer = await runtime.assistant.handle(transcript, { onText, signal });
        return answer.source === "stop" ? null : answer.text;
      });
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
        else await startListening();
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
      interrupt();
      stopEnvelope();
      hud?.dispose();
    },
  };

  if (!deps.shortcut.register(accelerator, () => void assistant.toggle())) {
    hud?.dispose();
    return { status: "shortcut-unavailable", detail: `${accelerator} is already used by another application. Set JARVIS_SHORTCUT to another accelerator.` };
  }

  const scheduler = new RoutineScheduler({
    routines: runtime.profile.routines,
    run: async (routine) => {
      const report = await runtime.runRoutine(routine);
      if (state === "idle") {
        await reply(generation, async (onText) => {
          onText(report);
          return report;
        });
      }
      else if (hud) hud.update({ type: "text", speaker: "jarvis", text: stripAudioTags(report) });
      else deps.notify(`Jarvis · ${routine.name}`, stripAudioTags(report));
    },
    onError: (routine, error) => deps.reportFailure(`routine:${routine.name}`, error),
  });
  scheduler.start();

  return { status: "started", assistant };
}
