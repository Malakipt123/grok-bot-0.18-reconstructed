import type { DesktopVoiceHudEvent, DesktopVoiceHudPort } from "../../voice-assistant/desktop-controller.js";
import { hudLabels, renderHudPage } from "./hud-page.js";

export interface HudBrowserWindow {
  loadURL(url: string): Promise<unknown>;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  setPosition(x: number, y: number): void;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  readonly webContents: { executeJavaScript(code: string): Promise<unknown> };
}

export interface HudElectronPorts {
  readonly BrowserWindow: new (options: Record<string, unknown>) => HudBrowserWindow;
  readonly screen: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): { workArea: { x: number; y: number; width: number; height: number } };
  };
}

export const HUD_WIDTH = 440;
export const HUD_HEIGHT = 150;
const HIDE_AFTER_IDLE_MS = 2_500;
const HIDE_AFTER_TEXT_MS = 7_000;
const LEVEL_FLUSH_MS = 33;

type PageEvent = { type: "state"; state: string } | { type: "text"; speaker: string; text: string } | { type: "levels"; levels: number[] } | { type: "hide" };

/**
 * Floating, click-through, always-on-top HUD. The window exists only while it
 * is visible: a hidden-but-alive window would count in getAllWindows() and stop
 * macOS "activate" from recreating the main window.
 */
export class JarvisHudWindow implements DesktopVoiceHudPort {
  readonly #electron: HudElectronPorts;
  readonly #html: string;
  #window: HudBrowserWindow | null = null;
  #ready: Promise<void> | null = null;
  #pendingLevels: number[] = [];
  #levelTimer: NodeJS.Timeout | null = null;
  #hideTimer: NodeJS.Timeout | null = null;
  #disposed = false;

  constructor(electron: HudElectronPorts, language: string) {
    this.#electron = electron;
    this.#html = renderHudPage(hudLabels(language));
  }

  update(event: DesktopVoiceHudEvent): void {
    if (this.#disposed) return;
    if (event.type === "level") {
      if (!this.#window) return;
      this.#pendingLevels.push(event.level);
      this.#levelTimer ??= setTimeout(() => this.#flushLevels(), LEVEL_FLUSH_MS);
      return;
    }
    if (event.type === "state") {
      this.#clearHide();
      if (event.state === "idle") {
        if (this.#window) {
          this.#send({ type: "state", state: "idle" });
          this.#scheduleHide(HIDE_AFTER_IDLE_MS);
        }
        return;
      }
      this.#ensureWindow();
      this.#send({ type: "state", state: event.state });
      return;
    }
    const idle = !this.#window;
    this.#ensureWindow();
    this.#send({ type: "text", speaker: event.speaker, text: event.text });
    if (idle) this.#scheduleHide(HIDE_AFTER_TEXT_MS);
  }

  dispose(): void {
    this.#disposed = true;
    this.#destroyWindow();
  }

  #ensureWindow(): void {
    if (this.#window && !this.#window.isDestroyed()) return;
    const { BrowserWindow, screen } = this.#electron;
    const window = new BrowserWindow({
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: "Jarvis",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, spellcheck: false },
    });
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setPosition(Math.round(workArea.x + (workArea.width - HUD_WIDTH) / 2), Math.round(workArea.y + 18));
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setIgnoreMouseEvents(true);
    this.#window = window;
    this.#ready = window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.#html)}`)
      .then(() => {
        if (this.#window === window && !window.isDestroyed()) window.showInactive();
      })
      .catch(() => this.#destroyWindow());
  }

  #send(event: PageEvent): void {
    const window = this.#window;
    const ready = this.#ready;
    if (!window || !ready) return;
    // JSON.stringify output is a valid JS literal, so no page-controlled code is evaluated.
    const script = `window.hud && window.hud.update(${JSON.stringify(event)})`;
    void ready.then(() => (window.isDestroyed() ? undefined : window.webContents.executeJavaScript(script))).catch(() => undefined);
  }

  #flushLevels(): void {
    this.#levelTimer = null;
    const levels = this.#pendingLevels.map((level) => Math.round(Math.min(1, Math.max(0, level)) * 1000) / 1000);
    this.#pendingLevels = [];
    if (levels.length > 0) this.#send({ type: "levels", levels });
  }

  #scheduleHide(delayMs: number): void {
    this.#clearHide();
    this.#hideTimer = setTimeout(() => {
      this.#send({ type: "hide" });
      // Let the CSS fade finish before the window goes away.
      this.#hideTimer = setTimeout(() => this.#destroyWindow(), 300);
    }, delayMs);
  }

  #clearHide(): void {
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }

  #destroyWindow(): void {
    this.#clearHide();
    if (this.#levelTimer) clearTimeout(this.#levelTimer);
    this.#levelTimer = null;
    this.#pendingLevels = [];
    const window = this.#window;
    this.#window = null;
    this.#ready = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
