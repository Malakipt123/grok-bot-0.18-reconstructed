import type { AssistantToolkit } from "./calendar.js";
import type { GrokTool } from "./grok.js";

// Paper-trading helpers: live prices and a Monte Carlo "time machine" that
// replays the rest of the session from today's one-minute bars. Nothing here
// can place an order; the public endpoints used need no account or key.

export type Market = "stock" | "crypto";

export interface Bar {
  readonly time: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface IntradayBars {
  readonly symbol: string;
  readonly currency: string;
  readonly bars: readonly Bar[];
  /** Minutes until the regular session closes, or null when it never closes (crypto) or is closed. */
  readonly minutesToClose: number | null;
}

export interface Quote {
  readonly symbol: string;
  readonly currency: string;
  readonly price: number;
  readonly changePct: number;
  /** What the change is measured against, for the spoken answer. */
  readonly changeBasis: "previous close" | "24 hours";
}

export interface ReplayInput {
  readonly bars: readonly Bar[];
  readonly entry: number;
  readonly target: number;
  readonly stop: number;
  readonly barsLeft: number;
  readonly runs?: number;
  readonly block?: number;
  readonly seed?: number;
}

export interface ReplayResult {
  readonly runs: number;
  readonly barsLeft: number;
  readonly side: "long" | "short";
  readonly hitTargetPct: number;
  readonly hitStopPct: number;
  readonly neitherPct: number;
  readonly rewardToRisk: number;
  readonly expectedPnlPerUnit: number;
  readonly endPrice: { readonly p10: number; readonly p50: number; readonly p90: number };
}

const DEFAULT_HORIZON_MINUTES = 240;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_HORIZON_MINUTES = 1_440;
const CRYPTO_ALIASES: Record<string, string> = {
  BITCOIN: "BTCUSDT", BTC: "BTCUSDT",
  ETHEREUM: "ETHUSDT", ETH: "ETHUSDT",
  SOLANA: "SOLUSDT", SOL: "SOLUSDT",
  XRP: "XRPUSDT", DOGE: "DOGEUSDT", DOGECOIN: "DOGEUSDT",
  CARDANO: "ADAUSDT", ADA: "ADAUSDT",
};
const STOCK_SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/;
const CRYPTO_PAIR = /^[A-Z0-9]{2,12}(?:USDT|USDC|EUR|BTC)$/;

const SYMBOL_PARAMETERS = {
  market: { type: "string", enum: ["stock", "crypto"], description: "stock for shares, ETFs and indices; crypto for coins." },
  symbol: { type: "string", description: "Yahoo Finance ticker for stocks (AAPL, NVDA, EDP.LS, ^GSPC) or a coin or Binance pair for crypto (BTC, ETHUSDT)." },
};

export const MARKET_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "market_price",
      description: "Get the latest price of a stock or crypto and today's change, from public market data.",
      parameters: { type: "object", properties: SYMBOL_PARAMETERS, required: ["market", "symbol"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_trade",
      description: "Paper-trade time machine: replay the rest of the session 10,000 times from today's one-minute bars and report how often the target or the stop is hit first. Never places an order.",
      parameters: {
        type: "object",
        properties: {
          ...SYMBOL_PARAMETERS,
          target: { type: "number", description: "Take-profit price." },
          stop: { type: "number", description: "Stop-loss price, on the other side of the entry." },
          entry: { type: "number", description: "Entry price; omit to use the latest price." },
          horizon_minutes: { type: "integer", minimum: 1, maximum: MAX_HORIZON_MINUTES, description: "Minutes to simulate; omit for the rest of the stock session, or 4 hours for crypto." },
        },
        required: ["market", "symbol", "target", "stop"],
        additionalProperties: false,
      },
    },
  },
];

export function normalizeSymbol(market: Market, raw: string): string {
  const symbol = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (market === "crypto") {
    const pair = CRYPTO_ALIASES[symbol] ?? (CRYPTO_PAIR.test(symbol) ? symbol : `${symbol}USDT`);
    if (!CRYPTO_PAIR.test(pair)) throw new Error(`Not a crypto symbol: ${JSON.stringify(raw)}`);
    return pair;
  }
  if (!STOCK_SYMBOL.test(symbol)) throw new Error(`Not a stock ticker: ${JSON.stringify(raw)}`);
  return symbol;
}

