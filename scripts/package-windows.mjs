import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// Builds Jarvis for Windows: Electron's official win32-x64 build with the
// standalone assistant as its app, plus ffmpeg for the microphone. Produces
// dist/windows/Jarvis-win-x64.zip and, when NSIS (makensis) is installed,
// dist/windows/Jarvis-Setup.exe. Runs on Linux or macOS (CI uses Ubuntu); it
// needs `unzip` and `zip`. Every download is checked against a pinned SHA-256.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const electronZip = `electron-v${electronVersion}-win32-x64.zip`;
const electronChecksums = require("electron/checksums.json");

const FFMPEG = {
  // Gyan's "essentials" build (GPLv3), the one ffmpeg.org links for Windows.
  folder: "ffmpeg-8.0-essentials_build",
  url: "https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip",
  sha256: "647e467caf82b9fa200a562769b5ff4d736aaf725804ed2c64ea9752106fa569",
};

const cache = path.join(root, ".build", "cache");
const work = path.join(root, ".build", "windows");
const appDir = path.join(work, "Jarvis");
const out = path.join(root, "dist", "windows");

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function download(url, name, expected) {
  await mkdir(cache, { recursive: true });
  const file = path.join(cache, name);
  if (!(await exists(file))) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    await writeFile(`${file}.part`, new Uint8Array(await response.arrayBuffer()));
    await rename(`${file}.part`, file);
  }
  const actual = await sha256(file);
  if (!expected) throw new Error(`No pinned SHA-256 for ${name}. Its hash is ${actual}; review the download and pin it.`);
  if (actual !== expected) {
    await rm(file, { force: true });
    throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  return file;
}

const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version ?? "0.0.0";
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(out, { recursive: true });

// 1. Electron, with its own executable renamed and the default app removed.
const electron = await download(`https://github.com/electron/electron/releases/download/v${electronVersion}/${electronZip}`, electronZip, electronChecksums[electronZip]);
run("unzip", ["-q", electron, "-d", appDir]);
await rename(path.join(appDir, "electron.exe"), path.join(appDir, "Jarvis.exe"));
await rm(path.join(appDir, "resources", "default_app.asar"), { force: true });

// 2. The assistant itself, as a single bundled file.
const appResources = path.join(appDir, "resources", "app");
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "source/electron-main/voice-assistant/standalone-main.ts")],
  external: ["electron"],
  format: "cjs",
  platform: "node",
  target: "node22",
  outfile: path.join(appResources, "main.cjs"),
  legalComments: "eof",
  logLevel: "warning",
});
await writeFile(path.join(appResources, "package.json"), `${JSON.stringify({ name: "jarvis", productName: "Jarvis", version, main: "main.cjs" }, null, 2)}\n`);

// 3. ffmpeg, found by the app through resources/ffmpeg.
const ffmpeg = await download(FFMPEG.url, `${FFMPEG.folder}.zip`, FFMPEG.sha256);
const ffmpegDir = path.join(appDir, "resources", "ffmpeg");
await mkdir(ffmpegDir, { recursive: true });
run("unzip", ["-q", "-j", ffmpeg, `${FFMPEG.folder}/bin/ffmpeg.exe`, `${FFMPEG.folder}/LICENSE`, "-d", ffmpegDir]);
await rename(path.join(ffmpegDir, "LICENSE"), path.join(ffmpegDir, "LICENSE-ffmpeg.txt"));
await copyFile(path.join(root, "docs", "JARVIS_WINDOWS.md"), path.join(appDir, "LEIA-ME.md"));

// 4. The ring icon, for the installer and the Start menu shortcut.
const icon = await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [path.join(root, "source/electron-main/voice-assistant/ring-icon.ts")],
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "warning",
});
const { ringIco } = await import(`data:text/javascript;base64,${Buffer.from(icon.outputFiles[0].contents).toString("base64")}`);
await writeFile(path.join(appDir, "jarvis.ico"), ringIco());

// 5. A portable zip, and the installer when NSIS is available.
const zipFile = path.join(out, "Jarvis-win-x64.zip");
await rm(zipFile, { force: true });
run("zip", ["-q", "-r", "-9", zipFile, "Jarvis"], { cwd: work });
console.log(`Wrote ${path.relative(root, zipFile)}`);

const makensis = spawnSync("makensis", ["-VERSION"], { encoding: "utf8" });
if (makensis.status === 0) {
  const setup = path.join(out, "Jarvis-Setup.exe");
  run("makensis", ["-V2", `-DSOURCE_DIR=${appDir}`, `-DOUTFILE=${setup}`, `-DVERSION=${version}`, path.join(root, "scripts", "windows", "jarvis.nsi")]);
  console.log(`Wrote ${path.relative(root, setup)}`);
} else {
  console.log("makensis not found: skipped Jarvis-Setup.exe (install NSIS to build it).");
}
