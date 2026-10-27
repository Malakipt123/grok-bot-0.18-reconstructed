import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantToolkit } from "./calendar.js";
import type { GrokTool } from "./grok.js";
import { normalizeSymbol, round, type IntradayBars, type Market } from "./markets.js";
import type { Announcement } from "./voice-reminders.js";

// "A BTC passou acima de 70000 USD: está a 70120." The user sets alerts by
// voice; every two minutes Jarvis checks the prices and speaks the ones that
// fired, straight to speech without Grok. Price levels fire once and are
// removed; moves ("caiu 3% na última hora") repeat at most once an hour.

export const PRICE_ALERTS_FILENAME = "price-alerts.json";
const DEFAULT_POLL_MS = 2 * 60_000;
const MAX_ALERTS = 20;
const MOVE_WINDOW_MINUTES = 60;
const MOVE_COOLDOWN_MS = 60 * 60_000;
const SPEAK_WITHIN_MS = 10 * 60_000;

export type PriceAlertKind = "above" | "below" | "move";

export interface PriceAlert {
  readonly id: string;
  readonly market: Market;
  readonly symbol: string;
  readonly kind: PriceAlertKind;
  /** Level for above/below. */
  readonly price?: number;
  /** Absolute % change over the last hour for move. */
  readonly percent?: number;
  readonly lastFiredAt?: number;
}

interface AlertsFile {
  readonly schemaVersion: 1;
  readonly nextId: number;
  readonly alerts: readonly PriceAlert[];
}

