import { ACTION_TOOLS, executeAction, isActionName, type ActionContext } from "./actions.js";
import type { GrokClient, GrokMessage } from "./grok.js";
import { routeIntent } from "./intent-router.js";
import type { AssistantProfile } from "./profile.js";

export interface AssistantReply {
  readonly text: string;
  /** "local" when the intent router answered without calling Grok. */
  readonly source: "local" | "grok" | "stop";
}

export interface VoiceAssistantOptions {
  readonly grok: Pick<GrokClient, "complete">;
  readonly profile: AssistantProfile;
  readonly actions: ActionContext;
  readonly language: string;
  readonly historyLimit: number;
  readonly maxToolRounds?: number;
}

export class VoiceAssistant {
  readonly #options: VoiceAssistantOptions;
  #history: GrokMessage[] = [];

  constructor(options: VoiceAssistantOptions) {
    this.#options = options;
  }

  get history(): readonly GrokMessage[] {
    return this.#history;
  }

  async handle(transcript: string, signal?: AbortSignal): Promise<AssistantReply> {
    const intent = routeIntent(transcript);
    if (intent.kind === "stop") return { text: "", source: "stop" };
    if (intent.kind === "action") {
      try {
        return { text: await executeAction(intent.action, intent.args, this.#options.actions), source: "local" };
      } catch {
        // A local guess that fails (e.g. an unknown app) gets a second chance with Grok.
      }
    }
    const turn: GrokMessage[] = [...this.#history, { role: "user", content: transcript }];
    const text = await this.#runToolLoop(turn, signal);
    this.#history = trimHistory([...turn, { role: "assistant", content: text }], this.#options.historyLimit);
    return { text, source: "grok" };
  }

  /** Runs a scheduled routine in a fresh context so it does not pollute the conversation. */
  async runRoutine(name: string, signal?: AbortSignal): Promise<string> {
    return this.#runToolLoop([{ role: "user", content: `Run your scheduled routine now: ${name}. Report the result as a short spoken briefing.` }], signal);
  }

  async #runToolLoop(conversation: GrokMessage[], signal?: AbortSignal): Promise<string> {
    const messages: GrokMessage[] = [{ role: "system", content: this.#systemPrompt() }, ...conversation];
    const rounds = this.#options.maxToolRounds ?? 4;
    for (let round = 0; round <= rounds; round += 1) {
      const tools = round < rounds ? ACTION_TOOLS : [];
      const completion = await this.#options.grok.complete(messages, tools, signal);
      if (completion.toolCalls.length === 0) return (completion.content ?? "").trim();
      messages.push({ role: "assistant", content: completion.content, tool_calls: completion.toolCalls });
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: await this.#runToolCall(call.function.name, call.function.arguments) });
      }
    }
    return "";
  }

  async #runToolCall(name: string, rawArguments: string): Promise<string> {
    if (!isActionName(name)) return `Error: unknown tool ${name}`;
    try {
      const args = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
      return await executeAction(name, args, this.#options.actions);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  #systemPrompt(): string {
    const { persona, capabilities } = this.#options.profile;
    return [
      persona || "You are Jarvis, a helpful voice assistant.",
      capabilities ? `Your responsibilities: ${capabilities}` : "",
      `Always reply in the language with code "${this.#options.language}".`,
      "Your reply is read aloud by a text-to-speech engine: no Markdown, no lists, no URLs, at most three sentences unless asked for detail.",
      "You may add sparse emotion tags in square brackets such as [laughs] or [sighs]; they are performed, not spoken.",
      "Use the provided tools for actions on the computer instead of describing how to do them.",
      `Current local time: ${this.#options.actions.now().toString()}.`,
    ].filter(Boolean).join("\n");
  }
}

/** Keeps the last `limit` messages, starting on a user turn so tool calls are never orphaned. */
export function trimHistory(history: GrokMessage[], limit: number): GrokMessage[] {
  if (history.length <= limit) return history;
  let start = history.length - limit;
  while (start < history.length && history[start]?.role !== "user") start += 1;
  return history.slice(start);
}

/** Strips performance tags for terminal display. */
export function stripAudioTags(text: string): string {
  return text.replace(/\[[^\]\n]{1,30}\]\s*/g, "").trim();
}
