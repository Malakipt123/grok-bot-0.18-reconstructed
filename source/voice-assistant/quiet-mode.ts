import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { zonedWallClockToDate, type AssistantToolkit } from "./calendar.js";
import type { GrokTool } from "./grok.js";
import { describeQuietHours, isQuietTime, type QuietHours } from "./quiet-hours.js";
import { parseLocalTime, type Announcement } from "./voice-reminders.js";

// "Modo silêncio até amanhã", "podes voltar a falar": a spoken override of the
// quiet hours. While it lasts, email and calendar alerts are silent (or, when
// switched off, spoken even inside the quiet hours). It ends on its own and is
// kept in quiet-mode.json so a restart does not forget it.

export const QUIET_MODE_FILENAME = "quiet-mode.json";
const DEFAULT_OVERRIDE_MS = 12 * 3_600_000;
const MAX_OVERRIDE_MS = 7 * 24 * 3_600_000;

interface QuietOverride {
  readonly quiet: boolean;
  /** Epoch ms when the override ends and the quiet hours apply again. */
  readonly until: number;
}

export const QUIET_MODE_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "quiet_mode_set",
      description: "Turn silent mode on (Jarvis stops announcing email and calendar alerts out loud; they become silent notifications) or off (alerts are spoken, even inside the usual quiet hours), until a local time. Without `until` it lasts 12 hours.",
      parameters: {
        type: "object",
        properties: {
          quiet: { type: "boolean" },
          until: { type: "string", description: "Local ISO date-time, e.g. 2026-11-10T08:00, computed from the current time." },
        },
        required: ["quiet"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quiet_mode_reset",
      description: "End any silent-mode override and go back to the usual quiet hours.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
];

/**
 * What Jarvis says when silent mode ends, about the alerts it kept quiet:
 * "Enquanto estiveste em silêncio chegaram 2 emails importantes, de Ana e
 * Banco, e houve 1 aviso de um evento: Reunião." Null when nothing was held.
 */
export function heldAlertsSummary(held: readonly Announcement[], language: string): string | null {
  if (held.length === 0) return null;
  const portuguese = language.toLowerCase().startsWith("pt");
  const emailAlerts = held.filter((announcement) => announcement.source === "email");
  const events = held.filter((announcement) => announcement.source === "calendar" && announcement.event);
  const senders = [...new Set(emailAlerts.flatMap((announcement) => announcement.senders ?? []))];
  const emails = emailAlerts.reduce((total, announcement) => total + (announcement.count ?? 1), 0);
  const names = (list: readonly string[]) => {
    const shown = list.slice(0, 3);
    const others = list.length - shown.length;
    return `${shown.join(", ")}${others > 0 ? (portuguese ? ` e mais ${others}` : ` and ${others} more`) : ""}`;
  };
  const parts: string[] = [];
  if (emails > 0) {
    parts.push(portuguese
      ? `${emails === 1 ? "chegou 1 email importante" : `chegaram ${emails} emails importantes`}${senders.length ? `, de ${names(senders)}` : ""}`
      : `${emails === 1 ? "1 important email arrived" : `${emails} important emails arrived`}${senders.length ? `, from ${names(senders)}` : ""}`);
  }
  if (events.length > 0) {
    const titles = [...new Set(events.map((announcement) => announcement.event!.summary))];
    parts.push(portuguese
      ? `${events.length === 1 ? "houve 1 aviso de um evento" : `houve ${events.length} avisos de eventos`}: ${names(titles)}`
      : `${events.length === 1 ? "there was 1 event reminder" : `there were ${events.length} event reminders`}: ${names(titles)}`);
  }
  if (parts.length === 0) return null;
  return portuguese ? `Enquanto estiveste em silêncio ${parts.join(", e ")}.` : `While you were in silent mode, ${parts.join(", and ")}.`;
}

export class QuietMode {
  readonly #hours: QuietHours | null;
  readonly #timeZone: string;
  readonly #filePath: string;
  readonly #language: string;
  readonly #now: () => number;
  #override: QuietOverride | null = null;

  private constructor(options: { hours: QuietHours | null; timeZone: string; filePath: string; language: string; now?: () => number }, override: QuietOverride | null) {
    this.#hours = options.hours;
    this.#timeZone = options.timeZone;
    this.#filePath = options.filePath;
    this.#language = options.language;
    this.#now = options.now ?? Date.now;
    this.#override = override;
  }

  static async open(options: { hours: QuietHours | null; timeZone: string; filePath: string; language: string; now?: () => number }): Promise<QuietMode> {
    const override = await readFile(options.filePath, "utf8").then((text) => {
      const data = JSON.parse(text) as Partial<QuietOverride>;
      return typeof data.quiet === "boolean" && typeof data.until === "number" ? { quiet: data.quiet, until: data.until } : null;
    }, () => null).catch(() => null);
    return new QuietMode(options, override);
  }

  /** Whether proactive alerts should be silent right now. */
  isQuiet(now = this.#now()): boolean {
    const override = this.#activeOverride(now);
    return override ? override.quiet : isQuietTime(this.#hours, new Date(now), this.#timeZone);
  }

  async set(quiet: boolean, until?: Date): Promise<QuietOverride> {
    const now = this.#now();
    const end = until ? until.getTime() : now + DEFAULT_OVERRIDE_MS;
    if (!Number.isFinite(end) || end <= now) throw new Error("That time has already passed");
    const override = { quiet, until: Math.min(end, now + MAX_OVERRIDE_MS) };
    await this.#save(override);
    this.#override = override;
    return override;
  }

  async reset(): Promise<void> {
    await this.#save(null);
    this.#override = null;
  }

  /** When the quiet hours next end (tomorrow morning), or 08:00 if there are none. */
  nextMorning(now = this.#now()): Date {
    const end = this.#hours?.end ?? 8 * 60;
    const clock = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}:00`;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: this.#timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
    let candidate = zonedWallClockToDate(`${today}T${clock}`, this.#timeZone);
    for (let day = 1; candidate.getTime() <= now && day <= 2; day += 1) {
      const next = new Intl.DateTimeFormat("en-CA", { timeZone: this.#timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now + day * 24 * 3_600_000));
      candidate = zonedWallClockToDate(`${next}T${clock}`, this.#timeZone);
    }
    return candidate;
  }

  /** A short status for menus: "🔕 Silêncio até 15:00", "🔔 Avisos com voz". */
  label(now = this.#now()): string {
    const portuguese = this.#language.toLowerCase().startsWith("pt");
    const override = this.#activeOverride(now);
    const quiet = this.isQuiet(now);
    const clock = (epoch: number) => new Date(epoch).toLocaleTimeString(this.#language, { hour: "2-digit", minute: "2-digit", timeZone: this.#timeZone });
    if (override) {
      return portuguese
        ? `${quiet ? "🔕 Silêncio" : "🔔 Avisos com voz"} até ${clock(override.until)}`
        : `${quiet ? "🔕 Silent" : "🔔 Alerts spoken"} until ${clock(override.until)}`;
    }
    return portuguese
      ? (quiet ? "🔕 Silêncio (horário habitual)" : "🔔 Avisos com voz")
      : (quiet ? "🔕 Silent (usual hours)" : "🔔 Alerts spoken");
  }

  describe(now = this.#now()): string {
    const override = this.#activeOverride(now);
    const hours = this.#hours ? `usual quiet hours ${describeQuietHours(this.#hours)}` : "no usual quiet hours";
    if (!override) return `Silent mode follows the ${hours}; it is ${this.isQuiet(now) ? "on" : "off"} now.`;
    return `Silent mode is ${override.quiet ? "on" : "off"} until ${this.#time(override.until)} (then back to the ${hours}).`;
  }

  toolkit(): AssistantToolkit {
    return {
      tools: async () => QUIET_MODE_TOOLS,
      handles: (name) => QUIET_MODE_TOOLS.some((tool) => tool.function.name === name),
      prompt: async () => `${this.describe()} For "modo silêncio", "não me interrompas até às 15h" or "podes voltar a avisar", call quiet_mode_set (or quiet_mode_reset) and confirm until when. Silent mode only affects alerts Jarvis starts by itself; replies and the user's own reminders are still spoken.`,
      run: async (name, args) => {
        if (name === "quiet_mode_set") {
          const until = typeof args.until === "string" && args.until.trim() ? parseLocalTime(args.until, this.#timeZone) : undefined;
          const override = await this.set(Boolean(args.quiet), until);
          return `Silent mode ${override.quiet ? "on" : "off"} until ${this.#time(override.until)}.`;
        }
        if (name === "quiet_mode_reset") {
          await this.reset();
          return this.describe();
        }
        return `Error: unknown tool ${name}`;
      },
    };
  }

  #activeOverride(now: number): QuietOverride | null {
    return this.#override && this.#override.until > now ? this.#override : null;
  }

  #time(epoch: number): string {
    return new Date(epoch).toLocaleString(this.#language, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: this.#timeZone });
  }

  async #save(override: QuietOverride | null): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(override ?? {})}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#filePath);
  }
}
