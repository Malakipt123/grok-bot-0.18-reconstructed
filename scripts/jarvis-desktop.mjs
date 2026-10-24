import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Runs Jarvis on its own in Electron (tray icon, global shortcut, HUD).
// This is the way to use the assistant on Windows and Linux.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, ".build", "jarvis", "main.cjs");
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "source/electron-main/voice-assistant/standalone-main.ts")],
  external: ["electron"],
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile,
  legalComments: "none",
  logLevel: "silent",
});

// From Node, require("electron") returns the path of the Electron binary.
const electronBinary = createRequire(import.meta.url)("electron");
const child = spawn(electronBinary, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
