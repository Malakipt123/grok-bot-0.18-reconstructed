import { wavFromPcm } from "./audio.js";
import { safeText } from "./grok.js";

// Raw PCM keeps playback and the HUD waveform in sync without an MP3 decoder.
export const TTS_SAMPLE_RATE = 22_050;

export interface SynthesizeOptions {
  readonly previousText?: string;
  readonly signal?: AbortSignal;
}

const STITCHING_MODELS = /^eleven_(multilingual_v2|turbo|flash)/;

export interface ElevenLabsClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly voiceId: string;
  readonly ttsModel: string;
  readonly sttModel: string;
  readonly language: string;
  readonly fetch?: typeof fetch;
}

export class ElevenLabsClient {
  readonly #options: ElevenLabsClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: ElevenLabsClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Returns WAV bytes. eleven_v3 understands inline audio tags such as [sighs] or [laughs].
   * `previousText` keeps intonation continuous when a reply is synthesised sentence by sentence;
   * it is only sent to models that support request stitching.
   */
  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<Uint8Array> {
    const { previousText, signal } = options;
    const stitching = previousText && STITCHING_MODELS.test(this.#options.ttsModel) ? { previous_text: previousText } : {};
    const url = `${this.#options.baseUrl}/text-to-speech/${encodeURIComponent(this.#options.voiceId)}?output_format=pcm_${TTS_SAMPLE_RATE}`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.#options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.#options.ttsModel, ...stitching }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${await safeText(response)}`);
    }
    return wavFromPcm(new Uint8Array(await response.arrayBuffer()), TTS_SAMPLE_RATE);
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
