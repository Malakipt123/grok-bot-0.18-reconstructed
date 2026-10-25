import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { VOICE_SECRET_KEYS } from "../../voice-assistant/desktop-controller.js";
import { startElectronVoiceAssistant } from "./electron-voice-assistant.js";
import type { HudElectronPorts } from "./hud-window.js";
import { ringIcon } from "./ring-icon.js";
import { KEY_STORE_FILENAME, KeyStore, type SecretCipher } from "./key-store.js";
import { renderSetupPage, SETUP_HEIGHT, SETUP_SAVE_TITLE, SETUP_WIDTH, setupFields, setupLabels } from "./setup-page.js";

// Jarvis on its own: a tray icon, the global shortcut and the HUD, without the
// rest of Grok Bot. This is how Windows (and Linux) run the assistant, since
// only the macOS app is packaged. `npm run jarvis` starts it from the source
// tree; `npm run package:windows` builds it into Jarvis-Setup.exe.

interface TrayMenuItem {
  readonly label?: string;
  readonly type?: "normal" | "separator" | "checkbox";
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly click?: () => void;
}

interface SetupWindow {
  loadURL(url: string): Promise<unknown>;
  show(): void;
  focus(): void;
  close(): void;
  isDestroyed(): boolean;
  setMenuBarVisibility?(visible: boolean): void;
  on(event: "closed", listener: () => void): void;
  readonly webContents: {
    executeJavaScript(code: string): Promise<unknown>;
    on(event: "page-title-updated", listener: (event: unknown, title: string) => void): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
  };
}

interface StandaloneElectron extends HudElectronPorts {
  readonly app: {
    readonly isPackaged: boolean;
    setName(name: string): void;
    setAppUserModelId(id: string): void;
    getPath(name: "userData"): string;
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    on(event: "window-all-closed" | "will-quit" | "second-instance", listener: () => void): void;
    quit(): void;
    getLoginItemSettings(options?: { path?: string; args?: string[]; name?: string }): { openAtLogin: boolean };
    setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[]; name?: string }): void;
    readonly dock?: { hide(): void };
  };
  readonly Tray: new (image: unknown) => { setToolTip(text: string): void; setContextMenu(menu: unknown): void; destroy(): void };
  readonly Menu: { buildFromTemplate(items: TrayMenuItem[]): unknown };
  readonly nativeImage: { createFromBitmap(buffer: Buffer, options: { width: number; height: number; scaleFactor?: number }): unknown };
  readonly Notification: (new (options: { title: string; body: string; silent?: boolean }) => { show(): void }) & { isSupported(): boolean };
  readonly shell: { openPath(path: string): Promise<string> };
  readonly safeStorage: SecretCipher;
}

const electron = require("electron") as StandaloneElectron;
const { app } = electron;
const language = process.env.JARVIS_LANGUAGE || "pt";
const portuguese = language.toLowerCase().startsWith("pt");
// Packaged, the app itself is the program; from source, Electron needs the bundle path.
// On Windows, "name" is the value under HKCU\...\Run, which the uninstaller removes.
const loginItem = app.isPackaged
  ? { path: process.execPath, args: [], name: "Jarvis" }
  : { path: process.execPath, args: [path.resolve(process.argv[1] ?? __filename)], name: "Jarvis" };
const LOGIN_DEFAULT_MARKER = "login-default.json";
// CI's Windows smoke test: write every status line to this file and quit after the first.
const smokeLog = process.env.JARVIS_SMOKE_LOG;

if (app.isPackaged && process.platform === "win32") {
  // The installer ships ffmpeg next to the app, so no separate install is needed.
  process.env.PATH = [path.join((process as NodeJS.Process & { resourcesPath: string }).resourcesPath, "ffmpeg"), process.env.PATH ?? ""].join(path.delimiter);
}

