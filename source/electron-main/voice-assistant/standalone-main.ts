import os from "node:os";
import path from "node:path";

import { startElectronVoiceAssistant } from "./electron-voice-assistant.js";
import type { HudElectronPorts } from "./hud-window.js";

// Jarvis on its own: a tray icon, the global shortcut and the HUD, without the
// rest of Grok Bot. This is how Windows (and Linux) run the assistant, since
// only the macOS app is packaged. Started by `npm run jarvis`.

interface TrayMenuItem {
  readonly label?: string;
  readonly type?: "normal" | "separator" | "checkbox";
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly click?: () => void;
}

interface StandaloneElectron extends HudElectronPorts {
  readonly app: {
    setName(name: string): void;
    setAppUserModelId(id: string): void;
    requestSingleInstanceLock(): boolean;
    whenReady(): Promise<void>;
    on(event: "window-all-closed" | "will-quit", listener: () => void): void;
    quit(): void;
    getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean };
    setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void;
    readonly dock?: { hide(): void };
  };
  readonly Tray: new (image: unknown) => { setToolTip(text: string): void; setContextMenu(menu: unknown): void; destroy(): void };
  readonly Menu: { buildFromTemplate(items: TrayMenuItem[]): unknown };
  readonly nativeImage: { createFromBitmap(buffer: Buffer, options: { width: number; height: number; scaleFactor?: number }): unknown };
  readonly Notification: (new (options: { title: string; body: string; silent?: boolean }) => { show(): void }) & { isSupported(): boolean };
  readonly shell: { openPath(path: string): Promise<string> };
}

const electron = require("electron") as StandaloneElectron;
const { app } = electron;
const portuguese = (process.env.JARVIS_LANGUAGE || "pt").toLowerCase().startsWith("pt");
const loginItem = { path: process.execPath, args: [path.resolve(process.argv[1] ?? __filename)] };

/** A 32×32 cyan ring like the HUD's arc reactor, drawn in code so no icon file is needed. */
export function ringIcon(size = 32): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - centre, y - centre) / (size / 2);
      const ring = Math.max(0, 1 - Math.abs(distance - 0.72) / 0.14);
      const core = Math.max(0, 1 - distance / 0.32);
      const alpha = Math.round(255 * Math.min(1, ring + core));
      const offset = (y * size + x) * 4;
      // BGRA
      pixels[offset] = 255;
      pixels[offset + 1] = 220;
      pixels[offset + 2] = 80;
      pixels[offset + 3] = alpha;
    }
  }
  return pixels;
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
  // HUD windows come and go; closing the last one must not quit the assistant.
  app.on("window-all-closed", () => undefined);

  void app.whenReady().then(() => {
    app.dock?.hide();
    const tray = new electron.Tray(electron.nativeImage.createFromBitmap(ringIcon(), { width: 32, height: 32, scaleFactor: 2 }));
    let status = portuguese ? "A iniciar…" : "Starting…";
    const profileDirectory = path.dirname(process.env.JARVIS_PROFILE || path.join(os.homedir(), ".grok-bot", "voice-assistant", "ASSISTANT.md"));
    const refreshMenu = () => {
      tray.setToolTip(`Jarvis · ${status}`);
      tray.setContextMenu(electron.Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: "separator" },
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

    const assistant = startElectronVoiceAssistant({
      // No app secrets store here: keys come from the environment (setx on Windows).
      readSecret: async () => null,
      reportFailure: (leg, error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[jarvis] ${leg}: ${message}\n`);
        notify(message);
      },
      env: process.env,
      platform: process.platform,
      log: (message) => {
        process.stdout.write(`[jarvis] ${message}\n`);
        status = message;
        refreshMenu();
        notify(message);
      },
    });
    app.on("will-quit", () => {
      assistant.dispose();
      tray.destroy();
    });
  });
}
