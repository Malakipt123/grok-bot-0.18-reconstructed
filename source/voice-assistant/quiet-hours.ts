// Quiet hours: during them Jarvis does not start talking on its own about
// email or calendar events; those become silent notifications instead.
// Reminders the user set themselves ("lembra-me às 23h…") still speak, and
// so does anything the user asks for.

export interface QuietHours {
  /** Minutes after local midnight. */
  readonly start: number;
  readonly end: number;
}

export const DEFAULT_QUIET_HOURS = "22:00-08:00";
const RANGE = /^\s*(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*$/;

/** "22:00-08:00", "23-7"; "off" (or anything unreadable) means no quiet hours. */
export function parseQuietHours(value: string | undefined): QuietHours | null {
  const text = (value ?? DEFAULT_QUIET_HOURS).trim().toLowerCase();
  if (!text || text === "off") return null;
  const match = RANGE.exec(text);
  if (!match) return null;
  const minutes = (hours: string | undefined, mins: string | undefined) => {
    const h = Number(hours);
    const m = Number(mins ?? "0");
    return h <= 24 && m < 60 ? (h * 60 + m) % (24 * 60) : Number.NaN;
  };
  const start = minutes(match[1], match[2]);
  const end = minutes(match[3], match[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
  return { start, end };
}

/** Whether `now` falls inside the quiet hours, read on the wall clock of `timeZone`. */
export function isQuietTime(quiet: QuietHours | null, now: Date, timeZone: string): boolean {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const minute = value("hour") * 60 + value("minute");
  // A range that crosses midnight (22:00–08:00) is the part outside end–start.
  return quiet.start < quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end;
}

export function describeQuietHours(quiet: QuietHours): string {
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `${clock(quiet.start)}–${clock(quiet.end)}`;
}
