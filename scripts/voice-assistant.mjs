import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, ".build", "voice-assistant", "cli.mjs");
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "source/voice-assistant/cli.ts")],
  format: "esm",
  platform: "node",
  target: "node22",
  outfile,
  legalComments: "none",
  logLevel: "silent",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
