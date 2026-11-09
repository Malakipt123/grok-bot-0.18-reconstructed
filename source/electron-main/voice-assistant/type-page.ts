// The "type to Jarvis" window: a box to type in and the conversation below
// it. Like the HUD and the setup window, the page has no Node and no network
// access. It signals the main process by setting document.title (TYPE_ASK_TITLE
// with the text kept in the page, or TYPE_CLOSE_TITLE), and the main process
// streams the reply back through window.chat.

export const TYPE_ASK_TITLE = "jarvis:ask";
export const TYPE_CLOSE_TITLE = "jarvis:close";
export const TYPE_WIDTH = 560;
export const TYPE_HEIGHT = 420;

export interface TypeLabels {
  readonly title: string;
  readonly placeholder: string;
  readonly hint: string;
  readonly you: string;
  readonly thinking: string;
}

export const TYPE_LABELS: Record<string, TypeLabels> = {
  pt: { title: "Escrever ao Jarvis", placeholder: "Escreve e carrega em Enter…", hint: "Enter envia · Shift+Enter muda de linha · Esc fecha", you: "Tu", thinking: "A pensar…" },
  en: { title: "Type to Jarvis", placeholder: "Type and press Enter…", hint: "Enter sends · Shift+Enter new line · Esc closes", you: "You", thinking: "Thinking…" },
};

export function typeLabels(language: string): TypeLabels {
  return TYPE_LABELS[language.toLowerCase().split(/[-_]/)[0] ?? ""] ?? TYPE_LABELS.en!;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function renderTypePage(labels: TypeLabels): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(labels.title)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; --cyan: #46e8ff; }
  html, body { margin: 0; height: 100%; background: #07131d; color: #e8fbff; font: 14px "Segoe UI", -apple-system, system-ui, sans-serif; }
  main { height: 100%; box-sizing: border-box; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  #log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
  .msg { line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .you { color: rgba(232, 251, 255, .6); }
  .you::before { content: attr(data-who) ": "; font-weight: 600; }
  .jarvis::before { content: "Jarvis: "; font-weight: 600; color: var(--cyan); }
  .jarvis.pending { color: rgba(232, 251, 255, .55); font-style: italic; }
  textarea { font: inherit; resize: none; height: 3.2em; padding: 9px 11px; border-radius: 8px; border: 1px solid rgba(70, 232, 255, .35);
    background: rgba(255, 255, 255, .04); color: #fff; outline: none; }
  textarea:focus { border-color: var(--cyan); box-shadow: 0 0 0 3px rgba(70, 232, 255, .15); }
  .hint { font-size: 11px; color: rgba(232, 251, 255, .45); }
</style></head>
<body><main>
  <div id="log" aria-live="polite"></div>
  <textarea id="input" placeholder="${escapeHtml(labels.placeholder)}" spellcheck="true" autofocus></textarea>
  <div class="hint">${escapeHtml(labels.hint)}</div>
</main>
<script>
(() => {
  const labels = ${JSON.stringify(labels)};
  const log = document.getElementById("log");
  const input = document.getElementById("input");
  const title = document.title;
  let current = null;
  let pendingText = "";
  const add = (cls, text) => {
    const element = document.createElement("div");
    element.className = "msg " + cls;
    element.textContent = text;
    if (cls === "you") element.dataset.who = labels.you;
    log.appendChild(element);
    log.scrollTop = log.scrollHeight;
    return element;
  };
  const signal = (value) => {
    document.title = value;
    setTimeout(() => { document.title = title; }, 300);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); signal(${JSON.stringify(TYPE_CLOSE_TITLE)}); return; }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text || current) return;
    pendingText = text;
    input.value = "";
    add("you", text);
    current = add("jarvis pending", labels.thinking);
    current.dataset.empty = "1";
    signal(${JSON.stringify(TYPE_ASK_TITLE)});
  });
  window.chat = {
    // Read once by the main process right after the ask signal.
    take: () => { const text = pendingText; pendingText = ""; return text; },
    delta: (text) => {
      if (!current) return;
      if (current.dataset.empty) { current.textContent = ""; delete current.dataset.empty; current.classList.remove("pending"); }
      current.textContent += text;
      log.scrollTop = log.scrollHeight;
    },
    done: (text) => {
      if (!current) return;
      // Local commands answer without streaming: show the final text then.
      if (current.dataset.empty || !current.textContent.trim()) { current.textContent = text || "…"; delete current.dataset.empty; }
      current.classList.remove("pending");
      current = null;
      input.focus();
    },
    focus: () => input.focus(),
  };
})();
</script>
</body></html>`;
}
