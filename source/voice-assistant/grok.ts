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
}

export async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
