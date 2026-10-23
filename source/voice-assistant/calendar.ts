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
  /** Video-call link (Google Meet, Zoom or Teams), only ever an https URL on a known host. */
  readonly meetingUrl?: string | null;
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

// Links in descriptions are attacker-controllable (anyone can invite you), so
// only video-call hosts are ever opened, and only over https.
const MEETING_HOSTS = [/^meet\.google\.com$/, /^([a-z0-9-]+\.)?zoom\.us$/, /^teams\.microsoft\.com$/, /^teams\.live\.com$/];
const URL_IN_TEXT = /https:\/\/[^\s<>"')\]]+/gi;

export function isMeetingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && MEETING_HOSTS.some((host) => host.test(url.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

export function isGoogleMeetUrl(value: string): boolean {
  return isMeetingUrl(value) && new URL(value).hostname.toLowerCase() === "meet.google.com";
}

interface RawEvent {
  id?: string;
  summary?: string;
  location?: string;
  description?: string;
  status?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** The event's video-call link: Google's own conference data first, then links typed into location or description. */
export function meetingUrlOf(event: RawEvent): string | null {
  const candidates = [
    event.hangoutLink,
    ...(event.conferenceData?.entryPoints ?? []).filter((entry) => entry.entryPointType === "video").map((entry) => entry.uri),
    ...Array.from(`${event.location ?? ""} ${event.description ?? ""}`.matchAll(URL_IN_TEXT), (match) => match[0].replace(/[.,;:!?]+$/, "")),
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && isMeetingUrl(candidate)) ?? null;
}

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
    const body = await this.#request(url.toString(), { method: "GET" }) as { items?: RawEvent[] };
    return (body.items ?? [])
      .filter((item) => item.status !== "cancelled" && (item.start?.date || item.start?.dateTime))
      .map((item) => ({
        id: item.id ?? "",
        summary: item.summary?.trim() || "(untitled)",
        start: item.start?.dateTime ?? item.start?.date ?? "",
        end: item.end?.dateTime ?? item.end?.date ?? "",
        allDay: Boolean(item.start?.date),
        location: item.location?.trim() || null,
        meetingUrl: meetingUrlOf(item),
      }));
  }

  /**
   * The meeting to join right now: in progress, or starting within `earlyMinutes`.
   * Among several, the one whose start is closest to now wins.
   */
  async findJoinableMeeting(now = new Date(), earlyMinutes = 15): Promise<CalendarEvent | null> {
    const events = await this.listEvents(new Date(now.getTime() - 12 * 3_600_000), new Date(now.getTime() + earlyMinutes * 60_000));
    const joinable = events.filter((event) => {
      if (event.allDay || !event.meetingUrl) return false;
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      return start - earlyMinutes * 60_000 <= now.getTime() && now.getTime() < (Number.isFinite(end) ? end : start + 3_600_000);
    });
    return joinable.sort((left, right) => Math.abs(Date.parse(left.start) - now.getTime()) - Math.abs(Date.parse(right.start) - now.getTime()))[0] ?? null;
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
    const call = event.meetingUrl ? (isGoogleMeetUrl(event.meetingUrl) ? " [Google Meet]" : " [video call]") : "";
    // A location that is just the call link would be read out as a URL; the marker says enough.
    const location = event.location && !isMeetingUrl(event.location) ? ` (${event.location})` : "";
    return `${when} ${event.summary}${location}${call}`;
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

export const JOIN_MEETING_TOOL: GrokTool = {
  type: "function",
  function: {
    name: "calendar_join_meeting",
    description: "Open the video call (Google Meet, Zoom or Teams) of the meeting in progress, about to start, or just announced. Use it when the user wants to join or open their meeting.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

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

export interface MeetingJoiner {
  /** Called when a reminder announced this event, so "abre a reunião" means this one. */
  noteAnnounced(event: CalendarEvent): void;
  /** Opens the announced meeting if it is still on, otherwise the one in progress or about to start. */
  join(): Promise<string>;
}

export function createMeetingJoiner(options: {
  readonly calendar: Pick<GoogleCalendarClient, "findJoinableMeeting">;
  readonly openUrl: (url: string) => Promise<void>;
  readonly language: string;
  readonly now?: () => Date;
}): MeetingJoiner {
  const portuguese = options.language.toLowerCase().startsWith("pt");
  let announced: CalendarEvent | null = null;
  const now = () => options.now?.() ?? new Date();
  const stillOn = (event: CalendarEvent) => {
    const end = Date.parse(event.end);
    return now().getTime() < (Number.isFinite(end) ? end : Date.parse(event.start) + 3_600_000);
  };
  return {
    noteAnnounced(event) {
      if (event.meetingUrl) announced = event;
    },
    async join() {
      let event = announced && stillOn(announced) ? announced : null;
      if (!event) {
        try {
          event = await options.calendar.findJoinableMeeting(now());
        } catch (error) {
          if (error instanceof GoogleNotConnectedError) {
            return portuguese ? "O Google Calendar não está ligado. Diz «liga o calendário» primeiro." : "Google Calendar is not connected. Say \"connect my calendar\" first.";
          }
          throw error;
        }
      }
      if (!event?.meetingUrl || !isMeetingUrl(event.meetingUrl)) {
        return portuguese ? "Não encontrei nenhuma reunião com link a decorrer ou prestes a começar." : "I couldn't find a meeting with a call link in progress or about to start.";
      }
      await options.openUrl(event.meetingUrl);
      const app = isGoogleMeetUrl(event.meetingUrl) ? "o Google Meet" : (portuguese ? "a videochamada" : "the call");
      return portuguese ? `A abrir ${app}: ${event.summary}.` : `Opening ${isGoogleMeetUrl(event.meetingUrl) ? "Google Meet" : "the call"}: ${event.summary}.`;
    },
  };
}

export interface CalendarToolkitOptions {
  readonly auth: Pick<GoogleOAuth, "accessToken" | "isConnected">;
  readonly calendar: GoogleCalendarClient;
  readonly timeZone: string;
  readonly joiner?: MeetingJoiner;
}

export function createCalendarToolkit(options: CalendarToolkitOptions): AssistantToolkit {
  const { auth, calendar, timeZone, joiner } = options;
  const tools = joiner ? [...CALENDAR_TOOLS, JOIN_MEETING_TOOL] : CALENDAR_TOOLS;
  return {
    tools: async () => ((await auth.isConnected()) ? tools : []),
    handles: (name) => tools.some((tool) => tool.function.name === name),
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
        if (name === "calendar_join_meeting" && joiner) return await joiner.join();
        return `Error: unknown tool ${name}`;
      } catch (error) {
        if (error instanceof GoogleNotConnectedError) return "Error: Google Calendar is no longer connected. Ask the user to say \"liga o calendário\".";
        throw error;
      }
    },
  };
}
