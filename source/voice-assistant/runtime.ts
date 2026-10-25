import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand, type CommandRunner } from "./actions.js";
import { stripAudioTags, VoiceAssistant } from "./assistant.js";
import type { VoiceAssistantConfig } from "./config.js";
import { ElevenLabsClient } from "./elevenlabs.js";
import { GrokClient } from "./grok.js";
import { createCalendarToolkit, createMeetingJoiner, GoogleCalendarClient, isMeetingUrl } from "./calendar.js";
import { EMAIL_ALERTS_FILENAME, EmailAlerts } from "./email-alerts.js";
import { createGmailToolkit, GmailClient } from "./gmail.js";
import { GMAIL_READONLY_SCOPE, GOOGLE_TOKEN_FILENAME, GoogleOAuth } from "./google-auth.js";
import { MEMORY_FILENAME, MemoryStore } from "./memory.js";
import { EventReminders } from "./reminders.js";
import { VOICE_REMINDERS_FILENAME, VoiceReminders, type Announcement } from "./voice-reminders.js";
import { VOICE_SETTINGS_FILENAME, VoiceSelector } from "./voices.js";
import { DEFAULT_ASSISTANT_PROFILE, parseAssistantProfile, type AssistantProfile, type AssistantRoutine } from "./profile.js";

/** Everything a front end (terminal or desktop) needs, built from one config. */
export interface VoiceAssistantRuntime {
  readonly assistant: VoiceAssistant;
  readonly voice: ElevenLabsClient;
  readonly profile: AssistantProfile;
  readonly profileDirectory: string;
  readonly createdProfile: boolean;
  /** Null when JARVIS_MEMORY=off. */
  readonly memory: MemoryStore | null;
  /** Null when GOOGLE_CLIENT_ID is not configured. */
  readonly google: GoogleOAuth | null;
  /** Reminders set by voice ("lembra-me de … às 17h") and snoozes. */
  readonly voiceReminders: VoiceReminders;
  /** Voice changes by voice ("usa uma voz feminina"), saved in voice.json. */
  readonly voices: VoiceSelector;
  /**
   * Starts everything Jarvis says on its own: voice reminders and snoozes,
   * calendar events `reminderMinutes` before they begin, and new important
   * email (with the Google account connected).
   */
  startReminders(announce: (announcement: Announcement) => void): { stop(): void };
  /** Runs a routine, appends its report to the routine's log file, and returns the report. */
  runRoutine(routine: Pick<AssistantRoutine, "name" | "logFile">): Promise<string>;
}

