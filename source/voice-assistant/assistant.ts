import { ACTION_TOOLS, executeAction, isActionName, type ActionContext } from "./actions.js";
import type { GrokClient, GrokMessage } from "./grok.js";
import { routeIntent } from "./intent-router.js";
import type { AssistantToolkit } from "./calendar.js";
import { isMemoryToolName, MEMORY_TOOLS, type MemoryStore } from "./memory.js";
import type { AssistantProfile } from "./profile.js";

export interface AssistantReply {
  readonly text: string;
  /** "local" when the intent router answered without calling Grok. */
  readonly source: "local" | "grok" | "stop";
}

export interface HandleOptions {
  readonly signal?: AbortSignal;
  /** Receives the reply as it is generated: token deltas from Grok, or the whole local answer at once. */
  readonly onText?: (delta: string) => void;
}

export interface VoiceAssistantOptions {
  /** `stream` is used when present so replies can be spoken before Grok finishes. */
  readonly grok: Pick<GrokClient, "complete"> & Partial<Pick<GrokClient, "stream">>;
  readonly profile: AssistantProfile;
  readonly actions: ActionContext;
  readonly language: string;
  readonly historyLimit: number;
  readonly maxToolRounds?: number;
  /** Long-term facts and conversation persistence; omitted, the assistant forgets on restart. */
  readonly memory?: MemoryStore;
  /** Conversation restored from a previous session. */
  readonly initialHistory?: readonly GrokMessage[];
  readonly onMemoryError?: (error: unknown) => void;
  /** Spoken confirmation for "remember that …" handled locally, in the reply language. */
  readonly rememberedReply?: string;
  /** Extra tool sets, e.g. Google Calendar. */
  readonly toolkits?: readonly AssistantToolkit[];
  /** Starts the Google sign-in for "connect my calendar"; returns what Jarvis says meanwhile. */
  readonly connectCalendar?: () => string;
}

export class VoiceAssistant {
  readonly #options: VoiceAssistantOptions;
  #history: GrokMessage[] = [];

  constructor(options: VoiceAssistantOptions) {
    this.#options = options;
    this.#history = trimHistory([...(options.initialHistory ?? [])], options.historyLimit);
  }

  get history(): readonly GrokMessage[] {
    return this.#history;
  }

