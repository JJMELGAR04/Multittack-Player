// Screenshots for the README with a presentable demo library.
// Launches the real app with a separate, temporary library (the user's songs
// are never touched), imports copies of the generated test song under demo
// names and captures only the app window through WebView2 remote debugging.
//
// Usage (Windows, debug build + vite on :1420 like the E2E test):
//   node scripts/readme-shots.mjs ../../target/debug/liveplayer-desktop.exe ../../docs/img
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [exe, outDir] = process.argv.slice(2);
if (!exe || !outDir) {
  console.error("usage: node scripts/readme-shots.mjs <liveplayer-desktop.exe> <output-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const testAudio = join(repoRoot, "test-audio");
spawnSync(process.execPath, [join(repoRoot, "tools/generate-test-song.mjs"), testAudio], { stdio: "inherit" });

// Demo songs (invented titles; the audio is the generated test song).
const DEMO = [
  { title: "Luz del Amanecer", key: "G", notes: "Entrar con pads. Coro final x2." },
  { title: "Cielo Abierto", key: "D", notes: "" },
  { title: "Río de Paz", key: "E", notes: "Puente suave, solo teclados." },
  { title: "Camino Nuevo", key: "A", notes: "" },
];
const ARTIST = "Banda Demo";
const TRACK_NAMES = { Bass: "Bajo", Click: "Click", Drums: "Batería", Keys: "Teclados", Lead: "Voz principal" };

const work = mkdtempSync(join(tmpdir(), "liveplayer-shots-"));
const dataDir = join(work, "data");
const folders = DEMO.map((d) => {
  const dir = join(work, "songs", d.title);
  cpSync(join(testAudio, "song"), dir, { recursive: true });
  rmSync(join(dir, "manifest.json"), { force: true });
  return dir;
});

const PORT = 9334;
const app = spawn(exe, [], {
  env: { ...process.env, LIVEPLAYER_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "inherit",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 1;

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("WebView did not expose a debug target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const waitFor = async (expr, label, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await evaluate(expr)) return;
      await sleep(250);
    }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const invoke = async (cmd, args = {}) => {
    const r = JSON.parse(await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(r => JSON.stringify(r ?? null), e => JSON.stringify({ __error: e }))`));
    if (r && r.__error) throw new Error(`${cmd}: ${JSON.stringify(r.__error)}`);
    return r;
  };
  const shot = async (name) => {
    await sleep(400);
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, "base64"));
    console.log(`  ${name}.png`);
  };
  const go = (hash) => evaluate(`location.hash = ${JSON.stringify(hash)}`);
  const status = () => invoke("studio_status");
  const waitReady = async () => {
    for (let i = 0; i < 300; i++) {
      const st = await status();
      if (st.engine?.state === "ready" && st.engine?.analysis?.state !== "running") return st;
      await sleep(100);
    }
    throw new Error("song did not load");
  };

  await waitFor(`!!document.querySelector("header")`, "app");
  await invoke("transport_set_master_gain", { gain: 0 }); // silent
  await invoke("studio_set_output", { settings: { mode: "split", monitorGain: 0, mainGain: 0 } });

  // 1. Demo library: import, wait for tempo/parts detection, then name everything.
  const ids = [];
  for (const [i, d] of DEMO.entries()) {
    await go("#/studio");
    await invoke("studio_open_files", { paths: [folders[i]] });
    const st = await waitReady();
    // The parts are saved once the detection has run (the Studio does it).
    let song = null;
    for (let n = 0; n < 100; n++) {
      song = await invoke("studio_get_song", { songId: st.songId });
      if (song?.sectionsInitialized && song.sections.length > 2) break;
      await sleep(150);
    }
    await invoke("studio_set_song_details", { songId: song.id, details: { title: d.title, artist: ARTIST, songKey: d.key, notes: d.notes, timeSignature: "4/4" } });
    for (const t of song.tracks) {
      const base = t.name.replace(/\.[a-z0-9]+$/i, "");
      const name = TRACK_NAMES[base] ?? base;
      if (name !== t.name) await invoke("studio_update_track", { songId: song.id, position: t.position, name, role: t.role });
    }
    ids.push(song.id);
  }

  // 2. A setlist for Sunday.
  const setlistId = await invoke("setlist_create", {
    input: {
      name: "Servicio del domingo",
      eventDate: "2026-11-22",
      place: "Auditorio principal",
      notes: "Ensayo 8:00 · Servicio 10:00",
      items: [
        { songId: ids[0], notes: "Entrar con pads", transpose: null },
        { songId: ids[1], notes: "", transpose: -2 },
        { songId: ids[2], notes: "Coro final x2", transpose: null },
        { songId: ids[3], notes: "", transpose: null },
      ],
    },
  });

  // 3. Screenshots.
  await go("#/songs");
  await waitFor(`document.body.innerText.includes("Camino Nuevo")`, "library");
  await shot("songs");

  await go(`#/studio`);
  await invoke("studio_open_song", { songId: ids[0] });
  await waitReady();
  await waitFor(`document.querySelectorAll("canvas").length >= 5`, "studio waveforms");
  await invoke("transport_seek", { positionSec: 72 });
  await invoke("transport_play");
  await sleep(1500);
  await shot("studio");
  await invoke("transport_pause");

  await go(`#/song-editor?song=${ids[0]}`);
  await waitFor(`document.querySelectorAll("[data-editor-part]").length > 2`, "editor");
  await evaluate(`document.querySelectorAll("[data-editor-part]")[2].click()`);
  await sleep(300);
  await shot("song-editor");

  await go("#/setlists");
  await waitFor(`document.body.innerText.includes("Servicio del domingo")`, "setlists");
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Servicio del domingo"))?.click()`);
  await waitFor(`document.querySelectorAll("[data-setlist-row]").length === 4`, "setlist rows");
  await shot("setlists");

  await invoke("ui_setting_set", { key: "live.lastSetlist", value: setlistId });
  await go("#/live");
  await waitFor(`document.querySelectorAll("[data-live-song]").length === 4`, "live setlist");
  await evaluate(`document.querySelector("[data-live-song='Luz del Amanecer']").click()`);
  await waitFor(`document.querySelector("[data-live-title]")?.textContent === "Luz del Amanecer"`, "live song");
  await waitFor(`document.querySelectorAll("[data-live-tracks] canvas").length >= 5`, "live tracks");
  await invoke("transport_seek", { positionSec: 52 });
  await invoke("transport_play");
  await sleep(1500);
  await shot("live");
  await invoke("transport_stop");
  code = 0;
} catch (e) {
  console.error("readme-shots FAILED:", e.message);
} finally {
  app.kill();
  await sleep(1500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}
