import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantToolkit } from "./calendar.js";
import type { ElevenLabsClient, ElevenLabsVoice } from "./elevenlabs.js";
import type { GrokTool } from "./grok.js";

// "Usa uma voz feminina": Grok lists the voices in the user's ElevenLabs
// account, picks the best match and switches to it. The choice is saved in
// voice.json next to ASSISTANT.md and wins over ELEVENLABS_VOICE_ID on restart.

export const VOICE_SETTINGS_FILENAME = "voice.json";
const MAX_LISTED = 25;

interface SavedVoice {
  readonly voiceId: string;
  readonly name: string;
}

export const VOICE_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "voice_list",
      description: "List the voices available in the user's ElevenLabs account, optionally only female or male ones.",
      parameters: {
        type: "object",
        properties: {
          gender: { type: "string", enum: ["female", "male"] },
          query: { type: "string", description: "Words to match in the name, accent or description, e.g. british, calm, young." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_set",
      description: "Switch Jarvis to another voice from voice_list. The rest of your reply is already spoken with it.",
      parameters: { type: "object", properties: { voice_id: { type: "string" } }, required: ["voice_id"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "voice_reset",
      description: "Go back to the default voice.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
];

export function describeVoice(voice: ElevenLabsVoice): string {
  const traits = [voice.gender, voice.accent, voice.age].filter(Boolean).join(", ");
  return `${voice.id} · ${voice.name}${traits ? ` (${traits})` : ""}${voice.description ? ` — ${voice.description}` : ""}`;
}

export function filterVoices(voices: readonly ElevenLabsVoice[], gender?: string, query?: string): ElevenLabsVoice[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return voices.filter((voice) => {
    if (gender && voice.gender?.toLowerCase() !== gender) return false;
    const haystack = [voice.name, voice.accent, voice.age, voice.description].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export class VoiceSelector {
  readonly #client: ElevenLabsClient;
  readonly #filePath: string;
  readonly #defaultVoiceId: string;
  #name: string | null;

  private constructor(client: ElevenLabsClient, filePath: string, defaultVoiceId: string, saved: SavedVoice | null) {
    this.#client = client;
    this.#filePath = filePath;
    this.#defaultVoiceId = defaultVoiceId;
    this.#name = saved?.name ?? null;
    if (saved) client.setVoice(saved.voiceId);
  }

  /** Applies the saved voice, if any, to `client`; `client.voiceId` is the default otherwise. */
  static async open(client: ElevenLabsClient, filePath: string): Promise<VoiceSelector> {
    const saved = await readFile(filePath, "utf8").then((text) => {
      const data = JSON.parse(text) as Partial<SavedVoice>;
      return typeof data.voiceId === "string" && data.voiceId && typeof data.name === "string" ? { voiceId: data.voiceId, name: data.name } : null;
    }, () => null).catch(() => null);
    return new VoiceSelector(client, filePath, client.voiceId, saved);
  }

  /** Name of the chosen voice, or null for the default. */
  get current(): string | null {
    return this.#name;
  }

  async select(voiceId: string): Promise<ElevenLabsVoice> {
    // Only voices that really exist in the account: a made-up id would break every later reply.
    const voice = (await this.#client.listVoices()).find((candidate) => candidate.id === voiceId);
    if (!voice) throw new Error(`No voice with id ${voiceId} in this ElevenLabs account`);
    await this.#save({ voiceId: voice.id, name: voice.name });
    this.#client.setVoice(voice.id);
    this.#name = voice.name;
    return voice;
  }

  async reset(): Promise<void> {
    await this.#save(null);
    this.#client.setVoice(this.#defaultVoiceId);
    this.#name = null;
  }

  toolkit(): AssistantToolkit {
    return {
      tools: async () => VOICE_TOOLS,
      handles: (name) => VOICE_TOOLS.some((tool) => tool.function.name === name),
      prompt: async () => `Your voice is currently ${this.#name ?? "the default one"}. When the user asks for another voice (female, male, an accent, calmer…), call voice_list, pick the best match yourself without asking, call voice_set, and confirm in one short sentence with the voice's name.`,
      run: async (name, args) => {
        if (name === "voice_list") {
          const gender = typeof args.gender === "string" ? args.gender : undefined;
          const query = typeof args.query === "string" ? args.query : undefined;
          const voices = filterVoices(await this.#client.listVoices(), gender, query);
          if (voices.length === 0) return "No matching voices. Try without the query.";
          return voices.slice(0, MAX_LISTED).map(describeVoice).join("\n");
        }
        if (name === "voice_set") {
          const voice = await this.select(String(args.voice_id ?? ""));
          return `Voice set to ${voice.name}.`;
        }
        if (name === "voice_reset") {
          await this.reset();
          return "Back to the default voice.";
        }
        return `Error: unknown tool ${name}`;
      },
    };
  }

  async #save(voice: SavedVoice | null): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(voice ?? {}, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#filePath);
  }
}