  async handle(transcript: string, options: HandleOptions = {}): Promise<AssistantReply> {
    const intent = routeIntent(transcript);
    if (intent.kind === "stop") return { text: "", source: "stop" };
    if (intent.kind === "connect-calendar" && this.#options.connectCalendar) {
      const text = this.#options.connectCalendar();
      options.onText?.(text);
      return { text, source: "local" };
    }
    if (intent.kind === "remember" && this.#options.memory) {
      try {
        await this.#options.memory.remember(intent.fact);
        const text = this.#options.rememberedReply ?? "Noted.";
        options.onText?.(text);
        return { text, source: "local" };
      } catch (error) {
        // Too long, or the disk refused it: Grok can still answer and explain.
        this.#options.onMemoryError?.(error);
      }
    }
    if (intent.kind === "action") {
      try {
        const text = await executeAction(intent.action, intent.args, this.#options.actions);
        options.onText?.(text);
        return { text, source: "local" };
      } catch {
        // A local guess that fails (e.g. an unknown app) gets a second chance with Grok.
      }
    }
    const turn: GrokMessage[] = [...this.#history, { role: "user", content: transcript }];
    const text = await this.#runToolLoop(turn, options);
    this.#history = trimHistory([...turn, { role: "assistant", content: text }], this.#options.historyLimit);
    await this.#options.memory?.saveConversation(this.#history).catch((error: unknown) => this.#options.onMemoryError?.(error));
    return { text, source: "grok" };
  }

  /** Runs a scheduled routine in a fresh context so it does not pollute the conversation. */
  async runRoutine(name: string, signal?: AbortSignal): Promise<string> {
    return this.#runToolLoop([{ role: "user", content: `Run your scheduled routine now: ${name}. Report the result as a short spoken briefing.` }], signal ? { signal } : {});
  }

  async #runToolLoop(conversation: GrokMessage[], options: HandleOptions): Promise<string> {
    const toolkits = this.#options.toolkits ?? [];
    const [toolkitTools, toolkitPrompts] = await Promise.all([
      Promise.all(toolkits.map((toolkit) => toolkit.tools())),
      Promise.all(toolkits.map((toolkit) => toolkit.prompt())),
    ]);
    const availableTools = [...ACTION_TOOLS, ...(this.#options.memory ? MEMORY_TOOLS : []), ...toolkitTools.flat()];
    const messages: GrokMessage[] = [{ role: "system", content: this.#systemPrompt(toolkitPrompts) }, ...conversation];
    const rounds = this.#options.maxToolRounds ?? 4;
    const { grok } = this.#options;
    // Text spoken before a tool call ("Opening it now…") stays part of the reply.
    let spoken = "";
    const onText = (delta: string) => {
      spoken += delta;
      options.onText?.(delta);
    };
    for (let round = 0; round <= rounds; round += 1) {
      const tools = round < rounds ? availableTools : [];
      const streaming = Boolean(grok.stream && options.onText);
      const completion = streaming
        ? await grok.stream!(messages, tools, { onText, ...(options.signal ? { signal: options.signal } : {}) })
        : await grok.complete(messages, tools, options.signal);
      if (!streaming && options.onText && completion.content) onText(completion.content);
      if (completion.toolCalls.length === 0) return (options.onText ? spoken : completion.content ?? "").trim();
      messages.push({ role: "assistant", content: completion.content, tool_calls: completion.toolCalls });
      for (const call of completion.toolCalls) {
        messages.push({ role: "tool", tool_call_id: call.id, content: await this.#runToolCall(call.function.name, call.function.arguments) });
      }
    }
    return "";
  }

  async #runToolCall(name: string, rawArguments: string): Promise<string> {
    const memory = this.#options.memory;
    const toolkit = this.#options.toolkits?.find((candidate) => candidate.handles(name));
    if (!isActionName(name) && !(memory && isMemoryToolName(name)) && !toolkit) return `Error: unknown tool ${name}`;
    try {
      const args = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
      if (toolkit) return await toolkit.run(name, args);
      if (memory && name === "remember") {
        const { fact, created } = await memory.remember(String(args.fact ?? ""));
        return created ? `Saved as [${fact.id}].` : `Already known as [${fact.id}].`;
      }
      if (memory && name === "forget") {
        const removed = await memory.forget(String(args.id ?? ""));
        return removed ? `Forgot [${removed.id}].` : "No memory with that id.";
      }
      if (!isActionName(name)) return `Error: unknown tool ${name}`;
      return await executeAction(name, args, this.#options.actions);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  #memoryPrompt(): string {
    const memory = this.#options.memory;
    if (!memory) return "";
    const facts = memory.promptBlock();
    return [
      "You have a long-term memory that persists between sessions.",
      "When the user shares something durable about themselves (name, preferences, people, places, routines) or asks you to remember something, call remember. Do not store secrets such as passwords, card numbers or one-time codes.",
      "When asked to forget something, call forget with its id. Never read ids aloud.",
      facts ? `What you remember about the user:\n${facts}` : "You do not remember anything about the user yet.",
    ].join("\n");
  }

  #systemPrompt(toolkitPrompts: readonly string[] = []): string {
    const { persona, capabilities } = this.#options.profile;
    return [
      persona || "You are Jarvis, a helpful voice assistant.",
      capabilities ? `Your responsibilities: ${capabilities}` : "",
      `Always reply in the language with code "${this.#options.language}".`,
      "Your reply is read aloud by a text-to-speech engine: no Markdown, no lists, no URLs, at most three sentences unless asked for detail.",
      "You may add sparse emotion tags in square brackets such as [laughs] or [sighs]; they are performed, not spoken.",
      "Use the provided tools for actions on the computer instead of describing how to do them.",
      this.#memoryPrompt(),
      ...toolkitPrompts,
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
