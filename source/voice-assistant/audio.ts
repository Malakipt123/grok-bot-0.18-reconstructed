import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Audio I/O shells out to tools that are usually already installed, so the
// assistant needs no native Node modules: sox or ffmpeg to record, afplay /
// ffplay / aplay to play. Audio stays raw 16-bit PCM in Node so the HUD can
// draw a live waveform from it.

export const RECORDING_SAMPLE_RATE = 16_000;

export interface AudioCommand {
  readonly file: string;
  readonly args: readonly string[];
}

// Apps launched from Finder inherit a minimal PATH without Homebrew.
const EXTRA_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export function toolEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  if (platform === "win32") return env;
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return { ...env, PATH: [...entries, ...EXTRA_TOOL_DIRS.filter((dir) => !entries.includes(dir))].join(path.delimiter) };
}

export function hasCommand(file: string): boolean {
  const probe = process.platform === "win32" ? spawnSync("where", [file]) : spawnSync("sh", ["-c", 'command -v "$1"', "sh", file], { env: toolEnv() });
  return probe.status === 0;
}

/** Records mono s16le PCM at RECORDING_SAMPLE_RATE to stdout. */
export function recorderCommand(platform = process.platform, available = hasCommand): AudioCommand | null {
  const rate = String(RECORDING_SAMPLE_RATE);
  if (available("sox")) return { file: "sox", args: ["-q", "-d", "-t", "raw", "-r", rate, "-c", "1", "-b", "16", "-e", "signed-integer", "-"] };
  if (!available("ffmpeg")) return null;
  const input =
    platform === "darwin" ? ["-f", "avfoundation", "-i", ":0"]
    : platform === "linux" ? ["-f", "pulse", "-i", "default"]
    : null;
  return input ? { file: "ffmpeg", args: ["-loglevel", "error", ...input, "-ac", "1", "-ar", rate, "-f", "s16le", "-"] } : null;
}

export function playerCommand(input: string, platform = process.platform, available = hasCommand): AudioCommand | null {
  if (platform === "darwin") return { file: "afplay", args: [input] };
  if (available("ffplay")) return { file: "ffplay", args: ["-loglevel", "error", "-nodisp", "-autoexit", input] };
  if (available("aplay")) return { file: "aplay", args: ["-q", input] };
  return null;
}

/** Wraps mono s16le PCM in a WAV container. */
export function wavFromPcm(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}

/** Returns the PCM payload and sample rate of a mono 16-bit WAV produced by wavFromPcm. */
export function pcmFromWav(wav: Uint8Array): { readonly pcm: Uint8Array; readonly sampleRate: number } | null {
  const buffer = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 36, 40) !== "data") return null;
  return { pcm: wav.subarray(44, 44 + buffer.readUInt32LE(40)), sampleRate: buffer.readUInt32LE(24) };
}

/** Perceptual loudness in 0..1 for a block of s16le samples. */
export function pcmLevel(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = view.getInt16(index * 2, true) / 32768;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples);
  return Math.min(1, Math.pow(rms * 5, 0.6));
}

/** Splits PCM into windowMs blocks and returns one level per block, for animating playback. */
export function pcmEnvelope(pcm: Uint8Array, sampleRate: number, windowMs = 50): number[] {
  const blockBytes = Math.max(2, Math.round((sampleRate * windowMs) / 1000) * 2);
  const levels: number[] = [];
  for (let offset = 0; offset < pcm.length; offset += blockBytes) levels.push(pcmLevel(pcm.subarray(offset, offset + blockBytes)));
  return levels;
}

export interface Recording {
  /** Stops recording and resolves with WAV bytes. */
  stop(): Promise<Uint8Array>;
}

export interface RecordingOptions {
  /** Called for every chunk the recorder delivers, roughly every 20–100 ms. */
  readonly onLevel?: (level: number) => void;
}

export async function startRecording(options: RecordingOptions = {}): Promise<Recording> {
  const command = recorderCommand();
  if (!command) throw new Error("No recorder found. Install sox (brew install sox) or ffmpeg.");
  const child = spawn(command.file, [...command.args], { stdio: ["pipe", "pipe", "ignore"], env: toolEnv() });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    options.onLevel?.(pcmLevel(chunk));
  });
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    async stop() {
      // ffmpeg flushes and exits on "q"; sox on SIGINT.
      if (command.file === "ffmpeg") child.stdin?.end("q");
      else child.kill("SIGINT");
      await exited;
      return wavFromPcm(Buffer.concat(chunks), RECORDING_SAMPLE_RATE);
    },
  };
}

export class AudioPlayer {
  #current: ChildProcess | null = null;

  get available(): boolean {
    return playerCommand("probe.wav") !== null;
  }

  /** Plays WAV bytes; `onStart` fires once the player process is running. */
  async play(wav: Uint8Array, onStart?: () => void): Promise<void> {
    this.stop();
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-voice-"));
    const file = path.join(directory, "reply.wav");
    let child: ChildProcess | null = null;
    try {
      await writeFile(file, wav);
      const command = playerCommand(file);
      if (!command) throw new Error("No audio player found. Install ffmpeg (ffplay) or alsa-utils (aplay).");
      const player = spawn(command.file, [...command.args], { stdio: "ignore", env: toolEnv() });
      child = player;
      this.#current = player;
      await new Promise<void>((resolve, reject) => {
        player.once("spawn", () => onStart?.());
        player.once("error", reject);
        player.once("exit", () => resolve());
      });
    } finally {
      if (this.#current === child) this.#current = null;
      await rm(directory, { recursive: true, force: true });
    }
  }

  stop(): void {
    this.#current?.kill();
    this.#current = null;
  }
}
