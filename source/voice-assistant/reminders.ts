import type { CalendarEvent } from "./calendar.js";

// Proactive reminders: the calendar is polled every few minutes and every
// upcoming timed event gets its own timer at (start − lead). The text is built
// locally, so a reminder costs one Calendar request per poll and no Grok call.

const DEFAULT_POLL_MS = 5 * 60_000;
const MINUTE = 60_000;

export interface Reminder {
  readonly event: CalendarEvent;
  /** Whole minutes until the event starts when the reminder fires (0 = starting now). */
  readonly minutes: number;
  readonly text: string;
}

export interface EventRemindersOptions {
  readonly listEvents: (from: Date, to: Date) => Promise<CalendarEvent[]>;
  readonly isConnected: () => Promise<boolean>;
  readonly leadMinutes: number;
  readonly language: string;
  readonly announce: (reminder: Reminder) => void;
  /** Called once per run of consecutive failed polls, not every few minutes while offline. */
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  readonly pollMs?: number;
}

export function reminderText(event: CalendarEvent, minutes: number, language: string): string {
  const portuguese = language.toLowerCase().startsWith("pt");
  const where = event.location ? (portuguese ? `, em ${event.location}` : `, at ${event.location}`) : "";
  if (minutes <= 0) return portuguese ? `Está a começar agora: ${event.summary}${where}.` : `Starting now: ${event.summary}${where}.`;
  const unit = portuguese ? (minutes === 1 ? "minuto" : "minutos") : (minutes === 1 ? "minute" : "minutes");
  return portuguese ? `Daqui a ${minutes} ${unit} tens ${event.summary}${where}.` : `In ${minutes} ${unit} you have ${event.summary}${where}.`;
}

export class EventReminders {
  readonly #options: EventRemindersOptions;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #announced = new Map<string, number>();
  #poller: NodeJS.Timeout | null = null;
  #stopped = false;
  #failing = false;

  constructor(options: EventRemindersOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#poller) return;
    this.#stopped = false;
    void this.poll();
    this.#poller = setInterval(() => void this.poll(), this.#options.pollMs ?? DEFAULT_POLL_MS);
    this.#poller.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#poller) clearInterval(this.#poller);
    this.#poller = null;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Refreshes the timers from the calendar; exposed for tests and for an immediate refresh. */
  async poll(): Promise<void> {
    try {
      if (this.#stopped || !(await this.#options.isConnected())) return;
      const now = this.#now();
      const pollMs = this.#options.pollMs ?? DEFAULT_POLL_MS;
      // Look far enough ahead that the next poll cannot miss a reminder.
      const horizon = now + this.#options.leadMinutes * MINUTE + 2 * pollMs;
      const events = await this.#options.listEvents(new Date(now), new Date(horizon));
      if (this.#stopped) return;
      const seen = new Set<string>();
      for (const event of events) {
        const start = Date.parse(event.start);
        if (event.allDay || !Number.isFinite(start) || start <= now) continue;
        // Keyed by start time too, so a moved event is rescheduled rather than skipped.
        const key = `${event.id}@${start}`;
        seen.add(key);
        if (this.#announced.has(key) || this.#timers.has(key)) continue;
        const delay = Math.max(0, start - this.#options.leadMinutes * MINUTE - now);
        const timer = setTimeout(() => this.#fire(key, event, start), delay);
        timer.unref();
        this.#timers.set(key, timer);
      }
      // Cancelled or moved events lose their pending timer.
      for (const [key, timer] of this.#timers) {
        if (!seen.has(key)) {
          clearTimeout(timer);
          this.#timers.delete(key);
        }
      }
      for (const [key, start] of this.#announced) if (start < now) this.#announced.delete(key);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#options.onError?.(error);
      this.#failing = true;
    }
  }

  #fire(key: string, event: CalendarEvent, start: number): void {
    this.#timers.delete(key);
    if (this.#stopped || this.#announced.has(key)) return;
    this.#announced.set(key, start);
    const minutes = Math.max(0, Math.round((start - this.#now()) / MINUTE));
    this.#options.announce({ event, minutes, text: reminderText(event, minutes, this.#options.language) });
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
