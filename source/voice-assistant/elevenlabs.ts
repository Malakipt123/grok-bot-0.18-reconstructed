import { safeText } from "./grok.js";

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

  /** Returns MP3 bytes. eleven_v3 understands inline audio tags such as [sighs] or [laughs]. */
  async synthesize(text: string, signal?: AbortSignal): Promise<Uint8Array> {
    const url = `${this.#options.baseUrl}/text-to-speech/${encodeURIComponent(this.#options.voiceId)}?output_format=mp3_44100_128`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.#options.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: this.#options.ttsModel }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${await safeText(response)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
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
