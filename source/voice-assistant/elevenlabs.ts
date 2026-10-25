import { wavFromPcm } from "./audio.js";
import { safeText } from "./grok.js";

// Raw PCM keeps playback and the HUD waveform in sync without an MP3 decoder.
export const TTS_SAMPLE_RATE = 22_050;

export interface SynthesizeOptions {
  readonly previousText?: string;
  readonly signal?: AbortSignal;
}

const STITCHING_MODELS = /^eleven_(multilingual_v2|turbo|flash)/;

/** Per-character timing for the text that was sent, as returned by `/with-timestamps`. */
export interface SpeechAlignment {
  readonly characters: readonly string[];
  readonly characterStartTimesSeconds: readonly number[];
}

export interface TimedSpeech {
  readonly wav: Uint8Array;
  readonly alignment: SpeechAlignment | null;
}

export class ElevenLabsHttpError extends Error {
  override readonly name = "ElevenLabsHttpError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ElevenLabsClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly sttModel: string;
  readonly language: string;
  readonly fetch?: typeof fetch;
}

/** A voice in the user's ElevenLabs account (premade, cloned or from the library). */
export interface ElevenLabsVoice {
  readonly id: string;
  readonly name: string;
  readonly gender: string | null;
  readonly accent: string | null;
  readonly age: string | null;
  readonly description: string | null;
}

export class ElevenLabsClient {
  readonly #options: ElevenLabsClientOptions;
  readonly #fetch: typeof fetch;
  #voiceId: string;

  constructor(options: ElevenLabsClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#voiceId = options.voiceId;
  }

  get voiceId(): string {
    return this.#voiceId;
  }

  /** Later synthesis, including the rest of a reply already being spoken, uses this voice. */
  setVoice(voiceId: string): void {
    this.#voiceId = voiceId;
  }

  async listVoices(signal?: AbortSignal): Promise<ElevenLabsVoice[]> {
    const response = await this.#fetch(`${this.#options.baseUrl}/voices`, {
      headers: { "xi-api-key": this.#options.apiKey },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new ElevenLabsHttpError(response.status, `ElevenLabs voices failed (${response.status}): ${await safeText(response)}`);
    const body = (await response.json()) as { voices?: Array<{ voice_id?: unknown; name?: unknown; description?: unknown; labels?: Record<string, unknown> | null }> };
    const label = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    return (body.voices ?? []).flatMap((voice) => typeof voice.voice_id === "string" && typeof voice.name === "string"
      ? [{
        id: voice.voice_id,
        name: voice.name,
        gender: label(voice.labels?.gender),
        accent: label(voice.labels?.accent),
        age: label(voice.labels?.age),
        description: label(voice.description) ?? label(voice.labels?.description),
      }]
      : []);
  }

  /**
   * Returns WAV bytes. eleven_v3 understands inline audio tags such as [sighs] or [laughs].
   * `previousText` keeps intonation continuous when a reply is synthesised sentence by sentence;
   * it is only sent to models that support request stitching.
   */
  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<Uint8Array> {
    const response = await this.#requestSpeech("", text, options);
    return wavFromPcm(new Uint8Array(await response.arrayBuffer()), TTS_SAMPLE_RATE);
  }

  /** Like synthesize(), plus the start time of every character, for word-exact captions. */
  async synthesizeWithTimestamps(text: string, options: SynthesizeOptions = {}): Promise<TimedSpeech> {
    const response = await this.#requestSpeech("/with-timestamps", text, options);
    const body = (await response.json()) as {
      audio_base64?: string;
      alignment?: { characters?: string[]; character_start_times_seconds?: number[] } | null;
    };
    if (typeof body.audio_base64 !== "string") throw new Error("ElevenLabs returned no audio");
    const pcm = new Uint8Array(Buffer.from(body.audio_base64, "base64"));
    const characters = body.alignment?.characters;
    const starts = body.alignment?.character_start_times_seconds;
    const alignment = Array.isArray(characters) && Array.isArray(starts) && characters.length === starts.length
      ? { characters, characterStartTimesSeconds: starts }
      : null;
    return { wav: wavFromPcm(pcm, TTS_SAMPLE_RATE), alignment };
  }

  async #requestSpeech(suffix: string, text: string, options: SynthesizeOptions): Promise<Response> {
    const { previousText, signal } = options;
    const stitching = previousText && STITCHING_MODELS.test(this.#options.ttsModel) ? { previous_text: previousText } : {};
    const url = `${this.#options.baseUrl}/text-to-speech/${encodeURIComponent(this.#voiceId)}${suffix}?output_format=pcm_${TTS_SAMPLE_RATE}`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.#options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.#options.ttsModel, ...stitching }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new ElevenLabsHttpError(response.status, `ElevenLabs TTS failed (${response.status}): ${await safeText(response)}`);
    }
    return response;
  }

  async transcribe(audio: Uint8Array, filename = "speech.wav", signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.set("model_id", this.#options.sttModel);
    form.set("language_code", this.#options.language);
    form.set("file", new Blob([Uint8Array.from(audio)]), filename);
    const response = await this.#fetch(`${this.#options.baseUrl}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": this.#options.apiKey },
      body: form,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs STT failed (${response.status}): ${await safeText(response)}`);
    }
    const body = (await response.json()) as { text?: string };
    return (body.text ?? "").trim();
  }
}
