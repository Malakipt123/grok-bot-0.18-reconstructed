import type { AssistantRoutine } from "./profile.js";

export interface RoutineSchedulerOptions {
  readonly routines: readonly AssistantRoutine[];
  readonly run: (routine: AssistantRoutine) => Promise<void>;
  readonly onError?: (routine: AssistantRoutine, error: unknown) => void;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}

/** Fires each routine at most once per local day, at or after its scheduled minute. */
export class RoutineScheduler {
  readonly #options: RoutineSchedulerOptions;
  readonly #lastRun = new Map<string, string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: RoutineSchedulerOptions) {
    this.#options = options;
    // Routines whose time already passed today wait until tomorrow instead of firing at startup.
    const now = this.#now();
    for (const routine of options.routines) {
      if (minutesOf(now) > routine.hour * 60 + routine.minute) this.#lastRun.set(key(routine), dayOf(now));
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? 30_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<AssistantRoutine[]> {
    const now = this.#now();
    const due = this.#options.routines.filter(
      (routine) => minutesOf(now) >= routine.hour * 60 + routine.minute && this.#lastRun.get(key(routine)) !== dayOf(now),
    );
    for (const routine of due) {
      this.#lastRun.set(key(routine), dayOf(now));
      try {
        await this.#options.run(routine);
      } catch (error) {
        this.#options.onError?.(routine, error);
      }
    }
    return due;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }
}

function key(routine: AssistantRoutine): string {
  return `${routine.time} ${routine.name}`;
}

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function dayOf(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
