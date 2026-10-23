import { spawn } from "node:child_process";

import { startDesktopVoiceAssistant, type DesktopVoiceAssistant, type DesktopVoiceDeps } from "../../voice-assistant/desktop-controller.js";
import { JarvisHudWindow, type HudElectronPorts } from "./hud-window.js";

interface ElectronVoiceRuntime extends HudElectronPorts {
  readonly globalShortcut: { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void };
  readonly Notification: (new (options: { title: string; body: string; silent?: boolean }) => { show(): void }) & { isSupported(): boolean };
  readonly systemPreferences: {
    getMediaAccessStatus?(mediaType: "microphone"): string;
    askForMediaAccess?(mediaType: "microphone"): Promise<boolean>;
  };
}

function loadElectronVoiceRuntime(moduleName: string): ElectronVoiceRuntime {
  return require(moduleName) as ElectronVoiceRuntime;
}

export interface ElectronVoiceAssistantBindings {
  readonly readSecret: (key: string) => Promise<string | null>;
  readonly reportFailure: (leg: string, error: unknown) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly log?: (message: string) => void;
}

const MAC_CUES = { start: "/System/Library/Sounds/Tink.aiff", stop: "/System/Library/Sounds/Pop.aiff" } as const;

export function createElectronVoiceAssistantDeps(bindings: ElectronVoiceAssistantBindings, electron = loadElectronVoiceRuntime("electron")): DesktopVoiceDeps {
  const { globalShortcut, Notification, systemPreferences } = electron;
  const hud = bindings.env.JARVIS_HUD?.trim().toLowerCase() === "off" ? undefined : new JarvisHudWindow(electron, bindings.env.JARVIS_LANGUAGE || "pt");
  return {
    ...(hud ? { hud } : {}),
    env: bindings.env,
    readSecret: bindings.readSecret,
    reportFailure: bindings.reportFailure,
    shortcut: {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    },
    requestMicrophoneAccess: async () => {
      if (bindings.platform !== "darwin") return true;
      if (systemPreferences.getMediaAccessStatus?.("microphone") === "granted") return true;
      return (await systemPreferences.askForMediaAccess?.("microphone")) ?? false;
    },
    cue: (kind) => {
      if (bindings.platform !== "darwin") return;
      const child = spawn("afplay", [MAC_CUES[kind]], { stdio: "ignore", detached: true });
      child.on("error", () => undefined);
      child.unref();
    },
  };
}

/** Starts the global Option+Space voice assistant in the background; never blocks app startup. */
export function startElectronVoiceAssistant(bindings: ElectronVoiceAssistantBindings): { dispose(): void } {
  let assistant: DesktopVoiceAssistant | null = null;
  let disposed = false;
  const log = bindings.log ?? ((message: string) => process.stdout.write(`[voice-assistant] ${message}\n`));
  void (async () => {
    try {
      const result = await startDesktopVoiceAssistant(createElectronVoiceAssistantDeps(bindings));
      if (result.status !== "started") return log(result.detail);
      if (disposed) return result.assistant.dispose();
      assistant = result.assistant;
      log(`Ready. Press ${assistant.accelerator} to talk.`);
    } catch (error) {
      bindings.reportFailure("start", error);
    }
  })();
  return {
    dispose() {
      disposed = true;
      assistant?.dispose();
      assistant = null;
    },
  };
}