export interface MarketDataOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export class MarketData {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(options: MarketDataOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async quote(market: Market, rawSymbol: string): Promise<Quote> {
    const symbol = normalizeSymbol(market, rawSymbol);
    if (market === "crypto") {
      const ticker = (await this.#json(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`)) as { lastPrice?: string; priceChangePercent?: string };
      const price = Number(ticker.lastPrice);
      if (!(price > 0)) throw new Error(`No market data for ${symbol}`);
      return { symbol, currency: cryptoCurrency(symbol), price, changePct: Number(ticker.priceChangePercent) || 0, changeBasis: "24 hours" };
    }
    const meta = (await this.#yahooChart(symbol)).meta;
    const price = meta?.regularMarketPrice;
    const previous = meta?.chartPreviousClose ?? meta?.previousClose;
    if (typeof price !== "number" || !(price > 0)) throw new Error(`No market data for ${symbol}`);
    const changePct = typeof previous === "number" && previous > 0 ? ((price - previous) / previous) * 100 : 0;
    return { symbol, currency: meta?.currency ?? "USD", price, changePct, changeBasis: "previous close" };
  }

  async intraday(market: Market, rawSymbol: string): Promise<IntradayBars> {
    const symbol = normalizeSymbol(market, rawSymbol);
    return market === "crypto" ? this.#binance(symbol) : this.#yahoo(symbol);
  }

  async #yahooChart(symbol: string): Promise<YahooResult> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const body = (await this.#json(url)) as YahooChart;
    const result = body.chart?.result?.[0];
    if (!result) throw new Error(`No market data for ${symbol}${body.chart?.error?.description ? `: ${body.chart.error.description}` : ""}`);
    return result;
  }

  async #yahoo(symbol: string): Promise<IntradayBars> {
    const result = await this.#yahooChart(symbol);
    const quote = result.indicators?.quote?.[0];
    const times = result.timestamp ?? [];
    const bars: Bar[] = [];
    times.forEach((time, index) => {
      const close = quote?.close?.[index];
      if (typeof close !== "number" || !(close > 0)) return;
      const high = quote?.high?.[index];
      const low = quote?.low?.[index];
      bars.push({ time: time * 1000, close, high: typeof high === "number" ? high : close, low: typeof low === "number" ? low : close });
    });
    const end = result.meta?.currentTradingPeriod?.regular?.end;
    const minutes = typeof end === "number" ? Math.floor((end * 1000 - this.#now().getTime()) / 60_000) : null;
    return { symbol, currency: result.meta?.currency ?? "USD", bars, minutesToClose: minutes !== null && minutes > 0 ? minutes : null };
  }

  async #binance(symbol: string): Promise<IntradayBars> {
    // The public market-data mirror: same data as api.binance.com, no key, fewer regional blocks.
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000`;
    const rows = (await this.#json(url)) as unknown;
    if (!Array.isArray(rows)) throw new Error(`No market data for ${symbol}`);
    const bars = rows.map((row: unknown[]) => ({ time: Number(row[0]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]) }))
      .filter((bar) => bar.close > 0);
    return { symbol, currency: cryptoCurrency(symbol), bars, minutesToClose: null };
  }

  async #json(url: string): Promise<unknown> {
    // A stalled market API must not leave Jarvis silent mid-reply.
    const response = await this.#fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (Jarvis paper trading)" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`Market data request failed (${response.status})`);
    return response.json();
  }
}

interface YahooResult {
  meta?: {
    currency?: string;
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    currentTradingPeriod?: { regular?: { end?: number } };
  };
  timestamp?: number[];
  indicators?: { quote?: Array<{ high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> };
}

interface YahooChart {
  chart?: { result?: YahooResult[]; error?: { description?: string } | null };
}

function cryptoCurrency(pair: string): string {
  return pair.endsWith("EUR") ? "EUR" : pair.endsWith("BTC") ? "BTC" : "USD";
}

/** mulberry32: small, fast and seedable, so the same question gives the same answer. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Block-bootstraps today's bar-to-bar returns (keeping each bar's wicks) to
 * replay the next `barsLeft` bars many times. A bar that touches both the
 * target and the stop counts as the stop, the conservative reading.
 */
export function replayTrade(input: ReplayInput): ReplayResult {
  const { bars, entry, target, stop, barsLeft } = input;
  const runs = input.runs ?? 10_000;
  const long = target > entry;
  if (![entry, target, stop].every((value) => Number.isFinite(value) && value > 0)) throw new Error("Entry, target and stop must be positive prices");
  if (long ? !(stop < entry) : !(stop > entry && target < entry)) throw new Error("The stop must be on the other side of the entry from the target");
  if (!Number.isInteger(barsLeft) || barsLeft < 1) throw new Error("Nothing left to simulate");
  if (bars.length < 3) throw new Error("Not enough bars today to simulate yet");

  const steps = bars.slice(1).map((bar, index) => ({
    r: Math.log(bar.close / bars[index]!.close),
    up: Math.log(Math.max(bar.high, bar.close) / bar.close),
    down: Math.log(bar.close / Math.min(bar.low, bar.close)),
  }));
  const next = random(input.seed ?? 42);
  const block = Math.max(1, Math.min(input.block ?? 5, steps.length));
  const ends = new Float64Array(runs);
  let hitTarget = 0;
  let hitStop = 0;

  for (let run = 0; run < runs; run += 1) {
    let price = entry;
    let outcome = 0;
    let start = 0;
    for (let t = 0; t < barsLeft && outcome === 0; t += 1) {
      if (t % block === 0) start = Math.floor(next() * (steps.length - block + 1));
      const step = steps[start + (t % block)]!;
      price *= Math.exp(step.r);
      const high = price * Math.exp(step.up);
      const low = price / Math.exp(step.down);
      if (long ? low <= stop : high >= stop) outcome = -1;
      else if (long ? high >= target : low <= target) outcome = 1;
    }
    if (outcome === 1) hitTarget += 1;
    else if (outcome === -1) hitStop += 1;
    ends[run] = outcome === 1 ? target : outcome === -1 ? stop : price;
  }

  const sign = long ? 1 : -1;
  let pnl = 0;
  for (const end of ends) pnl += sign * (end - entry);
  ends.sort();
  const pct = (count: number) => Math.round((count / runs) * 1000) / 10;
  const quantile = (q: number) => ends[Math.min(runs - 1, Math.floor(q * runs))]!;
  return {
    runs,
    barsLeft,
    side: long ? "long" : "short",
    hitTargetPct: pct(hitTarget),
    hitStopPct: pct(hitStop),
    neitherPct: pct(runs - hitTarget - hitStop),
    rewardToRisk: Math.round((Math.abs(target - entry) / Math.abs(entry - stop)) * 100) / 100,
    expectedPnlPerUnit: Math.round((pnl / runs) * 10_000) / 10_000,
    endPrice: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
  };
}

export function round(value: number): string {
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return String(Number(value.toFixed(digits)));
}

export interface MarketToolkitOptions {
  readonly data?: MarketData;
}

export function createMarketToolkit(options: MarketToolkitOptions = {}): AssistantToolkit {
  const data = options.data ?? new MarketData();
  return {
    tools: async () => MARKET_TOOLS,
    handles: (name) => MARKET_TOOLS.some((tool) => tool.function.name === name),
    prompt: async () => [
      "You can check stock and crypto prices with market_price and test a trade idea on paper with simulate_trade.",
      "You never place, change or cancel real orders and have no access to any brokerage account; if asked to, say so in one sentence.",
      "Before simulate_trade you need a target and a stop; ask for whichever is missing. Report target-first and stop-first percentages and the reward to risk in one or two spoken sentences, say it is a simulation of today's volatility and not advice, and do not read every number.",
    ].join(" "),
    async run(name, args) {
      const market: Market = args.market === "crypto" ? "crypto" : "stock";
      const symbol = String(args.symbol ?? "");
      if (name === "market_price") {
        const quote = await data.quote(market, symbol);
        return `${quote.symbol} last ${round(quote.price)} ${quote.currency}, ${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}% vs ${quote.changeBasis}.`;
      }
      if (name === "simulate_trade") {
        const intraday = await data.intraday(market, symbol);
        const last = intraday.bars.at(-1);
        if (!last) return `No trades for ${intraday.symbol} today yet.`;
        const requested = Number(args.horizon_minutes);
        const horizon = Number.isInteger(requested) && requested > 0
          ? Math.min(requested, MAX_HORIZON_MINUTES)
          : intraday.minutesToClose ?? DEFAULT_HORIZON_MINUTES;
        const entry = args.entry === undefined ? last.close : Number(args.entry);
        const result = replayTrade({ bars: intraday.bars, entry, target: Number(args.target), stop: Number(args.stop), barsLeft: horizon });
        return [
          `Paper simulation for ${intraday.symbol} (${result.side}), entry ${round(entry)} ${intraday.currency}, target ${round(Number(args.target))}, stop ${round(Number(args.stop))}.`,
          `${result.runs} replays of the next ${horizon} minutes from ${intraday.bars.length} one-minute bars today:`,
          `target first ${result.hitTargetPct}%, stop first ${result.hitStopPct}%, neither ${result.neitherPct}%.`,
          `Reward to risk ${result.rewardToRisk}; expected result ${result.expectedPnlPerUnit} per unit; end price p10 ${round(result.endPrice.p10)}, median ${round(result.endPrice.p50)}, p90 ${round(result.endPrice.p90)}.`,
        ].join(" ");
      }
      return `Error: unknown tool ${name}`;
    },
  };
}
