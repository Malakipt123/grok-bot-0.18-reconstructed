// The first-run window that asks for the API keys. Like the HUD, the page has
// no Node and no network access. When the user saves, it sets document.title
// to SETUP_SAVE_TITLE; the main process notices the title change and reads
// the fields with executeJavaScript, so the keys never go into a URL.

import type { SetupKey } from "./key-store.js";

export const SETUP_SAVE_TITLE = "jarvis:save";
export const SETUP_WIDTH = 520;
export const SETUP_HEIGHT = 640;

export interface SetupField {
  readonly key: SetupKey;
  readonly label: string;
  readonly hint: string;
  readonly link: string | null;
  readonly required: boolean;
  /** Already saved: the field may stay blank to keep it. */
  readonly saved: boolean;
}

export interface SetupLabels {
  readonly title: string;
  readonly intro: string;
  /** For systems without OS encryption (Linux without a keyring). */
  readonly introPlain: string;
  readonly google: string;
  readonly save: string;
  readonly keep: string;
  readonly missing: string;
}

export const SETUP_LABELS: Record<string, SetupLabels> = {
  pt: {
    title: "Configurar o Jarvis",
    intro: "Cola as tuas chaves. Ficam guardadas só neste computador, cifradas pelo sistema.",
    introPlain: "Cola as tuas chaves. Ficam guardadas só neste computador, num ficheiro privado.",
    google: "Opcional: Google Calendar e Gmail",
    save: "Guardar e iniciar",
    keep: "Guardada; deixa vazio para manter",
    missing: "Falta preencher este campo.",
  },
  en: {
    title: "Set up Jarvis",
    intro: "Paste your keys. They are stored only on this computer, encrypted by the system.",
    introPlain: "Paste your keys. They are stored only on this computer, in a private file.",
    google: "Optional: Google Calendar and Gmail",
    save: "Save and start",
    keep: "Saved; leave blank to keep it",
    missing: "Please fill in this field.",
  },
};

export function setupLabels(language: string): SetupLabels {
  return SETUP_LABELS[language.toLowerCase().split(/[-_]/)[0] ?? ""] ?? SETUP_LABELS.en!;
}

export function setupFields(language: string, saved: (key: SetupKey) => boolean): SetupField[] {
  const portuguese = language.toLowerCase().startsWith("pt");
  return [
    { key: "XAI_API_KEY", label: "xAI (Grok)", hint: "xai-…", link: "https://console.x.ai", required: true, saved: saved("XAI_API_KEY") },
    { key: "ELEVENLABS_API_KEY", label: "ElevenLabs", hint: "sk_…", link: "https://elevenlabs.io/app/settings/api-keys", required: true, saved: saved("ELEVENLABS_API_KEY") },
    { key: "GOOGLE_CLIENT_ID", label: "Google Client ID", hint: "….apps.googleusercontent.com", link: null, required: false, saved: saved("GOOGLE_CLIENT_ID") },
    { key: "GOOGLE_CLIENT_SECRET", label: portuguese ? "Google Client Secret" : "Google client secret", hint: "GOCSPX-…", link: null, required: false, saved: saved("GOOGLE_CLIENT_SECRET") },
  ];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function fieldHtml(field: SetupField, labels: SetupLabels): string {
  const link = field.link ? ` <span class="link">${escapeHtml(field.link.replace(/^https:\/\//, ""))}</span>` : "";
  const placeholder = field.saved ? labels.keep : field.hint;
  const required = field.required && !field.saved ? " data-required" : "";
  return `<label>${escapeHtml(field.label)}${link}
    <input type="password" name="${field.key}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false"${required}>
  </label>`;
}

export function renderSetupPage(fields: readonly SetupField[], labels: SetupLabels, encrypted = true): string {
  const required = fields.filter((field) => field.required);
  const optional = fields.filter((field) => !field.required);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(labels.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; --cyan: #46e8ff; }
  html, body { margin: 0; background: #07131d; color: #e8fbff; font: 14px "Segoe UI", -apple-system, system-ui, sans-serif; }
  main { padding: 28px 32px; display: flex; flex-direction: column; gap: 14px; }
  h1 { margin: 0; font-size: 20px; letter-spacing: .04em; color: var(--cyan); }
  p { margin: 0; color: rgba(232, 251, 255, .75); line-height: 1.45; }
  h2 { margin: 10px 0 0; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: rgba(232, 251, 255, .55); }
  form { display: flex; flex-direction: column; gap: 14px; }
  label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
  .link { font-weight: 400; color: rgba(70, 232, 255, .8); font-size: 12px; }
  input { font: inherit; padding: 9px 11px; border-radius: 8px; border: 1px solid rgba(70, 232, 255, .35);
    background: rgba(255, 255, 255, .04); color: #fff; outline: none; }
  input:focus { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(70, 232, 255, .15); }
  input.invalid { border-color: #ff7b7b; }
  button { margin-top: 8px; font: inherit; font-weight: 600; padding: 11px; border: 0; border-radius: 8px;
    background: var(--cyan); color: #04202a; cursor: pointer; }
  #error { color: #ff9d9d; min-height: 1.2em; }
</style></head>
<body><main>
  <h1>${escapeHtml(labels.title)}</h1>
  <p>${escapeHtml(encrypted ? labels.intro : labels.introPlain)}</p>
  <form id="form">
    ${required.map((field) => fieldHtml(field, labels)).join("\n")}
    <h2>${escapeHtml(labels.google)}</h2>
    ${optional.map((field) => fieldHtml(field, labels)).join("\n")}
    <div id="error"></div>
    <button type="submit">${escapeHtml(labels.save)}</button>
  </form>
</main>
<script>
(() => {
  const form = document.getElementById("form");
  const error = document.getElementById("error");
  const title = document.title;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const empty = [...form.querySelectorAll("input[data-required]")].filter((input) => !input.value.trim());
    form.querySelectorAll("input").forEach((input) => input.classList.toggle("invalid", empty.includes(input)));
    if (empty.length > 0) { error.textContent = ${JSON.stringify(labels.missing)}; empty[0].focus(); return; }
    error.textContent = "";
    document.title = ${JSON.stringify(SETUP_SAVE_TITLE)};
    setTimeout(() => { document.title = title; }, 500);
  });
  window.jarvisSetupValues = () => Object.fromEntries([...form.querySelectorAll("input")].map((input) => [input.name, input.value]));
  form.querySelector("input")?.focus();
})();
</script>
</body></html>`;
}
