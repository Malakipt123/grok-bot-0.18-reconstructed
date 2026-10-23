import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand, type CommandRunner } from "./actions.js";
import { stripAudioTags, VoiceAssistant } from "./assistant.js";
import type { VoiceAssistantConfig } from "./config.js";
import { ElevenLabsClient } from "./elevenlabs.js";
import { GrokClient } from "./grok.js";
import { MEMORY_FILENAME, MemoryStore } from "./memory.js";
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
  /** Runs a routine, appends its report to the routine's log file, and returns the report. */
  runRoutine(routine: Pick<AssistantRoutine, "name" | "logFile">): Promise<string>;
}

export async function createVoiceAssistantRuntime(
  config: VoiceAssistantConfig,
  options: { readonly platform?: NodeJS.Platform; readonly run?: CommandRunner; readonly onMemoryError?: (error: unknown) => void } = {},
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
      rememberedReply: config.language.toLowerCase().startsWith("pt") ? "Fica registado." : "Noted, I'll remember that.",
    } : {}),
    ...(options.onMemoryError ? { onMemoryError: options.onMemoryError } : {}),
    actions: {
      platform: options.platform ?? process.platform,
      run: options.run ?? runCommand,
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
    async runRoutine(routine) {
      const report = await assistant.runRoutine(routine.name);
      await appendFile(path.join(profileDirectory, routine.logFile), `\n## ${new Date().toISOString()} — ${routine.name}\n\n${stripAudioTags(report)}\n`);
      return report;
    },
  };
}
