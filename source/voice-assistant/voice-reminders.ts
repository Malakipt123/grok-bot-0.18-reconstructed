import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { toEventTime, zonedWallClockToDate, type AssistantToolkit, type CalendarEvent } from "./calendar.js";
import type { GrokTool } from "./grok.js";
import { reminderText } from "./reminders.js";

// Reminders set by voice ("lembra-me de ligar à Ana às 17h") and snoozes of
// any announcement ("adia 5 minutos"). They live in reminders.json next to
// ASSISTANT.md, so they survive restarts; each pending one has its own timer.

export const VOICE_REMINDERS_FILENAME = "reminders.json";
const MINUTE = 60_000;
/** setTimeout overflows past ~24.8 days; far reminders re-arm in steps. */
const MAX_TIMER_MS = 6 * 60 * MINUTE;
/** Reminders missed while Jarvis was closed are still said if at most this late. */
const MAX_LATE_MS = 12 * 60 * MINUTE;
const MAX_PENDING = 200;
const MAX_TEXT = 200;

export interface VoiceReminder {
  readonly id: string;
  readonly text: string;
  /** ISO instant the reminder is due. */
  readonly at: string;
  readonly createdAt: string;
  /** Set for a snoozed calendar reminder, so the re-announcement counts the minutes left again. */
  readonly event?: CalendarEvent;
}

/** Something Jarvis says on its own: a calendar reminder, a voice reminder or a snooze. */
export interface Announcement {
  readonly text: string;
  /** Notification title used when it can no longer be spoken in time. */
  readonly title: string;
  /** After this instant (ms) speaking it is pointless; it becomes a silent notification. */
  readonly expiresAt: number;
  readonly event?: CalendarEvent;
  readonly reminder?: VoiceReminder;
}

interface ReminderFile {
  readonly schemaVersion: 1;
  readonly nextId: number;
  readonly reminders: readonly VoiceReminder[];
}

export interface VoiceRemindersOptions {
  readonly filePath: string;
  readonly language: string;
  readonly timeZone: string;
  readonly announce: (announcement: Announcement) => void;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

function isReminder(value: unknown): value is VoiceReminder {
  if (typeof value !== "object" || value == null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.text === "string" && typeof record.at === "string"
    && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.at));
}

export function voiceReminderText(reminder: VoiceReminder, language: string, now: number, lateMs = 0): string {
  const portuguese = language.toLowerCase().startsWith("pt");
  if (reminder.event) return reminderText(reminder.event, Math.max(0, Math.round((Date.parse(reminder.event.start) - now) / MINUTE)), language);
  if (lateMs > MINUTE) return portuguese ? `Ficou por dizer um lembrete: ${reminder.text}.` : `A reminder you missed: ${reminder.text}.`;
  return portuguese ? `Lembrete: ${reminder.text}.` : `Reminder: ${reminder.text}.`;
}

export class VoiceReminders {
  readonly #options: VoiceRemindersOptions;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #data: ReminderFile = { schemaVersion: 1, nextId: 1, reminders: [] };
  #writes: Promise<void> = Promise.resolve();
  #started = false;
  #lastAnnouncement: { announcement: Announcement; at: number } | null = null;

  constructor(options: VoiceRemindersOptions) {
    this.#options = options;
  }

