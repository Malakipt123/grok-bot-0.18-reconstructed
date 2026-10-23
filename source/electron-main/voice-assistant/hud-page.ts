// Self-contained page for the Jarvis HUD window. It has no Node access and no
// network access; the main process drives it through window.hud.update(...).

export interface HudLabels {
  readonly listening: string;
  readonly thinking: string;
  readonly speaking: string;
  readonly idle: string;
}

export const HUD_LABELS: Record<string, HudLabels> = {
  pt: { listening: "A ouvir…", thinking: "A pensar…", speaking: "A falar", idle: "Pronto" },
  en: { listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", idle: "Ready" },
};

export function hudLabels(language: string): HudLabels {
  return HUD_LABELS[language.toLowerCase().split(/[-_]/)[0] ?? ""] ?? HUD_LABELS.en!;
}

export function renderHudPage(labels: HudLabels): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { --cyan: #46e8ff; --cyan-soft: rgba(70, 232, 255, .35); --amber: #ffc46b; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; cursor: default;
    font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; color: #e8fbff; }
  .hud { position: absolute; inset: 10px; display: grid; grid-template-columns: 112px 1fr; align-items: center;
    border-radius: 26px; background: radial-gradient(120% 140% at 0% 50%, rgba(18, 56, 72, .92), rgba(5, 12, 20, .9) 60%);
    border: 1px solid var(--cyan-soft); box-shadow: 0 0 24px rgba(70, 232, 255, .18), inset 0 0 22px rgba(70, 232, 255, .08);
    opacity: 0; transform: translateY(-8px) scale(.98); transition: opacity .25s ease, transform .25s ease; }
  .hud.visible { opacity: 1; transform: none; }
  .hud[data-state="thinking"] { --cyan: var(--amber); --cyan-soft: rgba(255, 196, 107, .35); }
  canvas { display: block; }
  .body { display: flex; flex-direction: column; gap: 4px; padding: 0 22px 0 0; min-width: 0; }
  .title { display: flex; justify-content: space-between; align-items: baseline; letter-spacing: .28em; font-size: 10px;
    color: var(--cyan); text-shadow: 0 0 8px var(--cyan-soft); }
  .state { letter-spacing: .08em; font-size: 11px; color: rgba(232, 251, 255, .75); }
  .line { height: 34px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    line-height: 17px; font-size: 12.5px; color: #f2fdff; }
  .line.you { color: rgba(232, 251, 255, .6); font-style: italic; }
  .line.jarvis { display: block; scroll-behavior: smooth; }
  .w { color: rgba(242, 253, 255, .42); transition: color .18s ease, text-shadow .18s ease; animation: word-in .22s ease-out both; }
  .w.spoken { color: #ffffff; text-shadow: 0 0 7px var(--cyan-soft); }
  @keyframes word-in { from { opacity: 0; filter: blur(2px); } to { opacity: 1; filter: none; } }
</style></head>
<body>
<div class="hud" id="hud" data-state="idle">
  <canvas id="ring" width="224" height="224" style="width:112px;height:112px"></canvas>
  <div class="body">
    <div class="title"><span>J.A.R.V.I.S</span><span class="state" id="state">${escapeHtml(labels.idle)}</span></div>
    <canvas id="wave" width="560" height="68" style="width:280px;height:34px"></canvas>
    <div class="line" id="line"></div>
  </div>
</div>
<script>
(() => {
  const labels = ${JSON.stringify(labels)};
  const hud = document.getElementById("hud");
  const stateLabel = document.getElementById("state");
  const line = document.getElementById("line");
  const ring = document.getElementById("ring").getContext("2d");
  const wave = document.getElementById("wave").getContext("2d");
  const BARS = 56;
  const history = new Array(BARS).fill(0);
  let state = "idle", level = 0, target = 0, spin = 0;
  // Current Jarvis reply, rendered as one span per word.
  let replyText = "", wordSpans = [], spokenWords = 0;

  function startReply() {
    replyText = ""; wordSpans = []; spokenWords = 0;
    line.textContent = "";
    line.className = "line jarvis";
  }

  function appendReply(delta) {
    if (!line.classList.contains("jarvis")) startReply();
    replyText += delta;
    const words = replyText.trim().split(/\\s+/).filter(Boolean);
    // The last word may still be growing, so it is updated in place.
    if (wordSpans.length > 0 && words.length >= wordSpans.length) wordSpans[wordSpans.length - 1].textContent = words[wordSpans.length - 1];
    for (let index = wordSpans.length; index < words.length; index += 1) {
      if (index > 0) line.appendChild(document.createTextNode(" "));
      const span = document.createElement("span");
      span.className = index < spokenWords ? "w spoken" : "w";
      span.textContent = words[index];
      line.appendChild(span);
      wordSpans.push(span);
    }
    line.scrollTop = line.scrollHeight;
  }

  function markSpoken(count) {
    const next = Math.min(Math.max(0, Math.floor(Number(count) || 0)), 1000000);
    for (let index = spokenWords; index < Math.min(next, wordSpans.length); index += 1) wordSpans[index].classList.add("spoken");
    spokenWords = Math.max(spokenWords, next);
  }

  const color = () => getComputedStyle(hud).getPropertyValue("--cyan").trim() || "#46e8ff";

  function drawRing(now) {
    const c = color(), size = 224, mid = size / 2;
    ring.clearRect(0, 0, size, size);
    const pulse = state === "thinking" ? (Math.sin(now / 180) + 1) / 2 : level;
    spin += state === "thinking" ? 0.06 : 0.012 + level * 0.05;
    ring.save();
    ring.translate(mid, mid);
    ring.shadowColor = c;
    ring.shadowBlur = 18 + pulse * 22;
    ring.strokeStyle = c;
    // Outer segmented ring.
    ring.lineWidth = 5;
    for (let i = 0; i < 12; i += 1) {
      const start = spin + (i * Math.PI) / 6;
      ring.globalAlpha = 0.35 + (i % 3 === 0 ? 0.5 : 0.15);
      ring.beginPath(); ring.arc(0, 0, 86, start, start + Math.PI / 9); ring.stroke();
    }
    // Counter-rotating inner ring.
    ring.globalAlpha = 0.75;
    ring.lineWidth = 3;
    ring.setLineDash([14, 10]);
    ring.rotate(-spin * 1.6);
    ring.beginPath(); ring.arc(0, 0, 62, 0, Math.PI * 2); ring.stroke();
    ring.setLineDash([]);
    // Core that breathes with the voice.
    ring.globalAlpha = 1;
    const core = 24 + pulse * 16;
    const gradient = ring.createRadialGradient(0, 0, 2, 0, 0, core);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.35, c);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ring.fillStyle = gradient;
    ring.beginPath(); ring.arc(0, 0, core, 0, Math.PI * 2); ring.fill();
    ring.restore();
  }

  function drawWave(now) {
    const c = color(), width = 560, height = 68, mid = height / 2;
    wave.clearRect(0, 0, width, height);
    const gap = width / BARS;
    wave.fillStyle = c;
    wave.shadowColor = c;
    wave.shadowBlur = 10;
    for (let i = 0; i < BARS; i += 1) {
      let value;
      if (state === "thinking") value = 0.18 + 0.14 * Math.sin(now / 160 - i * 0.35);
      else if (state === "idle") value = 0.03;
      else value = Math.max(0.04, history[i]);
      const barHeight = Math.max(3, value * (height - 6));
      wave.globalAlpha = 0.45 + 0.55 * (i / BARS);
      const x = i * gap + gap * 0.2;
      const w = gap * 0.6;
      wave.beginPath();
      if (wave.roundRect) wave.roundRect(x, mid - barHeight / 2, w, barHeight, w / 2); else wave.rect(x, mid - barHeight / 2, w, barHeight);
      wave.fill();
    }
  }

  let lastShift = 0;
  function frame(now) {
    level += (target - level) * 0.35;
    target *= 0.9;
    if (now - lastShift > 33) {
      history.shift(); history.push(level);
      lastShift = now;
    }
    drawRing(now);
    drawWave(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.hud = {
    update(event) {
      if (!event || typeof event !== "object") return;
      if (event.type === "state") {
        state = event.state;
        hud.dataset.state = state;
        stateLabel.textContent = labels[state] || "";
        if (state === "listening") { history.fill(0); line.textContent = ""; line.className = "line"; }
        hud.classList.toggle("visible", true);
      } else if (event.type === "levels" && Array.isArray(event.levels)) {
        for (const value of event.levels) target = Math.max(target, Math.min(1, Math.max(0, Number(value) || 0)));
      } else if (event.type === "text") {
        if (event.speaker === "jarvis") { startReply(); appendReply(String(event.text || "")); markSpoken(1000000); }
        else { line.textContent = String(event.text || ""); line.className = "line you"; }
        hud.classList.add("visible");
      } else if (event.type === "reply-start") {
        startReply();
        hud.classList.add("visible");
      } else if (event.type === "reply-delta") {
        appendReply(String(event.text || ""));
        hud.classList.add("visible");
      } else if (event.type === "spoken") {
        markSpoken(event.words);
      } else if (event.type === "hide") {
        hud.classList.remove("visible");
      }
    },
  };
})();
</script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
