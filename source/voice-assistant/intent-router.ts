import type { ActionName } from "./actions.js";
import { looksSecret } from "./memory.js";

// Cheap local routing: obvious commands run instantly without waking Grok.
// Anything that is not clearly a command falls through to the LLM.

export type RoutedIntent =
  | { readonly kind: "action"; readonly action: ActionName; readonly args: Record<string, unknown> }
  | { readonly kind: "stop" }
  | { readonly kind: "remember"; readonly fact: string }
  | { readonly kind: "connect-calendar" }
  | { readonly kind: "join-meeting" }
  | { readonly kind: "llm" };

const STOP = /^(stop|cancel|shut up|quiet|para|pára|cala-te|cancela|silêncio|chega)[.!]?$/iu;
const TIME = /^(what time is it|what's the time|que horas são|diz-me as horas|que dia é hoje)\??$/iu;
const VOLUME = /^(?:set (?:the )?volume to|volume(?: a| para| to)?|põe o volume a|mete o volume a)\s*(\d{1,3})\s*%?$/iu;
const OPEN = /^(?:open|launch|abre|abrir|lança)\s+(?:o |a |the )?(.+?)[.!]?$/iu;
const NOTE = /^(?:take a note|note|anota|toma nota)[:,]?\s+(.+)$/iu;
// Only explicit "remember that …" facts are stored locally; "remind me to …" style requests need Grok.
const REMEMBER = /^(?:remember that|lembra-te (?:de )?que|memoriza que|não te esqueças (?:de )?que)[:,]?\s+(.{3,})$/iu;
const CONNECT_CALENDAR = /^(?:(?:liga|ligar|conecta|conectar|associa)(?: o)?(?: meu)?(?: google)? calend[aá]rio(?: (?:do )?google)?|connect (?:my |the )?(?:google )?calendar)[.!]?$/iu;
const JOIN_MEETING = /^(?:(?:abre|abrir|entra|entrar|junta-te|liga-me|vamos)(?: (?:na|à|a|o|no|para a))? (?:reuni[ãa]o|meet|google meet|chamada|videochamada)|join(?: the| my)? (?:meeting|call|meet)|open(?: the)? (?:meeting|meet|google meet))[.!]?$/iu;
const URL_LIKE = /^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i;

export function routeIntent(transcript: string): RoutedIntent {
  const text = transcript.trim().replace(/\s+/g, " ");
  if (!text) return { kind: "llm" };
  if (STOP.test(text)) return { kind: "stop" };
  if (TIME.test(text)) return { kind: "action", action: "get_time", args: {} };

  const volume = VOLUME.exec(text);
  if (volume?.[1] !== undefined) {
    const level = Number(volume[1]);
    if (level <= 100) return { kind: "action", action: "set_volume", args: { level } };
  }

  if (CONNECT_CALENDAR.test(text)) return { kind: "connect-calendar" };
  // Before OPEN, which would otherwise try to launch an app called "reunião".
  if (JOIN_MEETING.test(text)) return { kind: "join-meeting" };

  const remember = REMEMBER.exec(text);
  // Secrets go to Grok, which explains why it will not store them.
  if (remember?.[1] && !looksSecret(remember[1])) return { kind: "remember", fact: remember[1].replace(/[.!]+$/, "") };

  const note = NOTE.exec(text);
  if (note?.[1]) return { kind: "action", action: "take_note", args: { text: note[1] } };

  const open = OPEN.exec(text);
  if (open?.[1]) {
    const target = open[1];
    if (URL_LIKE.test(target)) {
      return { kind: "action", action: "open_url", args: { url: target.includes("://") ? target : `https://${target}` } };
    }
    // Multi-word requests ("open the report I was writing yesterday") need reasoning.
    if (target.split(" ").length <= 3) return { kind: "action", action: "open_app", args: { name: target } };
  }
  return { kind: "llm" };
}
