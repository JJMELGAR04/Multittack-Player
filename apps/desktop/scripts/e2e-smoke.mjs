// End-to-end smoke test: launches the real LIVEPLAYER exe with WebView2 remote
// debugging enabled and drives the UI through the Chrome DevTools Protocol.
// Usage: node scripts/e2e-smoke.mjs <path-to-liveplayer-desktop.exe> <screenshot-dir>
// (Windows only: relies on WebView2.)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// Generated multitrack test song (known tempo and structure).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const testAudio = join(repoRoot, "test-audio");
spawnSync(process.execPath, [join(repoRoot, "tools/generate-test-song.mjs"), testAudio], { stdio: "inherit" });
const songFolder = join(testAudio, "song");
const songZip = join(testAudio, "Prueba 96bpm.zip");
// Isolated database + library: the test never touches the user's songs.
const dataDir = mkdtempSync(join(tmpdir(), "liveplayer-e2e-"));
const PORT = 9333;
const app = spawn(exe, [], {
  env: { ...process.env, LIVEPLAYER_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
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
  check("engine_info: ABI v3", text.includes("v3"));
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
  await invoke("studio_set_output", { settings: { mode: "stereo", monitorGain: 0 } });

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
  check("no render underruns (folder song)", t.underruns === 0, `underruns ${t.underruns}, driver xruns ${t.deviceXruns ?? "n/a"}, render load ${Math.round(t.renderLoad * 100)} %`);
  check("click track goes to the band bus", (await invoke("studio_status")).engine.song.tracks.find((tr) => tr.name === "Click")?.bus === "monitor");

  // ---- Zip import with review dialog ----
  await invoke("studio_set_output", { settings: { mode: "stereo", monitorGain: 0 } }); // silent click bus too
  await evaluate(`window.__LIVEPLAYER_TEST__.startImport([${JSON.stringify(songZip)}])`);
  await waitFor(`!!document.querySelector("[role=dialog]")`, "import dialog");
  const dialogText = await evaluate(`document.querySelector("[role=dialog]").innerText`);
  check("zip read: 5 audio files, junk ignored", (await evaluate(`document.querySelectorAll("[data-import-row]").length`)) === 5 && !dialogText.includes("LEEME"));
  check("title and BPM taken from the zip name", (await evaluate(`document.querySelector("[aria-label=Título]").value`)) === "Prueba" && (await evaluate(`document.querySelector("[aria-label=BPM]").value`)) === "96");
  check("unknown file flagged for the user", dialogText.includes("1 sin identificar") && dialogText.includes("llmmD.wav"));
  for (let i = 0; i < 80; i++) { if (await evaluate(`!document.querySelector("[aria-label='Escuchar llmmD.wav']").disabled`)) break; await sleep(250); }
  await clickButton("Escuchar llmmD.wav");
  await sleep(1200);
  t = await transport();
  check("audition one file (solo)", t.playState === "playing", `${t.positionSec.toFixed(1)} s`);
  await shot("05-import-dialog");
  await clickButton("Detener llmmD.wav");
  await evaluate(`(() => { const sel = document.querySelector("[aria-label='Qué es llmmD.wav']"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "drums"); sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  check("identified file takes the instrument name", (await evaluate(`document.querySelector("[aria-label='Nombre de llmmD.wav']").value`)) === "Batería");
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Guardar canción").click()`);
  await waitFor(`!document.querySelector("[role=dialog]")`, "dialog closed");
  await waitFor(`document.querySelectorAll("[data-section]").length >= 6`, "zip song sections");
  await sleep(800);
  const st2 = await invoke("studio_status");
  const zipSong = await invoke("studio_get_song", { songId: st2.songId });
  const drums = zipSong.tracks.find((tr) => tr.filePath.endsWith("llmmD.wav"));
  check("saved: title, BPM (user), 4/4, roles", zipSong.title === "Prueba" && zipSong.originalBpm === 96 && zipSong.bpmSource === "user" && zipSong.timeSignature === "4/4" && drums?.name === "Batería" && drums?.role === "drums" && drums?.bus === "main");
  const zipLabels = await evaluate(`[...document.querySelectorAll("[data-section]")].map(b => b.dataset.section).join(", ")`);
  check("sections found with the given BPM", zipLabels === "Intro, Estrofa 1, Coro 1, Estrofa 2, Coro 2, Puente, Coro 3, Final", zipLabels);
  check("all 5 tracks still at unity after audition", (await transport()).underruns === 0);

  // Output routing.
  await evaluate(`[...document.querySelectorAll("[role=radio]")].find(b => b.textContent.includes("En vivo · 2 salidas")).click()`);
  await sleep(300);
  t = await transport();
  check("live split output: instruments out 1, click+cues out 2", t.outputMode === "split", `device outputs: ${t.outputChannels}`);
  const quadDisabled = await evaluate(`[...document.querySelectorAll("[role=radio]")].find(b => b.textContent.includes("4 salidas")).disabled`);
  check("4-output mode only offered with 4+ outputs", t.outputChannels >= 4 ? !quadDisabled : quadDisabled);
  await shot("06-outputs");
  await evaluate(`[...document.querySelectorAll("[role=radio]")].find(b => b.textContent.includes("Ensayo")).click()`);

  // Re-importing the same zip opens the saved song directly.
  await evaluate(`window.__LIVEPLAYER_TEST__.startImport([${JSON.stringify(songZip)}])`);
  await sleep(1500);
  const st3 = await invoke("studio_status");
  check("same zip again: opens the saved song, no duplicate", st3.songId === st2.songId && !(await evaluate(`!!document.querySelector("[role=dialog]")`)));
  await invoke("transport_set_master_gain", { gain: 1 });

  console.log(JSON.stringify(checks, null, 2));
  exitCode = checks.every((c) => c.ok) ? 0 : 1;
  ws.close();
} catch (e) {
  console.error("E2E FAILED:", e.message);
} finally {
  app.kill();
  await sleep(500);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
