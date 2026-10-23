import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { GrokMessage, GrokTool } from "./grok.js";

// Memory that survives restarts, kept in one local JSON file next to
// ASSISTANT.md: long-term facts about the user, and the recent conversation.

export const MEMORY_FILENAME = "memory.json";
export const MAX_FACT_CHARS = 300;
const DEFAULT_MAX_FACTS = 200;
const PROMPT_FACT_CHARS = 4_000;

const SECRET_WORDS = /password|passcode|palavra-passe|senha|\bpin\b|\bcvv\b|\biban\b|card number|n[úu]mero do cart[ãa]o|one-time code|c[óo]digo de (?:acesso|verifica[çc][ãa]o|seguran[çc]a)/iu;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/;

/** True for text that looks like a credential or payment detail, which is never stored. */
export function looksSecret(text: string): boolean {
  return SECRET_WORDS.test(text) || CARD_NUMBER.test(text);
}

export interface MemoryFact {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type ConversationMessage = { readonly role: "user" | "assistant"; readonly content: string };

interface MemoryFile {
  readonly schemaVersion: 1;
  readonly nextId: number;
  readonly facts: readonly MemoryFact[];
  readonly conversation: { readonly savedAt: string; readonly messages: readonly ConversationMessage[] } | null;
}

export interface MemoryStoreOptions {
  readonly now?: () => Date;
  readonly maxFacts?: number;
  /** Called when an unreadable memory file was moved aside instead of being overwritten. */
  readonly onCorruptFile?: (backupPath: string) => void;
}

export interface RememberResult {
  readonly fact: MemoryFact;
  readonly created: boolean;
}

export const MEMORY_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "remember",
      description: "Save a durable fact about the user (name, preferences, people, routines) so you still know it in future sessions. Write it as a short third-person statement.",
      parameters: { type: "object", properties: { fact: { type: "string", maxLength: MAX_FACT_CHARS } }, required: ["fact"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Delete a saved fact by its id (shown as [m12] in your memory) when the user asks you to forget it or it is no longer true.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
];

export function isMemoryToolName(name: string): name is "remember" | "forget" {
  return name === "remember" || name === "forget";
}

function emptyMemory(): MemoryFile {
  return { schemaVersion: 1, nextId: 1, facts: [], conversation: null };
}

function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s.!?]+/g, " ").trim();
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (typeof value !== "object" || value == null) return false;
  const record = value as Record<string, unknown>;
  return (record.role === "user" || record.role === "assistant") && typeof record.content === "string";
}

function parseMemoryFile(raw: string): MemoryFile {
  const parsed = JSON.parse(raw) as Partial<MemoryFile> | null;
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.facts)) throw new Error("Unsupported memory file");
  const facts = parsed.facts.filter((fact): fact is MemoryFact =>
    typeof fact?.id === "string" && typeof fact.text === "string" && typeof fact.createdAt === "string" && typeof fact.updatedAt === "string");
  const highest = facts.reduce((max, fact) => Math.max(max, Number(fact.id.slice(1)) || 0), 0);
  const conversation = parsed.conversation;
  return {
    schemaVersion: 1,
    nextId: Math.max(Number(parsed.nextId) || 1, highest + 1),
    facts,
    conversation: conversation && typeof conversation.savedAt === "string" && Array.isArray(conversation.messages)
      ? { savedAt: conversation.savedAt, messages: conversation.messages.filter(isConversationMessage) }
      : null,
  };
}

export class MemoryStore {
  readonly #path: string;
  readonly #options: MemoryStoreOptions;
  #data: MemoryFile;
  #writes: Promise<void> = Promise.resolve();

  private constructor(filePath: string, data: MemoryFile, options: MemoryStoreOptions) {
    this.#path = filePath;
    this.#data = data;
    this.#options = options;
  }

  static async open(filePath: string, options: MemoryStoreOptions = {}): Promise<MemoryStore> {
    let data = emptyMemory();
    try {
      data = parseMemoryFile(await readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Never overwrite memories we could not read; keep them for the user to recover.
        const backup = `${filePath}.corrupt-${Date.now()}`;
        await rename(filePath, backup).catch(() => undefined);
        options.onCorruptFile?.(backup);
      }
    }
    return new MemoryStore(filePath, data, options);
  }

  get path(): string {
    return this.#path;
  }

  get facts(): readonly MemoryFact[] {
    return this.#data.facts;
  }

  async remember(text: string): Promise<RememberResult> {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("Nothing to remember");
    if (clean.length > MAX_FACT_CHARS) throw new Error(`A memory can be at most ${MAX_FACT_CHARS} characters`);
    if (looksSecret(clean)) throw new Error("Refusing to store what looks like a password, code or card number");
    const now = this.#now();
    const existing = this.#data.facts.find((fact) => normalise(fact.text) === normalise(clean));
    if (existing) {
      const fact = { ...existing, updatedAt: now };
      this.#data = { ...this.#data, facts: this.#data.facts.map((entry) => (entry.id === existing.id ? fact : entry)) };
      await this.#save();
      return { fact, created: false };
    }
    const fact: MemoryFact = { id: `m${this.#data.nextId}`, text: clean, createdAt: now, updatedAt: now };
    const maxFacts = this.#options.maxFacts ?? DEFAULT_MAX_FACTS;
    // The oldest untouched facts make room for new ones.
    const byAge = [...this.#data.facts].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const kept = byAge.slice(Math.max(0, byAge.length - (maxFacts - 1)));
    const facts = this.#data.facts.filter((entry) => kept.includes(entry));
    this.#data = { ...this.#data, nextId: this.#data.nextId + 1, facts: [...facts, fact] };
    await this.#save();
    return { fact, created: true };
  }

  async forget(id: string): Promise<MemoryFact | null> {
    const target = this.#data.facts.find((fact) => fact.id === id.trim().replace(/^\[|\]$/g, ""));
    if (!target) return null;
    this.#data = { ...this.#data, facts: this.#data.facts.filter((fact) => fact !== target) };
    await this.#save();
    return target;
  }

  async forgetAll(): Promise<void> {
    this.#data = { ...this.#data, facts: [], conversation: null };
    await this.#save();
  }

  async saveConversation(messages: readonly GrokMessage[]): Promise<void> {
    const kept = messages.filter(isConversationMessage).map(({ role, content }) => ({ role, content }));
    this.#data = { ...this.#data, conversation: { savedAt: this.#now(), messages: kept } };
    await this.#save();
  }

  /** The saved conversation, if it is recent enough to still be the same conversation. */
  restoreConversation(maxAgeMs: number): GrokMessage[] {
    const conversation = this.#data.conversation;
    if (!conversation || maxAgeMs <= 0) return [];
    const age = (this.#options.now?.() ?? new Date()).getTime() - Date.parse(conversation.savedAt);
    if (!Number.isFinite(age) || age > maxAgeMs) return [];
    const start = conversation.messages.findIndex((message) => message.role === "user");
    return start < 0 ? [] : conversation.messages.slice(start).map((message) => ({ ...message }));
  }

  /** Facts for the system prompt, newest first, within a character budget. */
  promptBlock(maxChars = PROMPT_FACT_CHARS): string {
    const lines: string[] = [];
    let used = 0;
    for (const fact of [...this.#data.facts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
      const line = `[${fact.id}] ${fact.text}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join("\n");
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }

  #save(): Promise<void> {
    const snapshot = `${JSON.stringify(this.#data, null, 2)}\n`;
    // Writes are serialised and atomic (temp file + rename), and the file stays private to the user.
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }
}
