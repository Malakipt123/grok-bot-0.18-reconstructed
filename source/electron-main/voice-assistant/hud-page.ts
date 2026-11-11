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
  /* Arc-reactor look: each state has its own colour, and every glow, ring and bar follows it. */
  @property --sweep { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
  :root { --cyan: #46e8ff; --cyan-soft: rgba(70, 232, 255, .38); --cyan-faint: rgba(70, 232, 255, .12); --amber: #ffc46b; --white: #f2fdff; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; cursor: default;
    font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; color: #e8fbff; }
  .hud { position: absolute; inset: 10px; display: grid; grid-template-columns: 116px 1fr; align-items: center; isolation: isolate;
    border-radius: 24px; overflow: hidden;
    background:
      radial-gradient(90% 160% at 0% 50%, color-mix(in srgb, var(--cyan) 22%, transparent), transparent 62%),
      linear-gradient(135deg, rgba(10, 30, 44, .95), rgba(3, 8, 15, .94) 70%);
    box-shadow: 0 0 0 1px var(--cyan-soft), 0 0 28px var(--cyan-faint), 0 0 60px color-mix(in srgb, var(--cyan) 14%, transparent), inset 0 0 26px var(--cyan-faint);
    opacity: 0; transform: translateY(-10px) scale(.96); transition: opacity .28s ease, transform .32s cubic-bezier(.2, 1.4, .4, 1), box-shadow .4s ease; }
  /* A bright arc that sweeps around the border. */
  .hud::before { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1.5px; z-index: -1; pointer-events: none;
    background: conic-gradient(from var(--sweep), transparent 0 62%, var(--cyan) 78%, #ffffff 80%, var(--cyan) 82%, transparent 96%);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
    animation: sweep 3.2s linear infinite; opacity: .9; }
  /* Faint scanlines and a grid, like a projected display. */
  .hud::after { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none; opacity: .5;
    background:
      repeating-linear-gradient(0deg, rgba(255, 255, 255, .025) 0 1px, transparent 1px 3px),
      linear-gradient(90deg, var(--cyan-faint) 1px, transparent 1px) 0 0 / 22px 22px;
    -webkit-mask: linear-gradient(90deg, transparent 20%, #000 60%, transparent); mask: linear-gradient(90deg, transparent 20%, #000 60%, transparent); }
  .hud.visible { opacity: 1; transform: none; }
  .hud[data-state="idle"] { --cyan: #5fb7c9; --cyan-soft: rgba(95, 183, 201, .3); --cyan-faint: rgba(95, 183, 201, .08); }
  .hud[data-state="listening"] { --cyan: #46e8ff; --cyan-soft: rgba(70, 232, 255, .45); --cyan-faint: rgba(70, 232, 255, .16); }
  .hud[data-state="thinking"] { --cyan: var(--amber); --cyan-soft: rgba(255, 196, 107, .45); --cyan-faint: rgba(255, 196, 107, .15); }
  .hud[data-state="speaking"] { --cyan: #7af3ff; --cyan-soft: rgba(122, 243, 255, .5); --cyan-faint: rgba(122, 243, 255, .18); }
  .hud[data-state="thinking"]::before { animation-duration: 1.1s; }
  .hud[data-state="listening"]::before { animation-duration: 2s; }
  /* Corner brackets. */
  .corner { position: absolute; width: 14px; height: 14px; border: 2px solid var(--cyan); opacity: .7; filter: drop-shadow(0 0 4px var(--cyan)); pointer-events: none; }
  .corner.tl { top: 7px; left: 7px; border-right: 0; border-bottom: 0; border-top-left-radius: 10px; }
  .corner.tr { top: 7px; right: 7px; border-left: 0; border-bottom: 0; border-top-right-radius: 10px; }
  .corner.bl { bottom: 7px; left: 7px; border-right: 0; border-top: 0; border-bottom-left-radius: 10px; }
  .corner.br { bottom: 7px; right: 7px; border-left: 0; border-top: 0; border-bottom-right-radius: 10px; }
  canvas { display: block; }
  .body { display: flex; flex-direction: column; gap: 5px; padding: 0 22px 0 2px; min-width: 0; }
  .title { display: flex; justify-content: space-between; align-items: center; }
  .name { font-size: 11px; font-weight: 700; letter-spacing: .34em; color: var(--white);
    text-shadow: 0 0 6px var(--cyan), 0 0 16px var(--cyan-soft); }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 7px; border-radius: 999px;
    font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--cyan);
    background: var(--cyan-faint); box-shadow: inset 0 0 0 1px var(--cyan-soft); transition: color .3s ease, background .3s ease; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--cyan); box-shadow: 0 0 8px var(--cyan); animation: blink 1.6s ease-in-out infinite; }
  .hud[data-state="listening"] .dot { animation-duration: .7s; }
  .hud[data-state="thinking"] .dot { animation-duration: .45s; }
  .hud[data-state="idle"] .dot { animation: none; opacity: .55; }
  .line { height: 34px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    line-height: 17px; font-size: 12.5px; color: var(--white); }
  .line.you { color: rgba(232, 251, 255, .62); font-style: italic; }
  .line.you::before { content: "› "; color: var(--cyan); font-style: normal; }
  .line.jarvis { display: block; scroll-behavior: smooth; }
  .w { color: rgba(242, 253, 255, .38); transition: color .18s ease, text-shadow .18s ease; animation: word-in .24s ease-out both; }
  .w.spoken { color: #ffffff; text-shadow: 0 0 6px var(--cyan), 0 0 14px var(--cyan-soft); }
  @keyframes word-in { from { opacity: 0; filter: blur(3px); transform: translateY(2px); } to { opacity: 1; filter: none; transform: none; } }
  @keyframes sweep { to { --sweep: 360deg; } }
  @keyframes blink { 50% { opacity: .25; transform: scale(.7); } }
  @media (prefers-reduced-motion: reduce) {
    .hud::before, .dot, .w { animation: none; }
    .hud { transition: opacity .2s ease; transform: none; }
  }
</style></head>
<body>
<div class="hud" id="hud" data-state="idle">
  <span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
  <canvas id="ring" width="232" height="232" style="width:116px;height:116px"></canvas>
  <div class="body">
    <div class="title"><span class="name">J.A.R.V.I.S</span><span class="chip"><span class="dot"></span><span id="state">${escapeHtml(labels.idle)}</span></span></div>
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
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let sweep = 0;

  // Arc reactor: tick dial, segmented outer ring, sweeping scanner, ten coils and a glowing core.
  function drawRing(now) {
    const c = color(), size = 232, mid = size / 2;
    ring.clearRect(0, 0, size, size);
    const thinking = state === "thinking";
    const pulse = thinking ? (Math.sin(now / 160) + 1) / 2 : state === "idle" ? 0.15 + 0.1 * Math.sin(now / 900) : level;
    const speed = reducedMotion ? 0.2 : 1;
    spin += (thinking ? 0.06 : 0.012 + level * 0.05) * speed;
    sweep += (thinking ? 0.11 : 0.035 + level * 0.08) * speed;
    ring.save();
    ring.translate(mid, mid);
    ring.strokeStyle = c;
    ring.fillStyle = c;
    ring.shadowColor = c;

    // Tick dial; the ticks near the scanner light up.
    ring.shadowBlur = 6;
    for (let i = 0; i < 72; i += 1) {
      const angle = (i / 72) * Math.PI * 2;
      const behind = (((sweep - angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      ring.globalAlpha = 0.18 + 0.8 * Math.max(0, 1 - behind / 1.2);
      const long = i % 6 === 0;
      ring.lineWidth = long ? 2.4 : 1.4;
      ring.beginPath();
      ring.moveTo(Math.cos(angle) * (long ? 98 : 101), Math.sin(angle) * (long ? 98 : 101));
      ring.lineTo(Math.cos(angle) * 107, Math.sin(angle) * 107);
      ring.stroke();
    }

    // Scanner wedge.
    ring.globalAlpha = 0.22 + pulse * 0.2;
    const wedge = ring.createRadialGradient(0, 0, 40, 0, 0, 96);
    wedge.addColorStop(0, "rgba(0,0,0,0)");
    wedge.addColorStop(1, c);
    ring.fillStyle = wedge;
    ring.beginPath(); ring.moveTo(0, 0); ring.arc(0, 0, 96, sweep - 0.7, sweep); ring.closePath(); ring.fill();
    ring.fillStyle = c;

    // Segmented outer ring.
    ring.shadowBlur = 16 + pulse * 26;
    ring.lineWidth = 6;
    for (let i = 0; i < 12; i += 1) {
      const start = spin + (i * Math.PI) / 6;
      ring.globalAlpha = 0.35 + (i % 3 === 0 ? 0.6 : 0.2);
      ring.beginPath(); ring.arc(0, 0, 88, start, start + Math.PI / 9); ring.stroke();
    }

    // Counter-rotating dashed ring.
    ring.globalAlpha = 0.8;
    ring.lineWidth = 2.5;
    ring.setLineDash([12, 8]);
    ring.save(); ring.rotate(-spin * 1.6);
    ring.beginPath(); ring.arc(0, 0, 70, 0, Math.PI * 2); ring.stroke();
    ring.restore();
    ring.setLineDash([]);

    // Ten coils, like the reactor's copper windings, brighter with the voice.
    ring.save(); ring.rotate(spin * 0.5);
    for (let i = 0; i < 10; i += 1) {
      ring.rotate(Math.PI / 5);
      ring.globalAlpha = 0.45 + pulse * 0.5;
      ring.beginPath();
      ring.moveTo(-6, -58); ring.lineTo(6, -58); ring.lineTo(4, -42); ring.lineTo(-4, -42); ring.closePath();
      ring.fill();
    }
    ring.restore();

    // Inner ring and breathing core with a white-hot centre.
    ring.globalAlpha = 0.9;
    ring.lineWidth = 2;
    ring.beginPath(); ring.arc(0, 0, 38, 0, Math.PI * 2); ring.stroke();
    ring.globalAlpha = 1;
    ring.shadowBlur = 30 + pulse * 40;
    const core = 22 + pulse * 14;
    const gradient = ring.createRadialGradient(0, 0, 1, 0, 0, core + 10);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.3, "#ffffff");
    gradient.addColorStop(0.55, c);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ring.fillStyle = gradient;
    ring.beginPath(); ring.arc(0, 0, core + 10, 0, Math.PI * 2); ring.fill();
    ring.restore();
  }

  // Mirrored equaliser bars with bright caps.
  function drawWave(now) {
    const c = color(), width = 560, height = 68, mid = height / 2;
    wave.clearRect(0, 0, width, height);
    const gap = width / BARS;
    const fill = wave.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, "#ffffff");
    fill.addColorStop(0.5, c);
    fill.addColorStop(1, "#ffffff");
    wave.shadowColor = c;
    wave.shadowBlur = 12;
    for (let i = 0; i < BARS; i += 1) {
      let value;
      if (state === "thinking") value = 0.2 + 0.16 * Math.sin(now / 150 - i * 0.35) + 0.06 * Math.sin(now / 70 + i);
      else if (state === "idle") value = 0.035 + 0.02 * Math.sin(now / 600 + i * 0.4);
      else value = Math.max(0.05, history[i]);
      const barHeight = Math.max(3, value * (height - 6));
      const fade = Math.sin((i / (BARS - 1)) * Math.PI);
      wave.globalAlpha = 0.35 + 0.65 * fade;
      const x = i * gap + gap * 0.22;
      const w = gap * 0.56;
      wave.fillStyle = fill;
      wave.beginPath();
      if (wave.roundRect) wave.roundRect(x, mid - barHeight / 2, w, barHeight, w / 2); else wave.rect(x, mid - barHeight / 2, w, barHeight);
      wave.fill();
    }
    // Baseline.
    wave.globalAlpha = 0.25;
    wave.fillStyle = c;
    wave.fillRect(0, mid - 0.5, width, 1);
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
