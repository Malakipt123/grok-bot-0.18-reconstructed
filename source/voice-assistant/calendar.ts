import { GoogleNotConnectedError, type GoogleOAuth } from "./google-auth.js";
import { safeText, type GrokTool } from "./grok.js";

export { GoogleNotConnectedError };

// Google Calendar (primary calendar) as Grok tools: read the agenda and
// create events. Results are short, speakable lines rather than raw JSON.

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_EVENTS = 25;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface CalendarEvent {
  readonly id: string;
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly location: string | null;
}

export interface NewCalendarEvent {
  readonly title: string;
  readonly start: string;
  readonly end?: string;
  readonly location?: string;
  readonly description?: string;
}

export interface GoogleCalendarOptions {
  readonly auth: Pick<GoogleOAuth, "accessToken">;
  readonly timeZone: string;
  readonly locale: string;
  readonly fetch?: typeof fetch;
}

type EventTime = { date: string } | { dateTime: string; timeZone?: string };

/** Turns a Grok-supplied date or date-time into a Calendar API time, or throws a readable error. */
export function toEventTime(value: string, timeZone: string): EventTime {
  const text = value.trim();
  if (DATE_ONLY.test(text)) return { date: text };
  if (LOCAL_DATE_TIME.test(text)) return { dateTime: text.length === 16 ? `${text}:00` : text, timeZone };
  if (ZONED_DATE_TIME.test(text) && Number.isFinite(Date.parse(text))) return { dateTime: text };
  throw new Error(`Use ISO 8601 like 2026-10-23T15:00 or 2026-10-23, got ${JSON.stringify(value)}`);
}

