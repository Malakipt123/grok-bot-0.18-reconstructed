// ASSISTANT.md: a small Markdown profile in the spirit of CLAUDE.md.
//
//   # ASSISTANT.md
//   ## Persona
//   You are Jarvis. Dry wit, short answers.
//   ## What it does
//   Daily brief · Notes
//   ## When it runs
//   07:00 — Daily brief → log.md

export interface AssistantRoutine {
  readonly time: string;
  readonly hour: number;
  readonly minute: number;
  readonly name: string;
  readonly logFile: string;
}

export interface AssistantProfile {
  readonly persona: string;
  readonly capabilities: string;
  readonly routines: readonly AssistantRoutine[];
}

const ROUTINE = /^[-*]?\s*(\d{1,2}):(\d{2})\s*[—–-]+\s*(.+?)(?:\s*(?:→|->)\s*(\S+))?\s*$/u;

export function parseAssistantProfile(markdown: string): AssistantProfile {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      current = [];
      sections.set(heading[1].toLowerCase(), current);
    } else if (current) {
      current.push(line);
    }
  }
  const section = (name: string) => (sections.get(name) ?? []).join("\n").trim();

  const routines: AssistantRoutine[] = [];
  for (const line of section("when it runs").split("\n")) {
    const match = ROUTINE.exec(line.trim());
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    const logFile = match[4] ?? "log.md";
    // Logs stay inside the profile directory.
    if (logFile.includes("/") || logFile.includes("\\") || logFile.startsWith(".")) continue;
    routines.push({ time: `${String(hour).padStart(2, "0")}:${match[2]}`, hour, minute, name: match[3], logFile });
  }
  return { persona: section("persona"), capabilities: section("what it does"), routines };
}

export const DEFAULT_ASSISTANT_PROFILE = `# ASSISTANT.md

## Persona
You are Jarvis, a calm, witty voice assistant. Keep answers short enough to listen to.

## What it does
Daily brief · Notes · Open apps and websites · Answer questions

## When it runs
07:00 — Daily brief → log.md
18:00 — End-of-day summary → log.md
`;
