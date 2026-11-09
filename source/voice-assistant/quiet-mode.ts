import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantToolkit } from "./calendar.js";
import type { GrokTool } from "./grok.js";
import { describeQuietHours, isQuietTime, type QuietHours } from "./quiet-hours.js";
import { parseLocalTime } from "./voice-reminders.js";

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
