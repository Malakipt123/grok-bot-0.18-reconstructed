import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EmailSummary } from "./gmail.js";
import type { Announcement } from "./voice-reminders.js";

// "Novo email importante de Ana Silva: Contrato." Every few minutes Jarvis
// looks for unread mail that Gmail itself marks as important and says who it
// is from and the subject. Only those two headers are spoken, straight to
// speech: the body is never read and nothing goes through Grok, so an email
// cannot steer Jarvis. Ids already announced are kept in email-alerts.json.

export const EMAIL_ALERTS_FILENAME = "email-alerts.json";
export const EMAIL_ALERTS_QUERY = "is:unread is:important newer_than:1d -category:promotions -category:social";
const DEFAULT_POLL_MS = 5 * 60_000;
const MAX_REMEMBERED = 500;
const MAX_NAMED = 3;
const MAX_SUBJECT = 80;
const SPEAK_WITHIN_MS = 30 * 60_000;

export interface EmailAlertsOptions {
  readonly search: (query: string) => Promise<readonly EmailSummary[]>;
  /** False while Gmail is not connected or not allowed; polls are then skipped. */
  readonly isAllowed: () => Promise<boolean>;
  readonly announce: (announcement: Announcement) => void;
  readonly language: string;
  readonly filePath: string;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

interface AlertsFile {
  readonly schemaVersion: 1;
  readonly seen: readonly string[];
}

/** "Ana Silva <ana@example.com>" → "Ana Silva"; a bare address → its local part. */
export function senderName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  if (named?.[1]) return named[1].trim();
  const address = /<?([^<>\s@]+)@[^<>\s]+>?/.exec(from);
  return address?.[1] ?? (from.trim() || "?");
}

function speakable(text: string, max: number): string {
  // Links and addresses are noise when spoken.
  const clean = text.replace(/https?:\/\/\S+/g, "").replace(/\S+@\S+\.\S+/g, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function emailAlertText(messages: readonly EmailSummary[], language: string): string {
  const portuguese = language.toLowerCase().startsWith("pt");
  if (messages.length === 1) {
    const [message] = messages as [EmailSummary];
    const subject = speakable(message.subject, MAX_SUBJECT);
    const from = speakable(senderName(message.from), 40);
    return portuguese ? `Novo email importante de ${from}: ${subject}.` : `New important email from ${from}: ${subject}.`;
  }
  const names = [...new Set(messages.map((message) => speakable(senderName(message.from), 40)))];
  const shown = names.slice(0, MAX_NAMED);
  const others = names.length - shown.length;
  const list = portuguese
    ? `${shown.join(", ")}${others > 0 ? ` e mais ${others}` : ""}`
    : `${shown.join(", ")}${others > 0 ? ` and ${others} more` : ""}`;
  return portuguese ? `Tens ${messages.length} emails importantes novos, de ${list}.` : `You have ${messages.length} new important emails, from ${list}.`;
}

export class EmailAlerts {
  readonly #options: EmailAlertsOptions;
  #seen: string[] = [];
  #primed = false;
  #poller: NodeJS.Timeout | null = null;
  #stopped = false;
  #failing = false;

  constructor(options: EmailAlertsOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#poller) return;
    this.#stopped = false;
    try {
      const stored = JSON.parse(await readFile(this.#options.filePath, "utf8")) as Partial<AlertsFile>;
      this.#seen = Array.isArray(stored.seen) ? stored.seen.filter((id): id is string => typeof id === "string") : [];
      this.#primed = true;
    } catch {
      // First run: the mail already waiting is not "new", so the first poll only records it.
      this.#primed = false;
    }
    void this.poll();
    this.#poller = setInterval(() => void this.poll(), this.#options.pollMs ?? DEFAULT_POLL_MS);
    this.#poller.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#poller) clearInterval(this.#poller);
    this.#poller = null;
  }

  /** Checks Gmail once; exposed for tests and for an immediate refresh. */
  async poll(): Promise<void> {
    try {
      if (this.#stopped || !(await this.#options.isAllowed())) return;
      const messages = await this.#options.search(EMAIL_ALERTS_QUERY);
      if (this.#stopped) return;
      this.#failing = false;
      const fresh = messages.filter((message) => !this.#seen.includes(message.id));
      if (fresh.length === 0 && this.#primed) return;
      this.#seen = [...fresh.map((message) => message.id), ...this.#seen].slice(0, MAX_REMEMBERED);
      await this.#save();
      const announce = this.#primed && fresh.length > 0;
      this.#primed = true;
      if (!announce) return;
      this.#options.announce({
        text: emailAlertText(fresh, this.#options.language),
        title: "Jarvis · Gmail",
        expiresAt: this.#now() + SPEAK_WITHIN_MS,
      });
    } catch (error) {
      // One notice per outage, not one every five minutes.
      if (!this.#failing) this.#options.onError?.(error);
      this.#failing = true;
    }
  }

  async #save(): Promise<void> {
    const { filePath } = this.#options;
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    const data: AlertsFile = { schemaVersion: 1, seen: this.#seen };
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
