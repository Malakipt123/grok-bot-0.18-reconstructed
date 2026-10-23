import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand, type CommandRunner } from "./actions.js";
import { stripAudioTags, VoiceAssistant } from "./assistant.js";
import type { VoiceAssistantConfig } from "./config.js";
import { ElevenLabsClient } from "./elevenlabs.js";
import { GrokClient } from "./grok.js";
import { createCalendarToolkit, GoogleCalendarClient } from "./calendar.js";
import { GOOGLE_TOKEN_FILENAME, GoogleOAuth } from "./google-auth.js";
import { MEMORY_FILENAME, MemoryStore } from "./memory.js";
import { EventReminders, type Reminder } from "./reminders.js";
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
  /**
   * Starts announcing calendar events `reminderMinutes` before they begin.
   * Does nothing (and stop() is a no-op) without Google Calendar or with reminders off.
   */
  startReminders(announce: (reminder: Reminder) => void): { stop(): void };
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
        if (platform === "darwin") await run("open", [url]);
        else if (platform === "win32") await run("explorer", [url]);
        else await run("xdg-open", [url]);
      },
    })
    : null;
  const calendar = google
    ? new GoogleCalendarClient({ auth: google, timeZone: config.timeZone, locale: config.language, ...(options.fetch ? { fetch: options.fetch } : {}) })
    : null;
  const toolkits = google && calendar ? [createCalendarToolkit({ auth: google, timeZone: config.timeZone, calendar })] : [];
  const connectCalendar = () => {
    if (!google) {
      return portuguese
        ? "O Google Calendar ainda não está configurado. Falta definir GOOGLE_CLIENT_ID."
        : "Google Calendar is not set up yet: GOOGLE_CLIENT_ID is missing.";
    }
    google.connect().then(
      () => options.onNotice?.(portuguese ? "Google Calendar ligado." : "Google Calendar connected."),
      (error: unknown) => options.onNotice?.(`${portuguese ? "Não foi possível ligar o Google Calendar" : "Could not connect Google Calendar"}: ${error instanceof Error ? error.message : String(error)}`),
    );
    return portuguese ? "Abri o browser para ligares o teu Google Calendar." : "I've opened your browser so you can connect Google Calendar.";
  };

  const voice = new ElevenLabsClient({
    apiKey: config.elevenLabsApiKey,
    baseUrl: config.elevenLabsBaseUrl,
    voiceId: config.elevenLabsVoiceId,
    ttsModel: config.elevenLabsTtsModel,
    sttModel: config.elevenLabsSttModel,
    language: config.language,
  });
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
    startReminders(announce) {
      if (!google || !calendar || config.reminderMinutes === null) return { stop() {} };
      const reminders = new EventReminders({
        listEvents: (from, to) => calendar.listEvents(from, to),
        isConnected: () => google.isConnected(),
        leadMinutes: config.reminderMinutes,
        language: config.language,
        announce,
        onError: (error) => options.onNotice?.(`${portuguese ? "Avisos do calendário" : "Calendar reminders"}: ${error instanceof Error ? error.message : String(error)}`),
      });
      reminders.start();
      return { stop: () => reminders.stop() };
    },
    async runRoutine(routine) {
      const report = await assistant.runRoutine(routine.name);
      await appendFile(path.join(profileDirectory, routine.logFile), `\n## ${new Date().toISOString()} — ${routine.name}\n\n${stripAudioTags(report)}\n`);
      return report;
    },
  };
}