  /** Loads saved reminders, announces ones missed while closed, and arms the rest. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      const parsed = JSON.parse(await readFile(this.#options.filePath, "utf8")) as Partial<ReminderFile>;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.reminders)) {
        const reminders = parsed.reminders.filter(isReminder);
        const highest = reminders.reduce((max, reminder) => Math.max(max, Number(reminder.id.slice(1)) || 0), 0);
        this.#data = { schemaVersion: 1, nextId: Math.max(Number(parsed.nextId) || 1, highest + 1), reminders };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#options.onError?.(error);
    }
    const now = this.#now();
    const stale = this.#data.reminders.filter((reminder) => now - Date.parse(reminder.at) > MAX_LATE_MS);
    if (stale.length > 0) {
      this.#data = { ...this.#data, reminders: this.#data.reminders.filter((reminder) => !stale.includes(reminder)) };
      await this.#save().catch((error: unknown) => this.#options.onError?.(error));
    }
    for (const reminder of this.#data.reminders) this.#arm(reminder);
  }

  stop(): void {
    this.#started = false;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  get pending(): readonly VoiceReminder[] {
    return [...this.#data.reminders].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  }

  /** Records what Jarvis just announced, so "adia 5 minutos" knows what to repeat. */
  noteAnnounced(announcement: Announcement): void {
    this.#lastAnnouncement = { announcement, at: this.#now() };
  }

