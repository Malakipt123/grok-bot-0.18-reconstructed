import { wavFromPcm } from "./audio.js";
import { safeText } from "./grok.js";

// Raw PCM keeps playback and the HUD waveform in sync without an MP3 decoder.
export const TTS_SAMPLE_RATE = 22_050;

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

  /** Returns WAV bytes. eleven_v3 understands inline audio tags such as [sighs] or [laughs]. */
  async synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = `${this.#options.baseUrl}/text-to-speech/${encodeURIComponent(this.#options.voiceId)}?output_format=pcm_${TTS_SAMPLE_RATE}`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.#options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: this.#options.ttsModel }),
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
