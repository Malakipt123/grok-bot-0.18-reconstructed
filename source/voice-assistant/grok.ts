// Minimal client for xAI's OpenAI-compatible chat completions endpoint.

export interface GrokToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export type GrokMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string | null; readonly tool_calls?: readonly GrokToolCall[] }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

export interface GrokTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface GrokCompletion {
  readonly content: string | null;
  readonly toolCalls: readonly GrokToolCall[];
}

export interface GrokClientOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
}

export class GrokClient {
  readonly #options: GrokClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: GrokClientOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  async complete(messages: readonly GrokMessage[], tools: readonly GrokTool[] = [], signal?: AbortSignal): Promise<GrokCompletion> {
    const response = await this.#fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#options.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Grok request failed (${response.status}): ${await safeText(response)}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: GrokToolCall[] } }>;
    };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("Grok response contained no message");
    return { content: message.content ?? null, toolCalls: message.tool_calls ?? [] };
  }

  /** Like complete(), but streams content deltas to onText as Grok produces them. */
  async stream(messages: readonly GrokMessage[], tools: readonly GrokTool[] = [], options: GrokStreamOptions = {}): Promise<GrokCompletion> {
    const response = await this.#fetch(`${this.#options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#options.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: this.#options.model,
        messages,
        stream: true,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Grok request failed (${response.status}): ${await safeText(response)}`);
    }
    if (!response.body) throw new Error("Grok returned an empty stream");
    return readChatCompletionStream(response.body, options.onText);
  }
}

export interface GrokStreamOptions {
  readonly onText?: (delta: string) => void;
  readonly signal?: AbortSignal;
}

interface GrokStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/** Reads an OpenAI-style SSE body, forwarding content deltas and assembling tool calls by index. */
export async function readChatCompletionStream(body: ReadableStream<Uint8Array>, onText?: (delta: string) => void): Promise<GrokCompletion> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let content = "";
  let buffer = "";
  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const delta = (JSON.parse(data) as GrokStreamChunk).choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      onText?.(delta.content);
    }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(index, current);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) handleLine(line);
    if (done) break;
  }
  const toolCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]): GrokToolCall => ({ id: call.id || `call_${index}`, type: "function", function: { name: call.name, arguments: call.arguments } }));
  return { content: content || null, toolCalls };
}

export async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
