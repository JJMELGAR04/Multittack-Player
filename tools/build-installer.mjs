#!/usr/bin/env node
// Builds the LIVEPLAYER installer from a clone of the repository and copies it
// to `instaladores/`:
//   Windows -> LIVEPLAYER_<version>_x64-setup.exe (works offline, WebView2 included)
//   macOS   -> LIVEPLAYER_<version>_<arch>.dmg
//
//   npm run installer
//
// Needs the free build tools listed in docs/INSTALAR.md (Node, Rust, CMake and
// Visual Studio Build Tools on Windows / Xcode Command Line Tools on macOS).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// Tools installed by rustup / the CMake installer are not always on PATH yet
// in the terminal the user opened before installing them.
const extraPath = [join(homedir(), ".cargo", "bin")];
if (isWin) extraPath.push("C:\\Program Files\\CMake\\bin");
if (isMac) extraPath.push("/opt/homebrew/bin", "/usr/local/bin", "/Applications/CMake.app/Contents/bin");
process.env.PATH = [...extraPath, process.env.PATH].join(delimiter);

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  // One command string: on Windows npm is a .cmd and needs the shell (the
  // arguments here are fixed, never user input).
  const r = isWin ? spawnSync([cmd, ...args].join(" "), { cwd: root, stdio: "inherit", shell: true, ...opts }) : spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\nFalló: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function has(cmd, args = ["--version"]) {
  const r = isWin ? spawnSync([cmd, ...args].join(" "), { stdio: "ignore", shell: true }) : spawnSync(cmd, args, { stdio: "ignore" });
  return r.status === 0;
}

// 1. Check the build tools.
const missing = [];
const [major] = process.versions.node.split(".").map(Number);
if (major < 20) missing.push("Node.js 20 o superior");
if (!has("cargo")) missing.push("Rust (rustup)");
if (!has("cmake")) missing.push("CMake");
if (isMac && !has("xcode-select", ["-p"])) missing.push("Xcode Command Line Tools (xcode-select --install)");
if (missing.length) {
  console.error(`Faltan estas herramientas (todas gratuitas): ${missing.join(", ")}.\nVer docs/INSTALAR.md, sección «Desde el repositorio de GitHub».`);
  process.exit(1);
}

// 2. ASIO SDK (Windows, GPLv3). If it cannot be downloaded the app still
//    builds, with WASAPI only.
if (isWin && !existsSync(join(root, "third_party/asio/ASIOSDK/common/iasiodrv.h"))) {
  const r = spawnSync(process.execPath, [join(root, "tools/fetch-asio-sdk.mjs")], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) console.warn("Aviso: no se pudo descargar el SDK de ASIO; la app se compila solo con WASAPI.");
}

// 3. JavaScript dependencies.
if (!existsSync(join(root, "node_modules"))) run("npm", ["ci"]);

// 4. Build: frontend + engine + app + installer (tauri build).
if (isMac) process.env.MACOSX_DEPLOYMENT_TARGET ??= "11.0";
run("npm", ["run", "build"]);

// 5. Copy the installer to instaladores/.
const bundle = join(root, "target", "release", "bundle", isWin ? "nsis" : "dmg");
const ext = isWin ? ".exe" : ".dmg";
const files = existsSync(bundle) ? readdirSync(bundle).filter((f) => f.endsWith(ext)) : [];
if (!files.length) {
  console.error(`No se encontró el instalador en ${bundle}`);
  process.exit(1);
}
const out = join(root, "instaladores");
mkdirSync(out, { recursive: true });
for (const f of files) cpSync(join(bundle, f), join(out, f));
console.log(`\nListo. Instalador en: ${files.map((f) => join(out, f)).join(", ")}`);
console.log("Cópialo a una USB o a la computadora donde se va a instalar (ver docs/INSTALAR.md).");
