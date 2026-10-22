import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { GrokTool } from "./grok.js";

/** Runs a program with argv only; actions never go through a shell. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<void>;

export const runCommand: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 15_000 }, (error) => (error ? reject(error) : resolve()));
  });

export interface ActionContext {
  readonly platform: NodeJS.Platform;
  readonly run: CommandRunner;
  readonly notesPath: string;
  readonly now: () => Date;
  readonly locale: string;
}

export type ActionName = "open_app" | "open_url" | "set_volume" | "get_time" | "take_note";

const APP_NAME = /^[\p{L}\p{N} ._&+'-]{1,64}$/u;

export const ACTION_TOOLS: readonly GrokTool[] = [
  tool("open_app", "Open or focus a desktop application by name.", {
    name: { type: "string", description: "Application name, e.g. Safari, Spotify, Mail." },
  }, ["name"]),
  tool("open_url", "Open an http(s) URL in the default browser.", {
    url: { type: "string" },
  }, ["url"]),
  tool("set_volume", "Set the system output volume.", {
    level: { type: "integer", minimum: 0, maximum: 100 },
  }, ["level"]),
  tool("get_time", "Get the current local date and time.", {}, []),
  tool("take_note", "Append a short note to the user's notes file.", {
    text: { type: "string" },
  }, ["text"]),
];

export function isActionName(value: string): value is ActionName {
  return ACTION_TOOLS.some((entry) => entry.function.name === value);
}

/** Executes one action and returns a short, speakable result string. */
export async function executeAction(name: ActionName, args: Record<string, unknown>, context: ActionContext): Promise<string> {
  switch (name) {
    case "open_app": {
      const app = String(args.name ?? "").trim();
      if (!APP_NAME.test(app)) throw new Error(`Refusing to open an app with an unexpected name: ${JSON.stringify(app)}`);
      if (context.platform === "darwin") await context.run("open", ["-a", app]);
      else if (context.platform === "win32") await context.run("cmd", ["/c", "start", "", app]);
      else await context.run("gtk-launch", [app.toLowerCase()]);
      return `Opened ${app}.`;
    }
    case "open_url": {
      const url = new URL(String(args.url ?? ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http(s) URLs can be opened, got ${url.protocol}`);
      if (context.platform === "darwin") await context.run("open", [url.href]);
      else if (context.platform === "win32") await context.run("explorer", [url.href]);
      else await context.run("xdg-open", [url.href]);
      return `Opened ${url.hostname}.`;
    }
    case "set_volume": {
      const level = Math.round(Number(args.level));
      if (!Number.isFinite(level) || level < 0 || level > 100) throw new Error("Volume must be between 0 and 100");
      if (context.platform === "darwin") await context.run("osascript", ["-e", `set volume output volume ${level}`]);
      else if (context.platform === "linux") await context.run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${level}%`]);
      else throw new Error("Volume control is not supported on this platform");
      return `Volume set to ${level}%.`;
    }
    case "get_time":
      return context.now().toLocaleString(context.locale, { dateStyle: "full", timeStyle: "short" });
    case "take_note": {
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("Note text is empty");
      await mkdir(path.dirname(context.notesPath), { recursive: true });
      await appendFile(context.notesPath, `- ${context.now().toISOString()} ${text.replace(/\s+/g, " ")}\n`);
      return "Note saved.";
    }
  }
}

function tool(name: ActionName, description: string, properties: Record<string, unknown>, required: string[]): GrokTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
