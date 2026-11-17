// End-to-end smoke test: launches the real LIVEPLAYER exe with WebView2 remote
// debugging enabled and drives the UI through the Chrome DevTools Protocol.
// Usage: node scripts/e2e-smoke.mjs <path-to-liveplayer-desktop.exe> <screenshot-dir>
// (Windows only: relies on WebView2.)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// Generated multitrack test song (known tempo and structure).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const testAudio = join(repoRoot, "test-audio");
spawnSync(process.execPath, [join(repoRoot, "tools/generate-test-song.mjs"), testAudio], { stdio: "inherit" });
const songFolder = join(testAudio, "song");
const PORT = 9333;
const app = spawn(exe, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "inherit",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 1;

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
  }
  if (!target) throw new Error("WebView did not expose a debug target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) =>
    new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const waitFor = async (expr, label) => {
    for (let i = 0; i < 40; i++) { if (await evaluate(expr)) return; await sleep(250); }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, "base64"));
  };

  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); };

  await waitFor(`document.body.innerText.includes("Motor cargado")`, "engine panel");
  await waitFor(`document.body.innerText.includes("Detección OK") && document.body.innerText.includes("Abierta") && document.body.innerText.includes("Tauri activo")`, "all panels");
  const text = await evaluate("document.body.innerText");
  check("isTauri() true (no 'fuera de la aplicación' banner)", !text.includes("fuera de la aplicación de escritorio"));
  check("engine_info: JUCE 9.0.5", text.includes("9.0.5"));
  check("engine_info: ABI v2", text.includes("v2"));
  check("audio_diagnostics: Windows Audio listed", text.includes("Windows Audio"));
  check("database_status: songs tables (schema 2)", text.includes("songs") && text.includes("song_sections"));
  check("app_info: windows", text.includes("windows"));

  // Ping 5 times through the real button.
  for (let n = 0; n < 5; n++) {
    await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Probar comunicación")).click()`);
    await waitFor(`document.body.innerText.includes("OK ·")`, "ping result");
  }
  const pingLine = await evaluate(`[...document.querySelectorAll("span")].map(s => s.textContent).find(t => t.startsWith("OK ·"))`);
  check("engine_ping via UI button (x5)", pingLine, pingLine);
  await shot("01-dashboard");

  // Navigation to every module.
  for (const [path, label] of [["/songs", "Songs"], ["/setlists", "Setlists"], ["/live", "Live Mode"], ["/song-editor", "Song Editor"], ["/audio-settings", "Audio Settings"], ["/settings", "General Settings"]]) {
    await evaluate(`location.hash = "#${path}"`);
    await waitFor(`document.querySelector("h1")?.textContent === ${JSON.stringify(label)}`, label);
    check(`navigate ${path}`, true);
  }
  await shot("02-planned-module");

  // ---- Phase 2: Multitrack Studio on the real engine and audio device ----
  const invoke = (cmd, args = {}) =>
    evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(r => JSON.stringify(r ?? null), e => JSON.stringify({ __error: e }))`).then((r) => JSON.parse(r));
  const transport = () => invoke("transport_state");
  const clickButton = (label) =>
    evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === ${JSON.stringify(label)} || b.dataset.section === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);

  await evaluate(`location.hash = "#/studio"`);
  await waitFor(`document.querySelector("h1")?.textContent === "Multitrack Studio"`, "studio page");
  await invoke("transport_set_master_gain", { gain: 0 }); // keep the test silent

  const t0 = Date.now();
  const opened = await invoke("studio_open_files", { paths: [songFolder] }); // a folder = its audio files
  check("open song folder (5 stems)", opened?.tracks?.length === 5, opened?.__error?.message ?? `${opened?.tracks?.length} tracks`);
  await waitFor(`document.querySelector("[aria-label=Reproducir]") !== null`, "song loaded");
  const loadSecs = (Date.now() - t0) / 1000;
  for (let i = 0; i < 120; i++) {
    const st = await invoke("studio_status");
    if (st?.engine?.analysis?.state === "done") break;
    await sleep(250);
  }
  await waitFor(`document.querySelectorAll("[data-section]").length >= 8`, "sections shown");
  const status = await invoke("studio_status");
  const song = status.engine.song;
  check("loaded 141 s song, converted to the device rate", Math.abs(song.durationSec - 141) < 0.1 && song.tracks.every((tr) => tr.resampled === (tr.sourceSampleRate !== song.sampleRate)), `load ${loadSecs.toFixed(1)} s, ${song.sampleRate} Hz, ${Math.round(song.memoryMB)} MB`);
  const tempo = status.engine.analysis.tempo;
  check("tempo detected 96 BPM from click", Math.abs(tempo.bpm - 96) < 0.05 && tempo.source === "click", `${tempo.bpm} (${tempo.source})`);
  const labels = await evaluate(`[...document.querySelectorAll("[data-section]")].map(b => b.dataset.section).join(", ")`);
  check("sections detected", labels === "Intro, Estrofa 1, Coro 1, Estrofa 2, Coro 2, Puente, Coro 3, Final", labels);
  await sleep(600); // debounced saves
  const record = await invoke("studio_get_song", { songId: opened.id });
  check("tempo + sections saved in the database", record.originalBpm === 96 && record.bpmSource === "detected" && record.sectionsInitialized && record.sections.length === 8);
  await shot("03-studio-loaded");

  await clickButton("Reproducir");
  await sleep(1500);
  let t = await transport();
  check("play advances the position", t.playState === "playing" && t.positionSec > 1.0 && t.positionSec < 2.2, `${t.positionSec.toFixed(2)} s`);

  await clickButton("Coro 2");
  await sleep(400);
  t = await transport();
  check("click on section Coro 2 jumps there and keeps playing", t.playState === "playing" && t.positionSec >= 70 && t.positionSec < 70.8, `${t.positionSec.toFixed(2)} s`);

  for (let i = 0; i < 8; i++) { await clickButton("Subir 1 BPM"); await sleep(80); }
  await sleep(1500);
  t = await transport();
  check("tempo 96 -> 104 BPM: time-stretch active", t.stretching && Math.abs(t.tempoRatio - 104 / 96) < 0.002, `ratio ${t.tempoRatio.toFixed(4)}`);
  const p1 = t.positionSec;
  await sleep(2000);
  t = await transport();
  const speed = (t.positionSec - p1) / 2;
  check("song advances at the new speed", Math.abs(speed - 104 / 96) < 0.08, `${speed.toFixed(3)}x`);
  await shot("04-studio-tempo");

  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Original")?.click()`);
  await sleep(1200);
  t = await transport();
  check("back to original tempo: untouched audio", !t.stretching && t.tempoRatio === 1, `ratio ${t.tempoRatio}`);

  await clickButton("Pausa");
  await sleep(300);
  const paused = await transport();
  await sleep(500);
  t = await transport();
  check("pause holds the position", t.playState === "paused" && t.positionSec === paused.positionSec);
  await clickButton("Detener");
  await sleep(300);
  t = await transport();
  check("stop returns to 0", t.playState === "stopped" && t.positionSec === 0);
  check("no render underruns during the whole test", t.underruns === 0, `underruns ${t.underruns}, driver xruns ${t.deviceXruns ?? "n/a"}, render load ${Math.round(t.renderLoad * 100)} %`);
  await invoke("transport_set_master_gain", { gain: 1 });

  console.log(JSON.stringify(checks, null, 2));
  exitCode = checks.every((c) => c.ok) ? 0 : 1;
  ws.close();
} catch (e) {
  console.error("E2E FAILED:", e.message);
} finally {
  app.kill();
  await sleep(500);
  process.exit(exitCode);
}
