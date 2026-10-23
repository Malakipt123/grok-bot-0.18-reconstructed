import os from "node:os";
import path from "node:path";

export interface VoiceAssistantConfig {
  readonly xaiApiKey: string;
  readonly xaiBaseUrl: string;
  readonly grokModel: string;
  readonly elevenLabsApiKey: string;
  readonly elevenLabsBaseUrl: string;
  readonly elevenLabsVoiceId: string;
  readonly elevenLabsTtsModel: string;
  readonly elevenLabsSttModel: string;
  readonly language: string;
  readonly profilePath: string;
  readonly historyLimit: number;
  /** Long-term facts and conversation persistence in memory.json next to the profile. */
  readonly memoryEnabled: boolean;
  /** A saved conversation older than this starts fresh on restart (facts are always kept). */
  readonly conversationTtlHours: number;
  /** OAuth client of type "Desktop app"; Google Calendar is offered only when set. */
  readonly googleClientId: string | null;
  readonly googleClientSecret: string | null;
  /** IANA zone for calendar times; defaults to the system zone. */
  readonly timeZone: string;
}

export class VoiceAssistantConfigError extends Error {
  override readonly name = "VoiceAssistantConfigError";
}

// George, one of ElevenLabs' premade multilingual voices.
export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

export function defaultProfilePath(): string {
  return path.join(os.homedir(), ".grok-bot", "voice-assistant", "ASSISTANT.md");
}

export function loadVoiceAssistantConfig(env: NodeJS.ProcessEnv = process.env): VoiceAssistantConfig {
  const missing = ["XAI_API_KEY", "ELEVENLABS_API_KEY"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new VoiceAssistantConfigError(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  const historyLimit = Number.parseInt(env.JARVIS_HISTORY_LIMIT ?? "", 10);
  const conversationTtlHours = Number.parseFloat(env.JARVIS_CONVERSATION_TTL_HOURS ?? "");
  return {
    xaiApiKey: env.XAI_API_KEY!.trim(),
    xaiBaseUrl: trimSlash(env.XAI_BASE_URL || "https://api.x.ai/v1"),
    grokModel: env.GROK_MODEL || "grok-4",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY!.trim(),
    elevenLabsBaseUrl: trimSlash(env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io/v1"),
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
    elevenLabsTtsModel: env.ELEVENLABS_TTS_MODEL || "eleven_v3",
    elevenLabsSttModel: env.ELEVENLABS_STT_MODEL || "scribe_v1",
    language: env.JARVIS_LANGUAGE || "pt",
    profilePath: env.JARVIS_PROFILE || defaultProfilePath(),
    historyLimit: Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : 20,
    memoryEnabled: env.JARVIS_MEMORY?.trim().toLowerCase() !== "off",
    conversationTtlHours: Number.isFinite(conversationTtlHours) && conversationTtlHours >= 0 ? conversationTtlHours : 12,
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || null,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || null,
    timeZone: validTimeZone(env.JARVIS_TIMEZONE?.trim()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function validTimeZone(zone: string | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
