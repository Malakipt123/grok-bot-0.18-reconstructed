import { pcmFromWav } from "./audio.js";
import type { SpeechAlignment } from "./elevenlabs.js";

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

const AUDIO_TAG = /\[[^\]\n]{1,30}\]/g;

export function displayWords(text: string): string[] {
  return text.replace(AUDIO_TAG, " ").split(/\s+/).filter(Boolean);
}

/**
 * Start time (ms) of each displayWords(text) entry, from ElevenLabs character
 * alignment. Returns null when the alignment does not describe this text, so
 * callers can fall back to spreading words evenly.
 */
export function alignWordStarts(text: string, alignment: SpeechAlignment | null): number[] | null {
  if (!alignment || alignment.characters.length === 0) return null;
  // Matched by visible word count rather than exact text: models may normalise
  // whitespace or leave audio tags out of the alignment.
  const aligned = alignment.characters.join("");
  // Characters inside [audio tags] are performed, never shown, so they separate words like spaces do.
  const hidden = new Uint8Array(alignment.characters.length);
  const offsets: number[] = [];
  let position = 0;
  for (const character of alignment.characters) {
    offsets.push(position);
    position += character.length;
  }
  const characterAt = (offset: number) => {
    let low = 0, high = offsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((offsets[mid] ?? 0) <= offset) low = mid; else high = mid - 1;
    }
    return low;
  };
  for (const match of aligned.matchAll(AUDIO_TAG)) {
    const start = match.index ?? 0;
    for (let index = characterAt(start); index <= characterAt(start + match[0].length - 1); index += 1) hidden[index] = 1;
  }
  const starts: number[] = [];
  let inWord = false;
  alignment.characters.forEach((character, index) => {
    const separator = hidden[index] === 1 || /^\s*$/.test(character);
    if (!separator && !inWord) starts.push(Math.max(0, (alignment.characterStartTimesSeconds[index] ?? 0) * 1000));
    inWord = !separator;
  });
  return starts.length === displayWords(text).length ? starts : null;
}

/** What a synthesiser returns: bare WAV bytes, or WAV with character timing. */
export type SynthesizedSpeech = Uint8Array | { readonly wav: Uint8Array; readonly alignment: SpeechAlignment | null };

export interface SpokenSentence {
  readonly index: number;
  readonly text: string;
  /** Visible words in this sentence, for karaoke-style highlighting. */
  readonly words: number;
  /** Exact start of each visible word in ms, when the synthesiser provided alignment. */
  readonly wordStartsMs: readonly number[] | null;
  readonly durationMs: number;
  readonly wav: Uint8Array;
}

export interface SpeechPipelineOptions {
  readonly synthesize: (text: string, context: { readonly previousText: string }) => Promise<SynthesizedSpeech>;
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
        const speech = await audio;
        if (this.#cancelled) return;
        const wav = speech instanceof Uint8Array ? speech : speech.wav;
        const wordStartsMs = speech instanceof Uint8Array ? null : alignWordStarts(text, speech.alignment);
        const decoded = pcmFromWav(wav);
        const durationMs = decoded ? (decoded.pcm.length / 2 / decoded.sampleRate) * 1000 : 0;
        const sentence: SpokenSentence = { index, text, words: displayWords(text).length, wordStartsMs, durationMs, wav };
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
