#!/usr/bin/env node
// Downloads the Steinberg ASIO SDK into third_party/asio/ASIOSDK so the engine
// is built with ASIO support (Windows). LIVEPLAYER uses the SDK under its
// GPLv3 option (ASIO SDK 2.3.4+, dual licensed), compatible with AGPLv3.
// The SDK is never committed (third_party/asio/ is in .gitignore).
//
// Usage: node tools/fetch-asio-sdk.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://www.steinberg.net/asiosdk";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "third_party", "asio");
const header = join(dest, "ASIOSDK", "common", "iasiodrv.h");

if (existsSync(header)) {
  console.log(`ASIO SDK already present: ${dirname(header)}`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
console.log(`Downloading ${URL} ...`);
const res = await fetch(URL, { redirect: "follow" });
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const zip = join(dest, "asiosdk.zip");
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

// Windows 10+ ships bsdtar, which extracts zip files.
const r = spawnSync("tar", ["-xf", zip, "-C", dest, "ASIOSDK/common", "ASIOSDK/changes.txt"], { stdio: "inherit" });
rmSync(zip, { force: true });
if (r.status !== 0 || !existsSync(header)) throw new Error("Could not extract the ASIO SDK");

const license = readFileSync(join(dest, "ASIOSDK", "common", "LICENSE.txt"), "utf8");
if (!/General Public License \(GPL\) Version 3/.test(license)) {
  console.warn("WARNING: this ASIO SDK version does not offer the GPLv3 option; do not redistribute builds made with it.");
}
console.log(`ASIO SDK ready: ${dirname(header)}`);