/** Default end: one hour after a timed start, the next day after an all-day start. */
export function defaultEnd(start: EventTime): EventTime {
  if ("date" in start) {
    const next = new Date(`${start.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { date: next.toISOString().slice(0, 10) };
  }
  if (start.timeZone) {
    // A local wall-clock time: add an hour on the wall clock, keep the zone.
    const shifted = new Date(`${start.dateTime}Z`);
    shifted.setUTCHours(shifted.getUTCHours() + 1);
    return { dateTime: shifted.toISOString().slice(0, 19), timeZone: start.timeZone };
  }
  return { dateTime: new Date(Date.parse(start.dateTime) + 3_600_000).toISOString() };
}

export class GoogleCalendarClient {
  readonly #options: GoogleCalendarOptions;
  readonly #fetch: typeof fetch;

  constructor(options: GoogleCalendarOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const url = new URL(API);
    url.search = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_EVENTS),
      timeZone: this.#options.timeZone,
    }).toString();
    const body = await this.#request(url.toString(), { method: "GET" }) as {
      items?: Array<{ id?: string; summary?: string; location?: string; status?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } }>;
    };
    return (body.items ?? [])
      .filter((item) => item.status !== "cancelled" && (item.start?.date || item.start?.dateTime))
      .map((item) => ({
        id: item.id ?? "",
        summary: item.summary?.trim() || "(untitled)",
        start: item.start?.dateTime ?? item.start?.date ?? "",
        end: item.end?.dateTime ?? item.end?.date ?? "",
        allDay: Boolean(item.start?.date),
        location: item.location?.trim() || null,
      }));
  }

  async createEvent(event: NewCalendarEvent): Promise<CalendarEvent & { link: string | null }> {
    const title = event.title.trim();
    if (!title) throw new Error("An event needs a title");
    const start = toEventTime(event.start, this.#options.timeZone);
    const end = event.end ? toEventTime(event.end, this.#options.timeZone) : defaultEnd(start);
    if (("date" in start) !== ("date" in end)) throw new Error("Start and end must both be dates or both be date-times");
    const body = await this.#request(API, {
      method: "POST",
      body: JSON.stringify({
        summary: title.slice(0, 200),
        start,
        end,
        ...(event.location?.trim() ? { location: event.location.trim().slice(0, 300) } : {}),
        ...(event.description?.trim() ? { description: event.description.trim().slice(0, 2000) } : {}),
      }),
    }) as { id?: string; htmlLink?: string; summary?: string; location?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
    return {
      id: body.id ?? "",
      summary: body.summary ?? title,
      start: body.start?.dateTime ?? body.start?.date ?? ("date" in start ? start.date : start.dateTime),
      end: body.end?.dateTime ?? body.end?.date ?? ("date" in end ? end.date : end.dateTime),
      allDay: "date" in start,
      location: body.location ?? null,
      link: body.htmlLink ?? null,
    };
  }

  /** "qui., 23/10, 14:00–15:00 Reunião (Lisboa)". */
  describe(event: CalendarEvent): string {
    const { locale, timeZone } = this.#options;
    const day = (value: string) => new Date(DATE_ONLY.test(value) ? `${value}T12:00:00Z` : value)
      .toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "2-digit", timeZone: DATE_ONLY.test(value) ? "UTC" : timeZone });
    const time = (value: string) => new Date(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone });
    const when = event.allDay ? `${day(event.start)}, all day` : `${day(event.start)}, ${time(event.start)}–${time(event.end)}`;
    return `${when} ${event.summary}${event.location ? ` (${event.location})` : ""}`;
  }

  async #request(url: string, init: RequestInit): Promise<unknown> {
    const token = await this.#options.auth.accessToken();
    const response = await this.#fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    if (!response.ok) throw new Error(`Google Calendar request failed (${response.status}): ${await safeText(response)}`);
    return response.json();
  }
}

/** A set of tools the assistant can offer to Grok, with its own system-prompt text. */
export interface AssistantToolkit {
  readonly tools: () => Promise<readonly GrokTool[]>;
  readonly handles: (name: string) => boolean;
  readonly run: (name: string, args: Record<string, unknown>) => Promise<string>;
  readonly prompt: () => Promise<string>;
}

export const CALENDAR_TOOLS: readonly GrokTool[] = [
  {
    type: "function",
    function: {
      name: "calendar_list_events",
      description: "List events in the user's Google Calendar between two moments. Use it for agenda, availability and briefing questions.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO 8601 start, e.g. 2026-10-23T00:00 (local time) or 2026-10-23." },
          to: { type: "string", description: "ISO 8601 end (exclusive)." },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_create_event",
      description: "Create an event in the user's Google Calendar. Only call it once the user has stated or confirmed the title, day and time.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601 local date-time (2026-10-23T15:00) or a date for an all-day event (2026-10-23)." },
          end: { type: "string", description: "Optional; defaults to one hour later, or the next day for all-day events." },
          location: { type: "string" },
          description: { type: "string" },
        },
        required: ["title", "start"],
        additionalProperties: false,
      },
    },
  },
];

function parseBoundary(value: unknown, timeZone: string): Date {
  const time = toEventTime(String(value ?? ""), timeZone);
  if ("date" in time) return zonedWallClockToDate(`${time.date}T00:00:00`, timeZone);
  return time.timeZone ? zonedWallClockToDate(time.dateTime, timeZone) : new Date(time.dateTime);
}

/** Interprets a wall-clock time in an IANA zone (DST-aware) as an absolute Date. */
export function zonedWallClockToDate(wallClock: string, timeZone: string): Date {
  const asUtc = Date.parse(`${wallClock}Z`);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant))
      .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant;
  };
  // Two passes settle the offset across DST transitions.
  let instant = asUtc - offsetAt(asUtc);
  instant = asUtc - offsetAt(instant);
  return new Date(instant);
}

export interface CalendarToolkitOptions {
  readonly auth: Pick<GoogleOAuth, "accessToken" | "isConnected">;
  readonly calendar: GoogleCalendarClient;
  readonly timeZone: string;
}

export function createCalendarToolkit(options: CalendarToolkitOptions): AssistantToolkit {
  const { auth, calendar, timeZone } = options;
  return {
    tools: async () => ((await auth.isConnected()) ? CALENDAR_TOOLS : []),
    handles: (name) => CALENDAR_TOOLS.some((tool) => tool.function.name === name),
    async prompt() {
      if (!(await auth.isConnected())) {
        return "Google Calendar is available but not connected. If the user asks about their calendar, tell them to say \"liga o calendário\" (or \"connect my calendar\") to sign in.";
      }
      return `You can read and create events in the user's Google Calendar (time zone ${timeZone}). Check it for agenda, availability and briefing requests. Pass local times without an offset. Before creating an event, confirm the title, day and time unless the user stated all of them.`;
    },
    async run(name, args) {
      try {
        if (name === "calendar_list_events") {
          const from = parseBoundary(args.from, timeZone);
          const to = parseBoundary(args.to, timeZone);
          if (!(to > from)) return "Error: 'to' must be after 'from'.";
          const events = await calendar.listEvents(from, to);
          if (events.length === 0) return "No events in that period.";
          return events.map((event) => calendar.describe(event)).join("\n") + (events.length >= MAX_EVENTS ? "\n(more events not shown)" : "");
        }
        if (name === "calendar_create_event") {
          const created = await calendar.createEvent({
            title: String(args.title ?? ""),
            start: String(args.start ?? ""),
            ...(typeof args.end === "string" && args.end ? { end: args.end } : {}),
            ...(typeof args.location === "string" ? { location: args.location } : {}),
            ...(typeof args.description === "string" ? { description: args.description } : {}),
          });
          return `Created: ${calendar.describe(created)}.`;
        }
        return `Error: unknown tool ${name}`;
      } catch (error) {
        if (error instanceof GoogleNotConnectedError) return "Error: Google Calendar is no longer connected. Ask the user to say \"liga o calendário\".";
        throw error;
      }
    },
  };
}
