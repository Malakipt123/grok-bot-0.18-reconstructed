import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantToolkit } from "./calendar.js";
import type { EmailSummary } from "./gmail.js";
import type { GrokTool } from "./grok.js";
import type { Announcement } from "./voice-reminders.js";

// "Novo email importante de Ana Silva: Contrato." Every few minutes Jarvis
// looks for unread mail that Gmail itself marks as important and says who it
// is from and the subject. Only those two headers are spoken, straight to
// speech: the body is never read and nothing goes through Grok, so an email
// cannot steer Jarvis. Ids already announced are kept in email-alerts.json.
//
// "Avisa-me sempre dos emails da Ana": senders on the user's own list are
// announced too, even when Gmail does not mark them important.

export const EMAIL_ALERTS_FILENAME = "email-alerts.json";
export const EMAIL_ALERTS_QUERY = "is:unread is:important newer_than:1d -category:promotions -category:social";
const MAX_VIPS = 30;
// A name or an address, as Gmail's from: accepts; no quotes, braces or operators.
const VIP = /^[\p{L}\p{N}][\p{L}\p{N} .@_+'-]{1,59}$/u;

/** The alert query: Gmail's important mail, plus anything unread from the user's own list. */
export function emailAlertsQuery(vips: readonly string[]): string {
  if (vips.length === 0) return EMAIL_ALERTS_QUERY;
  const senders = vips.map((vip) => `from:${vip.includes(" ") ? `"${vip}"` : vip}`).join(" ");
  return `is:unread newer_than:1d {${senders} (is:important -category:promotions -category:social)}`;
}

export const EMAIL_VIP_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "email_vip_add",
      description: "Always announce new email from this sender, even if Gmail does not mark it important. Use a name or an email address as it appears in Gmail.",
      parameters: { type: "object", properties: { sender: { type: "string" } }, required: ["sender"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "email_vip_list",
      description: "List the senders whose email is always announced.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "email_vip_remove",
      description: "Stop always announcing email from this sender.",
      parameters: { type: "object", properties: { sender: { type: "string" } }, required: ["sender"], additionalProperties: false },
    },
  },
];
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
  readonly vips?: readonly string[];
  /** False until a poll has recorded the mail already waiting; older files lack it and were primed. */
  readonly primed?: boolean;
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
  #vips: string[] = [];
  #loaded: Promise<void> | null = null;
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
    await this.#load();
    void this.poll();
    this.#poller = setInterval(() => void this.poll(), this.#options.pollMs ?? DEFAULT_POLL_MS);
    this.#poller.unref();
  }

  /** Senders always announced, as the user named them. */
  async vips(): Promise<readonly string[]> {
    await this.#load();
    return [...this.#vips];
  }

  async addVip(sender: string): Promise<string> {
    await this.#load();
    const clean = sender.replace(/\s+/g, " ").trim().replace(/^<|>$/g, "");
    if (!VIP.test(clean)) throw new Error(`Not a sender name or address Jarvis can watch for: ${JSON.stringify(sender)}`);
    if (this.#vips.some((vip) => vip.toLowerCase() === clean.toLowerCase())) return clean;
    if (this.#vips.length >= MAX_VIPS) throw new Error(`At most ${MAX_VIPS} senders can be on the list`);
    this.#vips = [...this.#vips, clean];
    await this.#save();
    return clean;
  }

  async removeVip(sender: string): Promise<string | null> {
    await this.#load();
    const target = this.#vips.find((vip) => vip.toLowerCase() === sender.trim().toLowerCase());
    if (!target) return null;
    this.#vips = this.#vips.filter((vip) => vip !== target);
    await this.#save();
    return target;
  }

  /** Grok tools for the always-announce list. */
  toolkit(): AssistantToolkit {
    const portuguese = this.#options.language.toLowerCase().startsWith("pt");
    return {
      tools: async () => ((await this.#options.isAllowed()) ? EMAIL_VIP_TOOLS : []),
      handles: (name) => EMAIL_VIP_TOOLS.some((tool) => tool.function.name === name),
      prompt: async () => ((await this.#options.isAllowed())
        ? "Jarvis announces new important email by itself. For \"always tell me about email from X\", call email_vip_add with that sender; email_vip_list and email_vip_remove manage the list."
        : ""),
      run: async (name, args) => {
        if (name === "email_vip_add") return `Added: ${await this.addVip(String(args.sender ?? ""))}. New email from them will be announced.`;
        if (name === "email_vip_list") {
          const vips = await this.vips();
          return vips.length === 0 ? (portuguese ? "A lista está vazia." : "The list is empty.") : vips.join(", ");
        }
        if (name === "email_vip_remove") {
          const removed = await this.removeVip(String(args.sender ?? ""));
          return removed ? `Removed: ${removed}.` : "That sender is not on the list.";
        }
        return `Error: unknown tool ${name}`;
      },
    };
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
      const messages = await this.#options.search(emailAlertsQuery(this.#vips));
      if (this.#stopped) return;
      this.#failing = false;
      const fresh = messages.filter((message) => !this.#seen.includes(message.id));
      if (fresh.length === 0 && this.#primed) return;
      this.#seen = [...fresh.map((message) => message.id), ...this.#seen].slice(0, MAX_REMEMBERED);
      const announce = this.#primed && fresh.length > 0;
      this.#primed = true;
      await this.#save();
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
    const data: AlertsFile = { schemaVersion: 1, seen: this.#seen, vips: this.#vips, primed: this.#primed };
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  }

  #load(): Promise<void> {
    this.#loaded ??= readFile(this.#options.filePath, "utf8").then((text) => {
      const stored = JSON.parse(text) as Partial<AlertsFile>;
      this.#seen = Array.isArray(stored.seen) ? stored.seen.filter((id): id is string => typeof id === "string") : [];
      this.#vips = Array.isArray(stored.vips) ? stored.vips.filter((vip): vip is string => typeof vip === "string" && VIP.test(vip)) : [];
      this.#primed = stored.primed !== false;
    }, () => {
      // First run: the mail already waiting is not "new", so the first poll only records it.
      this.#primed = false;
    });
    return this.#loaded;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
