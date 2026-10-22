import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Audio I/O shells out to tools that are usually already installed, so the
// assistant needs no native Node modules: sox or ffmpeg to record, afplay /
// ffplay / mpg123 to play.

export interface AudioCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export function hasCommand(file: string): boolean {
  const probe = process.platform === "win32" ? spawnSync("where", [file]) : spawnSync("sh", ["-c", 'command -v "$1"', "sh", file]);
  return probe.status === 0;
}

export function recorderCommand(output: string, platform = process.platform, available = hasCommand): AudioCommand | null {
  if (available("sox")) return { file: "sox", args: ["-q", "-d", "-c", "1", "-r", "16000", "-b", "16", output] };
  if (!available("ffmpeg")) return null;
  const input =
    platform === "darwin" ? ["-f", "avfoundation", "-i", ":0"]
    : platform === "linux" ? ["-f", "pulse", "-i", "default"]
    : null;
  return input ? { file: "ffmpeg", args: ["-loglevel", "error", "-y", ...input, "-ac", "1", "-ar", "16000", output] } : null;
}

export function playerCommand(input: string, platform = process.platform, available = hasCommand): AudioCommand | null {
  if (platform === "darwin") return { file: "afplay", args: [input] };
  if (available("ffplay")) return { file: "ffplay", args: ["-loglevel", "error", "-nodisp", "-autoexit", input] };
  if (available("mpg123")) return { file: "mpg123", args: ["-q", input] };
  return null;
}

export interface Recording {
  /** Stops recording and resolves with WAV bytes. */
  stop(): Promise<Uint8Array>;
}

export async function startRecording(): Promise<Recording> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-voice-"));
  const output = path.join(directory, "speech.wav");
  const command = recorderCommand(output);
  if (!command) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("No recorder found. Install sox (brew install sox) or ffmpeg.");
  }
  const child = spawn(command.file, [...command.args], { stdio: ["pipe", "ignore", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    async stop() {
      // ffmpeg finalises the WAV header on "q"; sox on SIGINT.
      if (command.file === "ffmpeg") child.stdin?.end("q");
      else child.kill("SIGINT");
      await exited;
      try {
        return new Uint8Array(await readFile(output));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export class AudioPlayer {
  #current: ChildProcess | null = null;

  get available(): boolean {
    return playerCommand("probe.mp3") !== null;
  }

  async play(mp3: Uint8Array): Promise<void> {
    this.stop();
    const directory = await mkdtemp(path.join(os.tmpdir(), "grok-voice-"));
    const file = path.join(directory, "reply.mp3");
    try {
      await writeFile(file, mp3);
      const command = playerCommand(file);
      if (!command) throw new Error("No audio player found. Install ffmpeg (ffplay) or mpg123.");
      const child = spawn(command.file, [...command.args], { stdio: "ignore" });
      this.#current = child;
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    } finally {
      this.#current = null;
      await rm(directory, { recursive: true, force: true });
    }
  }

  stop(): void {
    this.#current?.kill();
    this.#current = null;
  }
}
