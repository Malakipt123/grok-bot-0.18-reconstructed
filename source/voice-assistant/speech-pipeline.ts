import { pcmFromWav } from "./audio.js";

// Streaming speech: Grok's token deltas are cut into sentences, each sentence
// is synthesised as soon as it is complete, and playback runs in order while
// later sentences are still being generated and synthesised.

const SENTENCE_END = /[.!?…]+["'»)\]]*(?=\s)|\n+/g;
const MIN_SENTENCE_CHARS = 12;
const SOFT_SPLIT_CHARS = 90;
const HARD_SPLIT_CHARS = 220;

/** Splits streamed text into speakable sentences. */
export class SentenceChunker {
  #buffer = "";
  #emitted = 0;

  push(delta: string): string[] {
    this.#buffer += delta;
    const sentences: string[] = [];
    for (;;) {
      const sentence = this.#take();
      if (!sentence) break;
      sentences.push(sentence);
    }
    return sentences;
  }

  flush(): string | null {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    return rest || null;
  }

  #take(): string | null {
    let cut = -1;
    for (const match of this.#buffer.matchAll(SENTENCE_END)) {
      const end = (match.index ?? 0) + match[0].length;
      if (this.#buffer.slice(0, end).trim().length >= MIN_SENTENCE_CHARS) {
        cut = end;
        break;
      }
    }
    // The first sentence may be cut at a comma so the voice starts sooner;
    // anything very long is cut at the last space.
    if (cut < 0 && this.#emitted === 0 && this.#buffer.length >= SOFT_SPLIT_CHARS) {
      const comma = this.#buffer.lastIndexOf(", ");
      if (comma >= MIN_SENTENCE_CHARS) cut = comma + 1;
    }
    if (cut < 0 && this.#buffer.length >= HARD_SPLIT_CHARS) {
      const space = this.#buffer.lastIndexOf(" ");
      cut = space > MIN_SENTENCE_CHARS ? space : this.#buffer.length;
    }
    if (cut < 0) return null;
    const sentence = this.#buffer.slice(0, cut).trim();
    this.#buffer = this.#buffer.slice(cut);
    if (!sentence) return null;
    this.#emitted += 1;
    return sentence;
  }
}

/** Removes [audio tags] from a token stream, even when a tag is split across deltas. */
export class AudioTagFilter {
  #pending = "";

  push(delta: string): string {
    let output = "";
    for (const character of delta) {
      if (this.#pending) {
        this.#pending += character;
        if (character === "]") {
          this.#pending = "";
        } else if (character === "\n" || this.#pending.length > 31) {
          output += this.#pending;
          this.#pending = "";
        }
      } else if (character === "[") {
        this.#pending = "[";
      } else {
        output += character;
      }
    }
    return output;
  }

  flush(): string {
    const rest = this.#pending;
    this.#pending = "";
    return rest;
  }
}

export function displayWords(text: string): string[] {
  return text.replace(/\[[^\]\n]{1,30}\]/g, " ").split(/\s+/).filter(Boolean);
}

export interface SpokenSentence {
  readonly index: number;
  readonly text: string;
  /** Visible words in this sentence, for karaoke-style highlighting. */
  readonly words: number;
  readonly durationMs: number;
  readonly wav: Uint8Array;
}

export interface SpeechPipelineOptions {
  readonly synthesize: (text: string, context: { readonly previousText: string }) => Promise<Uint8Array>;
  readonly play: (wav: Uint8Array, onStart: () => void) => Promise<void>;
  readonly onSentenceStart?: (sentence: SpokenSentence) => void;
  /** Concurrent TTS requests; ElevenLabs plans cap concurrency, so keep this small. */
  readonly concurrency?: number;
}

export class SpeechPipeline {
  readonly #options: SpeechPipelineOptions;
  readonly #chunker = new SentenceChunker();
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  #index = 0;
  #previousText = "";
  #playback: Promise<void> = Promise.resolve();
  #error: unknown = null;
  #cancelled = false;

  constructor(options: SpeechPipelineOptions) {
    this.#options = options;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  push(delta: string): void {
    if (this.#cancelled) return;
    for (const sentence of this.#chunker.push(delta)) this.#enqueue(sentence);
  }

  /** Flushes the last partial sentence and resolves when everything has been played. */
  async end(): Promise<void> {
    const rest = this.#chunker.flush();
    if (rest && !this.#cancelled) this.#enqueue(rest);
    await this.#playback;
    if (this.#error && !this.#cancelled) throw this.#error;
  }

  cancel(): void {
    this.#cancelled = true;
    for (const release of this.#waiting.splice(0)) release();
  }

  #enqueue(text: string): void {
    const index = this.#index++;
    const previousText = this.#previousText.slice(-300);
    this.#previousText += `${this.#previousText ? " " : ""}${text}`;
    const audio = this.#limit(() => this.#options.synthesize(text, { previousText }));
    // Keep a rejection from surfacing as unhandled before playback reaches it.
    audio.catch(() => undefined);
    this.#playback = this.#playback.then(async () => {
      if (this.#cancelled || this.#error) return;
      try {
        const wav = await audio;
        if (this.#cancelled) return;
        const decoded = pcmFromWav(wav);
        const durationMs = decoded ? (decoded.pcm.length / 2 / decoded.sampleRate) * 1000 : 0;
        const sentence: SpokenSentence = { index, text, words: displayWords(text).length, durationMs, wav };
        await this.#options.play(wav, () => {
          if (!this.#cancelled) this.#options.onSentenceStart?.(sentence);
        });
      } catch (error) {
        this.#error ??= error;
      }
    });
  }

  async #limit<T>(task: () => Promise<T>): Promise<T> {
    const concurrency = this.#options.concurrency ?? 2;
    while (this.#active >= concurrency && !this.#cancelled) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    if (this.#cancelled) throw new Error("cancelled");
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}