function notify(body: string): void {
  if (electron.Notification.isSupported()) new electron.Notification({ title: "Jarvis", body, silent: true }).show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Jarvis");
  // Windows only shows notifications for apps with an AppUserModelID.
  app.setAppUserModelId("com.grok-bot.jarvis");
  // HUD and setup windows come and go; closing the last one must not quit the assistant.
  app.on("window-all-closed", () => undefined);

  void app.whenReady().then(async () => {
    app.dock?.hide();
    // The installed app starts with Windows from the first run; turning it off
    // in the tray menu sticks, because the marker records that it was offered.
    const loginMarker = path.join(app.getPath("userData"), LOGIN_DEFAULT_MARKER);
    if (app.isPackaged && process.platform === "win32" && !existsSync(loginMarker)) {
      app.setLoginItemSettings({ ...loginItem, openAtLogin: true });
      writeFileSync(loginMarker, `${JSON.stringify({ openAtLoginByDefault: true, at: new Date().toISOString() })}\n`);
    }
    const keys = new KeyStore(path.join(app.getPath("userData"), KEY_STORE_FILENAME), electron.safeStorage);
    const tray = new electron.Tray(electron.nativeImage.createFromBitmap(ringIcon(), { width: 32, height: 32, scaleFactor: 2 }));
    let status = portuguese ? "A iniciar…" : "Starting…";
    let assistant: { dispose(): void } | null = null;
    let setupWindow: SetupWindow | null = null;
    const profileDirectory = path.dirname(process.env.JARVIS_PROFILE || path.join(os.homedir(), ".grok-bot", "voice-assistant", "ASSISTANT.md"));

    const log = (message: string) => {
      process.stdout.write(`[jarvis] ${message}\n`);
      status = message;
      refreshMenu();
      if (smokeLog) {
        appendFileSync(smokeLog, `${message}\n`);
        setTimeout(() => app.quit(), 1_000);
      } else {
        notify(message);
      }
    };

    const startAssistant = () => {
      assistant?.dispose();
      assistant = startElectronVoiceAssistant({
        // Environment variables win; otherwise the keys typed into the setup window.
        readSecret: (key) => keys.get(key),
        reportFailure: (leg, error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[jarvis] ${leg}: ${message}\n`);
          if (smokeLog) appendFileSync(smokeLog, `failure ${leg}: ${message}\n`);
          notify(message);
        },
        env: process.env,
        platform: process.platform,
        log,
      });
    };

    const openSetup = async () => {
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.show();
        setupWindow.focus();
        return;
      }
      const saved = new Set<string>();
      for (const field of setupFields(language, () => false)) if (await keys.has(field.key)) saved.add(field.key);
      const window = new electron.BrowserWindow({
        width: SETUP_WIDTH,
        height: SETUP_HEIGHT,
        useContentSize: true,
        resizable: false,
        maximizable: false,
        title: setupLabels(language).title,
        backgroundColor: "#07131d",
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      }) as unknown as SetupWindow;
      setupWindow = window;
      window.setMenuBarVisibility?.(false);
      window.on("closed", () => {
        if (setupWindow === window) setupWindow = null;
      });
      // The page is self-contained: no navigation, no pop-ups.
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("page-title-updated", (_event, title) => {
        if (title !== SETUP_SAVE_TITLE) return;
        void (async () => {
          const values = await window.webContents.executeJavaScript("window.jarvisSetupValues()") as Record<string, unknown>;
          await keys.save(values);
          window.close();
          startAssistant();
        })().catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)));
      });
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderSetupPage(setupFields(language, (key) => saved.has(key)), setupLabels(language), electron.safeStorage.isEncryptionAvailable()))}`);
      window.show();
    };

    const refreshMenu = () => {
      tray.setToolTip(`Jarvis · ${status}`);
      tray.setContextMenu(electron.Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: "separator" },
        { label: portuguese ? "Chaves…" : "Keys…", click: () => void openSetup() },
        {
          label: portuguese ? "Iniciar com o sistema" : "Start at login",
          type: "checkbox",
          checked: app.getLoginItemSettings(loginItem).openAtLogin,
          click: () => {
            app.setLoginItemSettings({ ...loginItem, openAtLogin: !app.getLoginItemSettings(loginItem).openAtLogin });
            refreshMenu();
          },
        },
        { label: portuguese ? "Abrir pasta do Jarvis" : "Open Jarvis folder", click: () => void electron.shell.openPath(profileDirectory) },
        { type: "separator" },
        { label: portuguese ? "Sair" : "Quit", click: () => app.quit() },
      ]));
    };
    refreshMenu();
    // Opening Jarvis again (e.g. from the Start menu) while it runs shows the keys window.
    app.on("second-instance", () => void openSetup());

    const missing: string[] = [];
    for (const key of VOICE_SECRET_KEYS) if (!process.env[key]?.trim() && !(await keys.has(key))) missing.push(key);
    if (missing.length > 0 && !smokeLog) {
      status = portuguese ? "À espera das chaves" : "Waiting for keys";
      refreshMenu();
      await openSetup();
    } else {
      startAssistant();
    }

    app.on("will-quit", () => {
      assistant?.dispose();
      tray.destroy();
    });
  });
}