  async add(text: string, at: Date, event?: CalendarEvent): Promise<VoiceReminder> {
    const clean = text.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
    if (!clean) throw new Error("A reminder needs something to remind");
    if (clean.length > MAX_TEXT) throw new Error(`Keep a reminder under ${MAX_TEXT} characters`);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid reminder time");
    if (at.getTime() < this.#now() - MINUTE) throw new Error("That time has already passed");
    if (this.#data.reminders.length >= MAX_PENDING) throw new Error(`At most ${MAX_PENDING} reminders can be pending`);
    const reminder: VoiceReminder = {
      id: `r${this.#data.nextId}`,
      text: clean,
      at: at.toISOString(),
      createdAt: new Date(this.#now()).toISOString(),
      ...(event ? { event } : {}),
    };
    this.#data = { ...this.#data, nextId: this.#data.nextId + 1, reminders: [...this.#data.reminders, reminder] };
    await this.#save();
    if (this.#started) this.#arm(reminder);
    return reminder;
  }

  async cancel(id: string): Promise<VoiceReminder | null> {
    const target = this.#data.reminders.find((reminder) => reminder.id === id.trim().replace(/^\[|\]$/g, ""));
    if (!target) return null;
    clearTimeout(this.#timers.get(target.id));
    this.#timers.delete(target.id);
    this.#data = { ...this.#data, reminders: this.#data.reminders.filter((reminder) => reminder !== target) };
    await this.#save();
    return target;
  }

  /**
   * Repeats the latest announcement `minutes` from now. Returns what Jarvis
   * says, or null when nothing was announced in the last half hour.
   */
  async snooze(minutes: number): Promise<string | null> {
    const last = this.#lastAnnouncement;
    if (!last || this.#now() - last.at > 30 * MINUTE) return null;
    const portuguese = this.#options.language.toLowerCase().startsWith("pt");
    const delay = Math.min(Math.max(1, Math.round(minutes)), 24 * 60);
    const { announcement } = last;
    const event = announcement.event ?? announcement.reminder?.event;
    if (event && Date.parse(event.start) <= this.#now() + delay * MINUTE) {
      return portuguese ? `Daqui a ${delay} minutos ${event.summary} já terá começado.` : `${event.summary} will have started by then.`;
    }
    const text = event ? event.summary : announcement.reminder?.text ?? announcement.text;
    await this.add(text, new Date(this.#now() + delay * MINUTE), event);
    this.#lastAnnouncement = null;
    const unit = portuguese ? (delay === 1 ? "minuto" : "minutos") : (delay === 1 ? "minute" : "minutes");
    return portuguese ? `Está bem, volto a avisar daqui a ${delay} ${unit}.` : `OK, I'll remind you again in ${delay} ${unit}.`;
  }

  /** Grok tools: set, list and cancel reminders in the user's time zone. */
  toolkit(): AssistantToolkit {
    const { timeZone } = this.#options;
    return {
      tools: async () => VOICE_REMINDER_TOOLS,
      handles: (name) => VOICE_REMINDER_TOOLS.some((tool) => tool.function.name === name),
      prompt: async () => `You can set reminders that Jarvis will speak at a given time, even after a restart (time zone ${timeZone}). For "remind me to X at/in …", call reminder_set with a local ISO time computed from the current time. Confirm the time in your reply.`,
      run: async (name, args) => {
        if (name === "reminder_set") {
          const reminder = await this.add(String(args.text ?? ""), parseLocalTime(String(args.at ?? ""), timeZone));
          return `Set [${reminder.id}] for ${this.#describeTime(reminder.at)}.`;
        }
        if (name === "reminder_list") {
          const pending = this.pending;
          return pending.length === 0 ? "No reminders pending." : pending.map((reminder) => `[${reminder.id}] ${this.#describeTime(reminder.at)}: ${reminder.text}`).join("\n");
        }
        if (name === "reminder_cancel") {
          const removed = await this.cancel(String(args.id ?? ""));
          return removed ? `Cancelled [${removed.id}] ${removed.text}.` : "No reminder with that id.";
        }
        return `Error: unknown tool ${name}`;
      },
    };
  }

  #arm(reminder: VoiceReminder): void {
    clearTimeout(this.#timers.get(reminder.id));
    const delay = Math.max(0, Date.parse(reminder.at) - this.#now());
    const timer = setTimeout(() => {
      this.#timers.delete(reminder.id);
      if (!this.#started) return;
      if (Date.parse(reminder.at) - this.#now() > 0) return this.#arm(reminder); // a far reminder's next step
      void this.#fire(reminder);
    }, Math.min(delay, MAX_TIMER_MS));
    timer.unref();
    this.#timers.set(reminder.id, timer);
  }

  async #fire(reminder: VoiceReminder): Promise<void> {
    if (!this.#data.reminders.includes(reminder)) return;
    this.#data = { ...this.#data, reminders: this.#data.reminders.filter((entry) => entry !== reminder) };
    await this.#save().catch((error: unknown) => this.#options.onError?.(error));
    const now = this.#now();
    const portuguese = this.#options.language.toLowerCase().startsWith("pt");
    const announcement: Announcement = {
      text: voiceReminderText(reminder, this.#options.language, now, now - Date.parse(reminder.at)),
      title: `Jarvis · ${portuguese ? "Lembrete" : "Reminder"}`,
      // A snoozed meeting reminder is pointless once the meeting starts; a plain one stays useful a while.
      expiresAt: reminder.event ? Date.parse(reminder.event.start) : Date.parse(reminder.at) + 30 * MINUTE,
      reminder,
      ...(reminder.event ? { event: reminder.event } : {}),
    };
    this.noteAnnounced(announcement);
    this.#options.announce(announcement);
  }

  #describeTime(iso: string): string {
    return new Date(iso).toLocaleString(this.#options.language, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: this.#options.timeZone });
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #save(): Promise<void> {
    const snapshot = `${JSON.stringify(this.#data, null, 2)}\n`;
    const filePath = this.#options.filePath;
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, filePath);
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }
}

/** A Grok-supplied local date-time (or a date, meaning 09:00) as an absolute instant. */
export function parseLocalTime(value: string, timeZone: string): Date {
  const time = toEventTime(value, timeZone);
  if ("date" in time) return zonedWallClockToDate(`${time.date}T09:00:00`, timeZone);
  return time.timeZone ? zonedWallClockToDate(time.dateTime, timeZone) : new Date(time.dateTime);
}

export const VOICE_REMINDER_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "reminder_set",
      description: "Set a reminder Jarvis will speak at a given local time. Use for \"remind me to …\" requests that are not calendar events.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind, short, e.g. \"ligar à Ana\"." },
          at: { type: "string", description: "Local ISO 8601 date-time, e.g. 2026-10-23T17:00 (a bare date means 09:00)." },
        },
        required: ["text", "at"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reminder_list",
      description: "List pending voice reminders with their ids.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "reminder_cancel",
      description: "Cancel a pending voice reminder by its id (shown as [r3]). Never read ids aloud.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  },
];
