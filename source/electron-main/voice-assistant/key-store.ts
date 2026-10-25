import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// API keys typed into the setup window. Electron's safeStorage encrypts them
// with the OS (DPAPI on Windows, Keychain on macOS, the keyring on Linux);
// where no OS encryption exists the file is still private (0600).

export const KEY_STORE_FILENAME = "keys.json";
export const SETUP_KEYS = ["XAI_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredKeys {
  readonly schemaVersion: 1;
  readonly encrypted: boolean;
  readonly data: string;
}

export class KeyStore {
  readonly #filePath: string;
  readonly #cipher: SecretCipher;
  #keys: Partial<Record<SetupKey, string>> | null = null;

  constructor(filePath: string, cipher: SecretCipher) {
    this.#filePath = filePath;
    this.#cipher = cipher;
  }

  async get(key: string): Promise<string | null> {
    return (await this.#load())[key as SetupKey] ?? null;
  }

  async has(key: SetupKey): Promise<boolean> {
    return Boolean((await this.#load())[key]);
  }

  /** Blank values keep what is already saved, so the form never has to show a secret again. */
  async save(values: Partial<Record<string, unknown>>): Promise<void> {
    const keys = { ...(await this.#load()) };
    for (const key of SETUP_KEYS) {
      const value = values[key];
      if (typeof value === "string" && value.trim()) keys[key] = value.trim();
    }
    const json = JSON.stringify(keys);
    const encrypted = this.#cipher.isEncryptionAvailable();
    const stored: StoredKeys = {
      schemaVersion: 1,
      encrypted,
      data: encrypted ? this.#cipher.encryptString(json).toString("base64") : Buffer.from(json, "utf8").toString("base64"),
    };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#filePath);
    this.#keys = keys;
  }

  async #load(): Promise<Partial<Record<SetupKey, string>>> {
    if (this.#keys) return this.#keys;
    try {
      const stored = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<StoredKeys>;
      if (stored.schemaVersion !== 1 || typeof stored.data !== "string") throw new Error("unknown format");
      const bytes = Buffer.from(stored.data, "base64");
      const json = stored.encrypted ? this.#cipher.decryptString(bytes) : bytes.toString("utf8");
      const parsed = JSON.parse(json) as Record<string, unknown>;
      this.#keys = Object.fromEntries(SETUP_KEYS.flatMap((key) => (typeof parsed[key] === "string" ? [[key, parsed[key]]] : [])));
    } catch {
      // Missing, unreadable, or encrypted for another user or machine: ask again.
      this.#keys = {};
    }
    return this.#keys;
  }
}
