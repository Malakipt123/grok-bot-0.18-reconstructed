import type { DesktopAsk, DesktopTextInputPort } from "../../voice-assistant/desktop-controller.js";
import { renderTypePage, TYPE_ASK_TITLE, TYPE_CLOSE_TITLE, TYPE_HEIGHT, TYPE_WIDTH, typeLabels } from "./type-page.js";

interface TypeBrowserWindow {
  loadURL(url: string): Promise<unknown>;
  show(): void;
  focus(): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  on(event: "closed", listener: () => void): void;
  readonly webContents: {
    executeJavaScript(code: string): Promise<unknown>;
    on(event: "page-title-updated", listener: (event: unknown, title: string) => void): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
  };
}

export interface TypeElectronPorts {
  readonly BrowserWindow: new (options: Record<string, unknown>) => unknown;
}

/**
 * A small, focusable window to type to Jarvis. Replies stream into it as text
 * and are never spoken. Esc hides it; the conversation stays until it closes.
 */
export class JarvisTextWindow implements DesktopTextInputPort {
  readonly #electron: TypeElectronPorts;
  readonly #html: string;
  readonly #title: string;
  #window: TypeBrowserWindow | null = null;
  #ready: Promise<unknown> | null = null;
  #ask: DesktopAsk | null = null;

  constructor(electron: TypeElectronPorts, language: string) {
    this.#electron = electron;
    const labels = typeLabels(language);
    this.#html = renderTypePage(labels);
    this.#title = labels.title;
  }

  open(ask: DesktopAsk): void {
    this.#ask = ask;
    const window = this.#ensureWindow();
    window.show();
    window.focus();
    void this.#ready?.then(() => this.#run("window.chat.focus()"));
  }

  dispose(): void {
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
    this.#window = null;
  }

  #ensureWindow(): TypeBrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const window = new this.#electron.BrowserWindow({
      width: TYPE_WIDTH,
      height: TYPE_HEIGHT,
      useContentSize: true,
      title: this.#title,
      alwaysOnTop: true,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: "#07131d",
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    }) as TypeBrowserWindow;
    this.#window = window;
    window.on("closed", () => {
      if (this.#window === window) this.#window = null;
    });
    // The page is self-contained: no navigation, no pop-ups.
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("page-title-updated", (_event, title) => {
      if (title === TYPE_CLOSE_TITLE) window.hide();
      else if (title === TYPE_ASK_TITLE) void this.#answer();
    });
    this.#ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.#html)}`);
    return window;
  }

  async #answer(): Promise<void> {
    const text = await this.#run("window.chat.take()");
    if (typeof text !== "string" || !text.trim() || !this.#ask) return;
    try {
      const reply = await this.#ask(text, (delta) => void this.#run(`window.chat.delta(${JSON.stringify(delta)})`));
      await this.#run(`window.chat.done(${JSON.stringify(reply ?? "")})`);
    } catch (error) {
      await this.#run(`window.chat.done(${JSON.stringify(error instanceof Error ? error.message : String(error))})`);
    }
  }

  async #run(code: string): Promise<unknown> {
    const window = this.#window;
    if (!window || window.isDestroyed()) return undefined;
    return window.webContents.executeJavaScript(code).catch(() => undefined);
  }
}