export interface PriceAlertsOptions {
  readonly intraday: (market: Market, symbol: string) => Promise<IntradayBars>;
  readonly announce: (announcement: Announcement) => void;
  readonly language: string;
  readonly filePath: string;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

const SYMBOL_PROPERTIES = {
  market: { type: "string", enum: ["stock", "crypto"] },
  symbol: { type: "string", description: "Yahoo Finance ticker (AAPL, EDP.LS) or coin/Binance pair (BTC, ETHUSDT)." },
};

export const PRICE_ALERT_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "price_alert_add",
      description: "Speak an alert when a stock or crypto crosses a price (above/below, fires once) or moves by a percentage within an hour (move, up or down, at most once an hour).",
      parameters: {
        type: "object",
        properties: {
          ...SYMBOL_PROPERTIES,
          kind: { type: "string", enum: ["above", "below", "move"] },
          price: { type: "number", description: "Price level, for above and below." },
          percent: { type: "number", exclusiveMinimum: 0, maximum: 50, description: "Percentage, for move." },
        },
        required: ["market", "symbol", "kind"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "price_alert_list",
      description: "List the active price alerts with their ids.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "price_alert_remove",
      description: "Remove a price alert by id, or every alert with id \"all\".",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
];

/** "BTCUSDT" → "BTC": the quote currency is said separately. */
function spokenSymbol(symbol: string): string {
  return symbol.replace(/(?:USDT|USDC)$/, "");
}

function describe(alert: PriceAlert): string {
  const what = alert.kind === "move" ? `moves ${alert.percent}% within an hour` : `${alert.kind} ${round(alert.price!)}`;
  return `[${alert.id}] ${alert.market} ${alert.symbol} ${what}`;
}

/** % change between the last close and the close about an hour earlier. */
export function hourlyMove(bars: IntradayBars["bars"]): number | null {
  const last = bars.at(-1);
  if (!last) return null;
  const since = last.time - MOVE_WINDOW_MINUTES * 60_000;
  const base = bars.find((bar) => bar.time >= since);
  if (!base || base === last) return null;
  return ((last.close - base.close) / base.close) * 100;
}

export function priceAlertText(alert: PriceAlert, price: number, currency: string, move: number | null, language: string): string {
  const portuguese = language.toLowerCase().startsWith("pt");
  const name = spokenSymbol(alert.symbol);
  const now = `${round(price)} ${currency}`;
  if (alert.kind === "move") {
    const change = `${Math.abs(move ?? 0).toFixed(1)}%`;
    if (portuguese) return `A ${name} ${(move ?? 0) >= 0 ? "subiu" : "caiu"} ${change} na última hora: está a ${now}.`;
    return `${name} is ${(move ?? 0) >= 0 ? "up" : "down"} ${change} in the last hour, at ${now}.`;
  }
  const level = `${round(alert.price!)} ${currency}`;
  if (portuguese) return `A ${name} passou ${alert.kind === "above" ? "acima" : "abaixo"} de ${level}: está a ${now}.`;
  return `${name} is now ${alert.kind} ${level}, at ${now}.`;
}

export class PriceAlerts {
  readonly #options: PriceAlertsOptions;
  #data: AlertsFile = { schemaVersion: 1, nextId: 1, alerts: [] };
  #poller: NodeJS.Timeout | null = null;
  #loaded: Promise<void> | null = null;
  #failing = false;

  constructor(options: PriceAlertsOptions) {
    this.#options = options;
  }

  get alerts(): readonly PriceAlert[] {
    return this.#data.alerts;
  }

  async load(): Promise<void> {
    this.#loaded ??= readFile(this.#options.filePath, "utf8").then(
      (text) => {
        const stored = JSON.parse(text) as Partial<AlertsFile>;
        const alerts = Array.isArray(stored.alerts) ? stored.alerts.filter((alert) => typeof alert?.id === "string" && typeof alert.symbol === "string") : [];
        this.#data = { schemaVersion: 1, nextId: Number(stored.nextId) || alerts.length + 1, alerts };
      },
      () => undefined,
    );
    await this.#loaded;
  }

  async start(): Promise<void> {
    if (this.#poller) return;
    await this.load();
    this.#poller = setInterval(() => void this.poll(), this.#options.pollMs ?? DEFAULT_POLL_MS);
    this.#poller.unref();
  }

  stop(): void {
    if (this.#poller) clearInterval(this.#poller);
    this.#poller = null;
  }

  async add(market: Market, rawSymbol: string, kind: PriceAlertKind, level?: number, percent?: number): Promise<PriceAlert> {
    await this.load();
    if (this.#data.alerts.length >= MAX_ALERTS) throw new Error(`At most ${MAX_ALERTS} price alerts; remove one first`);
    const symbol = normalizeSymbol(market, rawSymbol);
    let alert: PriceAlert;
    if (kind === "move") {
      if (!(typeof percent === "number" && percent > 0 && percent <= 50)) throw new Error("A move alert needs a percentage between 0 and 50");
      alert = { id: `p${this.#data.nextId}`, market, symbol, kind, percent };
    } else {
      if (!(typeof level === "number" && level > 0)) throw new Error("An above/below alert needs a positive price");
      // An alert that is already true would fire at once; say so instead.
      const last = (await this.#options.intraday(market, symbol)).bars.at(-1)?.close;
      if (last !== undefined && (kind === "above" ? last >= level : last <= level)) {
        throw new Error(`${symbol} is already ${kind} ${round(level)} (now ${round(last)})`);
      }
      alert = { id: `p${this.#data.nextId}`, market, symbol, kind, price: level };
    }
    await this.#save({ ...this.#data, nextId: this.#data.nextId + 1, alerts: [...this.#data.alerts, alert] });
    return alert;
  }

  async remove(id: string): Promise<number> {
    await this.load();
    const kept = id === "all" ? [] : this.#data.alerts.filter((alert) => alert.id !== id);
    const removed = this.#data.alerts.length - kept.length;
    if (removed > 0) await this.#save({ ...this.#data, alerts: kept });
    return removed;
  }

  /** Checks every alert once; exposed for tests and an immediate refresh. */
  async poll(): Promise<void> {
    try {
      await this.load();
      if (this.#data.alerts.length === 0) return;
      const now = this.#now();
      const bySymbol = new Map<string, PriceAlert[]>();
      for (const alert of this.#data.alerts) {
        const key = `${alert.market}:${alert.symbol}`;
        bySymbol.set(key, [...(bySymbol.get(key) ?? []), alert]);
      }
      const fired = new Map<string, PriceAlert | null>();
      const texts: string[] = [];
      for (const alerts of bySymbol.values()) {
        const { market, symbol } = alerts[0]!;
        const data = await this.#options.intraday(market, symbol);
        const price = data.bars.at(-1)?.close;
        if (price === undefined) continue;
        const move = hourlyMove(data.bars);
        for (const alert of alerts) {
          if (alert.kind === "move") {
            const cooling = alert.lastFiredAt !== undefined && now - alert.lastFiredAt < MOVE_COOLDOWN_MS;
            if (cooling || move === null || Math.abs(move) < alert.percent!) continue;
            fired.set(alert.id, { ...alert, lastFiredAt: now });
          } else {
            if (alert.kind === "above" ? price < alert.price! : price > alert.price!) continue;
            fired.set(alert.id, null);
          }
          texts.push(priceAlertText(alert, price, data.currency, move, this.#options.language));
        }
      }
      this.#failing = false;
      if (texts.length === 0) return;
      // Saved before speaking, so a crash cannot repeat a one-shot alert.
      const alerts = this.#data.alerts.flatMap((alert) => {
        if (!fired.has(alert.id)) return [alert];
        const updated = fired.get(alert.id);
        return updated ? [updated] : [];
      });
      await this.#save({ ...this.#data, alerts });
      this.#options.announce({ text: texts.join(" "), title: "Jarvis · Mercados", expiresAt: now + SPEAK_WITHIN_MS });
    } catch (error) {
      if (!this.#failing) this.#options.onError?.(error);
      this.#failing = true;
    }
  }

  toolkit(): AssistantToolkit {
    return {
      tools: async () => PRICE_ALERT_TOOLS,
      handles: (name) => PRICE_ALERT_TOOLS.some((tool) => tool.function.name === name),
      prompt: async () => {
        await this.load();
        const active = this.#data.alerts.map(describe).join("; ");
        return `You can set spoken price alerts with price_alert_add; they are checked every two minutes while Jarvis runs. ${active ? `Active alerts: ${active}.` : "No price alerts are set."} Confirm a new alert in one short sentence without reading its id.`;
      },
      run: async (name, args) => {
        if (name === "price_alert_add") {
          const kind = args.kind === "above" || args.kind === "below" || args.kind === "move" ? args.kind : null;
          if (!kind) return "Error: kind must be above, below or move";
          const market: Market = args.market === "crypto" ? "crypto" : "stock";
          const alert = await this.add(market, String(args.symbol ?? ""), kind,
            typeof args.price === "number" ? args.price : undefined,
            typeof args.percent === "number" ? args.percent : undefined);
          return `Alert set: ${describe(alert)}.`;
        }
        if (name === "price_alert_list") {
          await this.load();
          return this.#data.alerts.length ? this.#data.alerts.map(describe).join("\n") : "No price alerts.";
        }
        if (name === "price_alert_remove") {
          const removed = await this.remove(String(args.id ?? ""));
          return removed > 0 ? `Removed ${removed} alert${removed === 1 ? "" : "s"}.` : "No alert with that id.";
        }
        return `Error: unknown tool ${name}`;
      },
    };
  }

  async #save(data: AlertsFile): Promise<void> {
    const { filePath } = this.#options;
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    this.#data = data;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