export async function createVoiceAssistantRuntime(
  config: VoiceAssistantConfig,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly run?: CommandRunner;
    readonly onMemoryError?: (error: unknown) => void;
    /** Short status messages for the user (e.g. "Google Calendar connected"). */
    readonly onNotice?: (message: string) => void;
    readonly fetch?: typeof fetch;
  } = {},
): Promise<VoiceAssistantRuntime> {
  const profileDirectory = path.dirname(config.profilePath);
  await mkdir(profileDirectory, { recursive: true });
  let createdProfile = false;
  const profileMarkdown = await readFile(config.profilePath, "utf8").catch(async () => {
    await writeFile(config.profilePath, DEFAULT_ASSISTANT_PROFILE);
    createdProfile = true;
    return DEFAULT_ASSISTANT_PROFILE;
  });
  const profile = parseAssistantProfile(profileMarkdown);

  const memory = config.memoryEnabled
    ? await MemoryStore.open(path.join(profileDirectory, MEMORY_FILENAME), {
      onCorruptFile: (backup) => options.onMemoryError?.(new Error(`memory.json was unreadable and has been moved to ${backup}`)),
    })
    : null;

  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const portuguese = config.language.toLowerCase().startsWith("pt");
  const google = config.googleClientId
    ? new GoogleOAuth({
      clientId: config.googleClientId,
      ...(config.googleClientSecret ? { clientSecret: config.googleClientSecret } : {}),
      tokenPath: path.join(profileDirectory, GOOGLE_TOKEN_FILENAME),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      openUrl: async (url) => {
        if (!url.startsWith("https://accounts.google.com/")) throw new Error("Refusing to open an unexpected sign-in URL");
        await openInBrowser(url);
      },
    })
    : null;
  const calendar = google
    ? new GoogleCalendarClient({ auth: google, timeZone: config.timeZone, locale: config.language, ...(options.fetch ? { fetch: options.fetch } : {}) })
    : null;
  const openInBrowser = async (url: string) => {
    if (platform === "darwin") await run("open", [url]);
    else if (platform === "win32") await run("explorer", [url]);
    else await run("xdg-open", [url]);
  };
  const gmail = google ? new GmailClient({ auth: google, ...(options.fetch ? { fetch: options.fetch } : {}) }) : null;
  const joiner = calendar
    ? createMeetingJoiner({
      calendar,
      language: config.language,
      openUrl: async (url) => {
        // Checked again here: whatever produced the URL, only video-call hosts are opened.
        if (!isMeetingUrl(url)) throw new Error("Refusing to open a link that is not a known video-call host");
        await openInBrowser(url);
      },
    })
    : null;
  let announceHandler: (announcement: Announcement) => void = () => undefined;
  const voiceReminders = new VoiceReminders({
    filePath: path.join(profileDirectory, VOICE_REMINDERS_FILENAME),
    language: config.language,
    timeZone: config.timeZone,
    announce: (announcement) => announceHandler(announcement),
    onError: (error) => options.onNotice?.(`${portuguese ? "Lembretes" : "Reminders"}: ${error instanceof Error ? error.message : String(error)}`),
  });
  const voice = new ElevenLabsClient({
    apiKey: config.elevenLabsApiKey,
    baseUrl: config.elevenLabsBaseUrl,
    voiceId: config.elevenLabsVoiceId,
    ttsModel: config.elevenLabsTtsModel,
    sttModel: config.elevenLabsSttModel,
    language: config.language,
  });
  const voices = await VoiceSelector.open(voice, path.join(profileDirectory, VOICE_SETTINGS_FILENAME));
  const toolkits = [
    voiceReminders.toolkit(),
    voices.toolkit(),
    ...(google && calendar ? [createCalendarToolkit({ auth: google, timeZone: config.timeZone, calendar, ...(joiner ? { joiner } : {}) })] : []),
    ...(google && gmail ? [createGmailToolkit({ auth: google, gmail })] : []),
  ];
  const connectCalendar = () => {
    if (!google) {
      return portuguese
        ? "A conta Google ainda não está configurada. Falta definir GOOGLE_CLIENT_ID."
        : "Google is not set up yet: GOOGLE_CLIENT_ID is missing.";
    }
    google.connect().then(
      () => options.onNotice?.(portuguese ? "Conta Google ligada (Calendar e Gmail)." : "Google account connected (Calendar and Gmail)."),
      (error: unknown) => options.onNotice?.(`${portuguese ? "Não foi possível ligar a conta Google" : "Could not connect your Google account"}: ${error instanceof Error ? error.message : String(error)}`),
    );
    return portuguese ? "Abri o browser para ligares a tua conta Google." : "I've opened your browser so you can connect your Google account.";
  };

  const assistant = new VoiceAssistant({
    grok: new GrokClient({ apiKey: config.xaiApiKey, baseUrl: config.xaiBaseUrl, model: config.grokModel }),
    profile,
    language: config.language,
    historyLimit: config.historyLimit,
    ...(memory ? {
      memory,
      initialHistory: memory.restoreConversation(config.conversationTtlHours * 3_600_000),
      rememberedReply: portuguese ? "Fica registado." : "Noted, I'll remember that.",
    } : {}),
    ...(options.onMemoryError ? { onMemoryError: options.onMemoryError } : {}),
    toolkits,
    connectCalendar,
    snooze: async (minutes) => (await voiceReminders.snooze(minutes)) ?? (portuguese
      ? "Não há nenhum aviso recente para adiar."
      : "There is no recent reminder to snooze."),
    joinMeeting: async () => joiner?.join() ?? (portuguese
      ? "Para abrir reuniões, liga primeiro o Google Calendar."
      : "Connect Google Calendar first so I can find your meetings."),
    actions: {
      platform,
      run,
      notesPath: path.join(profileDirectory, "notes.md"),
      now: () => new Date(),
      locale: config.language,
    },
  });

  return {
    assistant,
    voice,
    profile,
    profileDirectory,
    createdProfile,
    memory,
    google,
    voiceReminders,
    voices,
    startReminders(announce) {
      announceHandler = (announcement) => {
        if (announcement.event) joiner?.noteAnnounced(announcement.event);
        announce(announcement);
      };
      void voiceReminders.start();
      const events = google && calendar && config.reminderMinutes !== null
        ? new EventReminders({
          listEvents: (from, to) => calendar.listEvents(from, to),
          isConnected: () => google.isConnected(),
          leadMinutes: config.reminderMinutes,
          language: config.language,
          announce: (reminder) => {
            const announcement: Announcement = { text: reminder.text, title: `Jarvis · ${reminder.event.summary}`, expiresAt: Date.parse(reminder.event.start), event: reminder.event };
            voiceReminders.noteAnnounced(announcement);
            announceHandler(announcement);
          },
          onError: (error) => options.onNotice?.(`${portuguese ? "Avisos do calendário" : "Calendar reminders"}: ${error instanceof Error ? error.message : String(error)}`),
        })
        : null;
      events?.start();
      const emails = google && gmail && config.emailAlerts
        ? new EmailAlerts({
          search: (query) => gmail.search(query),
          isAllowed: () => google.hasScope(GMAIL_READONLY_SCOPE),
          language: config.language,
          filePath: path.join(profileDirectory, EMAIL_ALERTS_FILENAME),
          announce: (announcement) => {
            voiceReminders.noteAnnounced(announcement);
            announceHandler(announcement);
          },
          onError: (error) => options.onNotice?.(`${portuguese ? "Avisos de email" : "Email alerts"}: ${error instanceof Error ? error.message : String(error)}`),
        })
        : null;
      void emails?.start();
      return {
        stop: () => {
          events?.stop();
          emails?.stop();
          voiceReminders.stop();
          announceHandler = () => undefined;
        },
      };
    },
    async runRoutine(routine) {
      const report = await assistant.runRoutine(routine.name);
      await appendFile(path.join(profileDirectory, routine.logFile), `\n## ${new Date().toISOString()} — ${routine.name}\n\n${stripAudioTags(report)}\n`);
      return report;
    },
  };
}
