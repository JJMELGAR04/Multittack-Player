// End-to-end smoke test: launches the real LIVEPLAYER exe with WebView2 remote
// debugging enabled and drives the UI through the Chrome DevTools Protocol.
// Usage: node scripts/e2e-smoke.mjs <path-to-liveplayer-desktop.exe> <screenshot-dir>
// (Windows only: relies on WebView2.)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let failureShot = null; // screenshot of the screen when a step fails

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
  const waitFor = async (expr, label, tries = 40) => {
    for (let i = 0; i < tries; i++) { if (await evaluate(expr)) return; await sleep(250); }
    throw new Error(`timeout waiting for: ${label}`);
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(r.result.data, "base64"));
  };
  failureShot = () => shot("zz-failure");

  const checks = [];
  globalThis.__checks = checks; // printed if a step fails
  const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); };

  await waitFor(`document.body.innerText.includes("Motor cargado")`, "engine panel");
  await waitFor(`document.body.innerText.includes("Detección OK") && document.body.innerText.includes("Abierta") && document.body.innerText.includes("Tauri activo")`, "all panels");
  const text = await evaluate("document.body.innerText");
  check("isTauri() true (no 'fuera de la aplicación' banner)", !text.includes("fuera de la aplicación de escritorio"));
  check("engine_info: JUCE 9.0.5", text.includes("9.0.5"));
  check("engine_info: ABI v6", text.includes("v6"));
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
  await invoke("studio_set_output", { settings: { mode: "stereo", monitorGain: 0, mainGain: 0 } });

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
  const laneOrder = () => evaluate(`[...document.querySelectorAll("[data-track]")].sort((a, b) => a.offsetTop - b.offsetTop).map(d => d.dataset.track).join(", ")`);
  check("click shown first by default", (await laneOrder()).startsWith("Click"), await laneOrder());
  check("tempo + sections saved in the database", record.originalBpm === 96 && record.bpmSource === "detected" && record.sectionsInitialized && record.sections.length === 8);
  await shot("03-studio-loaded");

  // Drag "Lead" by its grip to the top row.
  const dragged = await evaluate(`(async () => {
    const grip = document.querySelector("[aria-label='Arrastrar Lead para cambiar el orden']");
    const r = grip.getBoundingClientRect();
    const x = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const ev = (type, y) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x, clientY: y }));
    ev("pointerdown", y0);
    for (let k = 1; k <= 10; k++) { ev("pointermove", y0 - k * 30); await new Promise(r => setTimeout(r, 16)); }
    ev("pointerup", y0 - 300);
    return true;
  })()`);
  await sleep(700); // debounced save
  const afterDrag = await laneOrder();
  check("drag a track header to reorder", dragged && afterDrag.startsWith("Lead"), afterDrag);
  const reordered = await invoke("studio_get_song", { songId: opened.id });
  const shownOrder = [...reordered.tracks].sort((a, b) => a.displayOrder - b.displayOrder).map((tr) => tr.name).join(", ");
  check("new order saved with the song", shownOrder === afterDrag, shownOrder);
  const mixerOrder = await evaluate(`[...document.querySelectorAll("[data-strip]")].map(d => d.dataset.strip).slice(0, 5).join(", ")`);
  check("moving a track does not move the mixer strips", mixerOrder === "Click, Bass, Drums, Keys, Lead", mixerOrder);

  // Drag the "Keys" mixer strip (last) to the far left.
  await evaluate(`(async () => {
    const grip = document.querySelector("[aria-label='Arrastrar el canal Keys para cambiar el orden']");
    const r = grip.getBoundingClientRect();
    const y = r.top + r.height / 2, x0 = r.left + r.width / 2;
    const ev = (type, x) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: y }));
    ev("pointerdown", x0);
    for (let k = 1; k <= 12; k++) { ev("pointermove", x0 - k * 30); await new Promise(r => setTimeout(r, 16)); }
    ev("pointerup", x0 - 360);
  })()`);
  await sleep(700);
  const mixerAfter = await evaluate(`[...document.querySelectorAll("[data-strip]")].map(d => d.dataset.strip).slice(0, 5).join(", ")`);
  check("drag a mixer strip left/right to reorder", mixerAfter.startsWith("Keys"), mixerAfter);
  check("moving a mixer strip does not move the tracks", (await laneOrder()) === afterDrag, await laneOrder());
  const savedAfter = await invoke("studio_get_song", { songId: opened.id });
  check("mixer order saved with the song", [...savedAfter.tracks].sort((a, b) => a.mixerOrder - b.mixerOrder).map((tr) => tr.name).join(", ") === mixerAfter);

  await clickButton("Reproducir");
  await sleep(1500);
  let t = await transport();
  check("play advances the position", t.playState === "playing" && t.positionSec > 1.0 && t.positionSec < 2.2, `${t.positionSec.toFixed(2)} s`);


  await clickButton("Coro 2");
  await sleep(400);
  t = await transport();
  check("click on section Coro 2 jumps there and keeps playing", t.playState === "playing" && t.positionSec >= 70 && t.positionSec < 70.8, `${t.positionSec.toFixed(2)} s`);

  // Mixer (full band in the chorus): meters move; M mutes a track.
  const peakOver = async (ms) => {
    await invoke("studio_meters");
    const max = [];
    for (let k = 0; k < ms / 100; k++) {
      await sleep(100);
      (await invoke("studio_meters")).tracks.forEach((v, i) => (max[i] = Math.max(max[i] ?? 0, v)));
    }
    return max;
  };
  let peaks = await peakOver(1000);
  check("track meters move while playing", peaks.filter((v) => v > 0.01).length === 5, peaks.map((v) => v.toFixed(2)).join(" "));
  const bassIndex = (await invoke("studio_status")).engine.song.tracks.findIndex((tr) => tr.name === "Bass");
  await clickButton("Silenciar Bass");
  await sleep(1500); // meters release over ~300 ms
  peaks = await peakOver(600);
  check("mute (M) silences only that track", peaks[bassIndex] < 0.005 && peaks.filter((v) => v > 0.01).length === 4, peaks.map((v) => v.toFixed(3)).join(" "));
  await shot("03b-studio-playing");
  await clickButton("Silenciar Bass");

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
  await invoke("studio_set_output", { settings: { mode: "stereo", monitorGain: 0, mainGain: 0 } }); // silent click bus too
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
  await waitFor(`document.querySelectorAll("[data-section]").length >= 6`, "zip song sections", 120); // the analysis can take longer on a busy machine
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

  // ---- Phase 3: mixer saved per song ----
  const typeDb = async (name, value) => {
    await evaluate(`(() => { const b = document.querySelector("[aria-label^='Volumen de ${name}:']"); b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); })()`);
    await sleep(100);
    await evaluate(`(() => {
      const i = document.querySelector("[aria-label='Escribir volumen de ${name}']");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(value)});
      i.dispatchEvent(new Event("input", { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    })()`);
    await sleep(150);
    return evaluate(`document.querySelector("[aria-label^='Volumen de ${name}:']")?.textContent`);
  };
  await waitFor(`!!document.querySelector("[aria-label^='Volumen de Bass:']")`, "mixer of the reopened song");
  await sleep(800); // saved mixer applied after load
  check("type an exact volume (double-click): -6,5 dB", (await typeDb("Bass", "-6,5")) === "−6.5", await evaluate(`document.querySelector("[aria-label^='Volumen de Bass:']")?.textContent`));
  check("fader limit is +8 dB (typing +12 gives +8)", (await typeDb("Keys", "+12")) === "+8.0");
  const faderPos = (n) => evaluate(`(() => { const f = document.querySelector("input[type=range][aria-label='Volumen de ${n}']"); const r = f.getBoundingClientRect(); return [Number(f.value), Math.round(r.height)]; })()`);
  const [keysPos] = await faderPos("Keys");
  const [drumsPos, faderHeight] = await faderPos("Click");
  check("fader curve: 0 dB sits in the middle, +8 dB at the top", drumsPos === 500 && keysPos === 1000 && faderHeight === 140, `0 dB at ${drumsPos}/1000, +8 at ${keysPos}/1000`);
  await clickButton("Silenciar Click");
  await sleep(800); // debounced save
  const mixSaved = await invoke("studio_get_song", { songId: st2.songId });
  const tr = (n) => mixSaved.tracks.find((x) => x.name === n);
  check("mixer saved with the song", tr("Bass").volumeDb === -6.5 && tr("Keys").volumeDb === 8 && tr("Click").muted === true, JSON.stringify(mixSaved.tracks.map((x) => [x.name, x.volumeDb, x.muted])));

  // ---- Phase 3: song library ----
  await evaluate(`window.confirm = () => true`); // accept the delete confirmation
  await evaluate(`location.hash = "#/songs"`);
  await waitFor(`document.querySelectorAll("[data-library-song]").length >= 2`, "library rows");
  const libTitles = await evaluate(`[...document.querySelectorAll("[data-library-song]")].map(r => r.dataset.librarySong).join(", ")`);
  check("library lists the songs", libTitles.includes("Prueba") && libTitles.includes("song"), libTitles);
  const libRow = await evaluate(`document.querySelector("[data-library-song='Prueba']").innerText`);
  check("library shows BPM, meter, duration and tracks", libRow.includes("96") && libRow.includes("4/4") && libRow.includes("2:21") && libRow.includes("5"), libRow.replace(/\s+/g, " "));
  await evaluate(`(() => { const i = document.querySelector("[aria-label='Buscar canción']"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "prue"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(200);
  check("search filters the library", (await evaluate(`document.querySelectorAll("[data-library-song]").length`)) === 1);
  await evaluate(`(() => { const i = document.querySelector("[aria-label='Buscar canción']"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ""); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(150);
  await clickButton("Renombrar Prueba");
  await waitFor(`!!document.querySelector("[aria-label='Nuevo título de Prueba']")`, "rename field");
  await evaluate(`(() => {
    const i = document.querySelector("[aria-label='Nuevo título de Prueba']");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "Prueba renombrada");
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    i.blur();
  })()`);
  await waitFor(`!!document.querySelector("[data-library-song='Prueba renombrada']")`, "renamed row");
  check("rename a song from the library", true);
  await shot("07-library");

  // Open the zip song from the library: the saved mixer comes back.
  await clickButton("Abrir Prueba renombrada");
  await waitFor(`location.hash.startsWith("#/studio") && !!document.querySelector("[aria-label^='Volumen de Bass:']")`, "studio from library");
  await sleep(1500);
  const restoredBass = await evaluate(`document.querySelector("[aria-label^='Volumen de Bass:']")?.textContent`);
  const clickMuted = await evaluate(`document.querySelector("[aria-label='Silenciar Click']")?.getAttribute("aria-pressed")`);
  check("open from library restores the saved mixer", restoredBass === "−6.5" && clickMuted === "true", `Bass ${restoredBass}, Click muted ${clickMuted}`);

  // Delete it: the files extracted from the zip go too; the original zip stays.
  const extracted = zipSong.tracks.map((x) => x.filePath);
  await evaluate(`location.hash = "#/songs"`);
  await waitFor(`!!document.querySelector("[data-library-song='Prueba renombrada']")`, "library again");
  await clickButton("Quitar Prueba renombrada");
  await waitFor(`!document.querySelector("[data-library-song='Prueba renombrada']")`, "row removed");
  await sleep(300);
  check("delete removes the song and its extracted files (zip kept)", extracted.every((f) => !existsSync(f)) && existsSync(songZip), extracted[0]);
  check("files picked by the user are never deleted", existsSync(join(songFolder, "Bass.wav")));

  // ---- Phase 4: audio device and outputs ----
  const out0 = await invoke("output_info");
  check("output device open at start-up with all its outputs", out0.open && out0.outputChannels >= 2 && out0.outputChannelNames?.length === out0.outputChannels, `${out0.typeName} · ${out0.deviceName} · ${out0.outputChannels} outputs`);
  const diag = await invoke("audio_diagnostics");
  check("ASIO compiled in (Steinberg SDK, GPLv3) and listed as a driver type", diag.asioSupported === true && diag.deviceTypes.some((t) => t.name === "ASIO"), diag.deviceTypes.map((t) => `${t.name} (${t.outputDevices.length})`).join(", "));

  await evaluate(`location.hash = "#/audio-settings"`);
  await waitFor(`!!document.querySelector("[data-audio-current]") && document.querySelector("[data-audio-current]").innerText.includes(${JSON.stringify(out0.deviceName)})`, "audio settings");
  const drivers = await evaluate(`[...document.querySelector("[aria-label=Controlador]").options].map(o => o.textContent).join(" | ")`);
  check("Audio Settings lists the drivers (ASIO first)", drivers.startsWith("ASIO") && drivers.includes("Windows · exclusivo") && drivers.includes("Windows · compartido"), drivers);

  // Live mode with 2 outputs: band on one, click on the other; pick the other way round.
  await clickButton("x"); // no-op, keeps helper warm
  await evaluate(`[...document.querySelectorAll("[role=radio]")].find(b => b.textContent.includes("En vivo · 2 salidas")).click()`);
  await waitFor(`!!document.querySelector("[aria-label='Salida del click y cues']")`, "split selectors");
  await evaluate(`(() => { const s = document.querySelector("[aria-label='Salida de la banda']"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "1"); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(400);
  let o = await invoke("output_info");
  check("choose the band output: band on 2, click moves to 1 (never both on one)", o.mainChannel === 1 && o.monitorChannel === 0 && o.outputMode === 1, `band ${o.mainChannel + 1}, click ${o.monitorChannel + 1}`);
  await clickButton("Intercambiar salidas");
  await sleep(400);
  o = await invoke("output_info");
  check("swap outputs button", o.mainChannel === 0 && o.monitorChannel === 1, `band ${o.mainChannel + 1}, click ${o.monitorChannel + 1}`);
  await clickButton("Intercambiar salidas");
  await sleep(400);
  const probeLabels = await evaluate(`[...document.querySelectorAll("[aria-label^='Probar salida']")].map(b => b.innerText.replace(/\\s+/g, " ")).join(" | ")`);
  check("test-tone buttons show what plays on each output", probeLabels.includes("Salida 1 Click y cues") && probeLabels.includes("Salida 2 Banda"), probeLabels);
  await shot("08-audio-settings");
  const bad = await invoke("audio_test_tone", { channel: 99 });
  check("test tone refuses an output the device does not have", !!bad?.__error);
  check("test tone can be stopped", (await invoke("audio_test_tone", { channel: -1 })) === null);

  // Saved: reopening the device keeps the chosen outputs.
  const current = { typeName: out0.typeName, deviceName: out0.deviceName, sampleRate: 0, bufferSize: 0 };
  o = await invoke("audio_set_device", { choice: current });
  check("device choice saved; chosen outputs kept after reopening", o.usingPreferred === true && o.mainChannel === 1 && o.monitorChannel === 0, o.__error?.message ?? `band ${o.mainChannel + 1}`);
  const studioRouting = async () => {
    await evaluate(`location.hash = "#/studio?song=${folderSong.id}"`);
    await waitFor(`!!document.querySelector("[aria-label^='Volumen de Bass:']")`, "studio with the song");
    await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim().toUpperCase() === "SALIDAS")?.click()`);
    await waitFor(`!!document.querySelector("[data-output-routing]")`, "routing line");
    await sleep(2200);
    return evaluate(`document.querySelector("[data-output-routing]").innerText`);
  };
  const songs = await invoke("library_songs");
  const folderSong = songs.find((x) => x.title === "song");
  await invoke("studio_open_song", { songId: folderSong.id });
  for (let i = 0; i < 100 && (await invoke("studio_status")).engine?.state !== "ready"; i++) await sleep(150);
  const routingText = await studioRouting();
  check("Studio shows where the band and the click go", routingText.includes("Banda → salida 2") && routingText.includes("Click y cues → salida 1"), routingText.replace(/\s+/g, " "));

  // Interface not connected: remembered, default output meanwhile, warning everywhere.
  o = await invoke("audio_set_device", { choice: { typeName: "Windows Audio", deviceName: "LIVEPLAYER Missing Interface", sampleRate: 0, bufferSize: 0 } });
  check("missing interface: remembered, still playing through the default output", o.open && o.usingPreferred === false && o.deviceName === out0.deviceName, o.__error?.message ?? o.lastDeviceEvent);
  await waitFor(`!!document.querySelector("[data-device-banner]") && document.querySelector("[data-device-banner]").innerText.includes("no está conectado")`, "device banner");
  check("warning banner shown on every page", true);
  await shot("09-device-missing");
  o = await invoke("audio_set_device", { choice: current });
  await clickButton("Cerrar aviso");
  await sleep(2500);
  check("back on the real device: warning gone", o.usingPreferred === true && !(await evaluate(`!!document.querySelector("[data-device-banner]")`)));

  // Another sample rate: the song is converted and keeps its place.
  await invoke("transport_seek", { positionSec: 30 });
  await sleep(300);
  const exclusive = "Windows Audio (Exclusive Mode)";
  const caps = await invoke("audio_describe_device", { typeName: exclusive, deviceName: out0.deviceName });
  const otherRate = (caps.sampleRates ?? []).find((r) => Math.abs(r - (out0.sampleRate ?? 0)) > 1 && (r === 44100 || r === 96000 || r === 88200));
  if (caps.available && otherRate) {
    o = await invoke("audio_set_device", { choice: { typeName: exclusive, deviceName: out0.deviceName, sampleRate: otherRate, bufferSize: 0 } });
    let st = null;
    for (let i = 0; i < 100; i++) {
      st = await invoke("studio_status");
      if (st.engine?.song?.sampleRate === otherRate && !(await invoke("output_info")).reloading) break;
      await sleep(150);
    }
    const tr = await transport();
    check(`new sample rate (${otherRate / 1000} kHz, exclusive): song converted, position kept`, o.sampleRate === otherRate && st.engine?.song?.sampleRate === otherRate && Math.abs(tr.positionSec - 30) < 0.5, `device ${o.sampleRate}, song ${st.engine?.song?.sampleRate}, pos ${tr.positionSec?.toFixed(2)}`);
    o = await invoke("audio_set_device", { choice: current });
    for (let i = 0; i < 100 && (await invoke("studio_status")).engine?.song?.sampleRate !== o.sampleRate; i++) await sleep(150);
    check("back to the shared driver", o.typeName === out0.typeName && o.sampleRate === out0.sampleRate);
  } else {
    check("new sample rate: skipped (this device offers no other rate)", true, JSON.stringify(caps.sampleRates));
  }

  // ---- Phase 5: Song Editor ----
  await invoke("studio_set_output", { settings: { mode: "stereo", monitorGain: 0, mainGain: 0 } }); // silent
  const key = (k, extra = {}) => evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ key: k, code: k === " " ? "Space" : "Key" + k.toUpperCase(), bubbles: true, ...extra })}))`);
  const drag = async (selector, dx, dy = 0) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const opts = (cx, cy) => ({ bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 7, pointerType: "mouse" });
      el.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
      for (let i = 1; i <= 6; i++) el.dispatchEvent(new PointerEvent("pointermove", opts(x + (${dx} * i) / 6, y + (${dy} * i) / 6)));
      el.dispatchEvent(new PointerEvent("pointerup", opts(x + ${dx}, y + ${dy})));
    })()`);
  };
  const setValue = (selector, value, event = "input") =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true; })()`);
  const waitSaved = (attr) => waitFor(`document.querySelector("[${attr}]")?.getAttribute("${attr}") === "saved"`, `${attr} saved`);

  await evaluate(`location.hash = "#/song-editor?song=${folderSong.id}"`);
  await waitFor(`document.querySelectorAll("[data-editor-part]").length > 2`, "editor parts");
  const before = await invoke("studio_get_song", { songId: folderSong.id });
  const partsShown = await evaluate(`document.querySelectorAll("[data-editor-part]").length`);
  check("Song Editor shows the song's parts on the waveform", partsShown === before.sections.length, `${partsShown} parts`);
  await shot("10-song-editor");

  // Drag the start of the 2nd part to the right: it snaps to a bar line and is saved.
  const secondLabel = await evaluate(`document.querySelectorAll("[data-editor-part]")[1].dataset.editorPart`);
  await drag(`[aria-label='Inicio de ${secondLabel}']`, 90);
  await waitSaved("data-editor-saved");
  let after = await invoke("studio_get_song", { songId: folderSong.id });
  const bar = (4 * 60) / after.originalBpm;
  const movedTo = after.sections[1].startSec;
  const onBar = Math.abs(((movedTo - after.downbeatOffsetSec) / bar) - Math.round((movedTo - after.downbeatOffsetSec) / bar)) < 0.001;
  check("drag a part boundary: moved, snapped to a bar line, saved", movedTo > before.sections[1].startSec + 0.5 && onBar && after.sections[1].source === "user", `${before.sections[1].startSec.toFixed(2)} → ${movedTo.toFixed(2)} s`);

  // Mark a new part with the keyboard at the cursor, then undo it.
  await invoke("transport_seek", { positionSec: 41.3 });
  await sleep(300);
  const afterSeek = await transport();
  check("move the cursor while stopped", Math.abs(afterSeek.positionSec - 41.3) < 0.05, `pos ${afterSeek.positionSec} state ${afterSeek.playState}`);
  await setValue("[aria-label='Tipo de la nueva parte']", "interlude", "change");
  await key("m");
  await waitFor(`document.querySelectorAll("[data-editor-part]").length === ${partsShown + 1}`, "new part");
  await waitSaved("data-editor-saved");
  after = await invoke("studio_get_song", { songId: folderSong.id });
  const added = after.sections.find((x) => x.kind === "interlude");
  check("mark a part with the key M (snapped to the bar)", after.sections.length === partsShown + 1 && !!added && Math.abs(added.startSec - 42.5) < 0.01, added ? `${added.label} at ${added.startSec}` : "none");
  await key("z", { ctrlKey: true, code: "KeyZ" });
  await waitFor(`document.querySelectorAll("[data-editor-part]").length === ${partsShown}`, "undo");
  await waitSaved("data-editor-saved");
  after = await invoke("studio_get_song", { songId: folderSong.id });
  check("undo (Ctrl+Z) removes it again and saves", after.sections.length === partsShown && !after.sections.some((x) => x.kind === "interlude"));

  // Song details.
  await setValue("[aria-label='Tonalidad']", "D", "change");
  await evaluate(`document.querySelector("[aria-label='Artista']").focus()`);
  await setValue("[aria-label='Artista']", "Banda de prueba");
  await evaluate(`document.querySelector("[aria-label='Artista']").blur()`);
  await sleep(200);
  await waitSaved("data-editor-saved");
  after = await invoke("studio_get_song", { songId: folderSong.id });
  check("song details saved (key, artist)", after.songKey === "D" && after.artist === "Banda de prueba", `${after.songKey} / ${after.artist}`);

  // Loop the selected part.
  await evaluate(`document.querySelectorAll("[data-editor-part]")[2].click()`);
  await key("l");
  await sleep(400);
  let tp = await transport();
  const third = after.sections[2], fourth = after.sections[3];
  check("loop the selected part (L)", tp.loopRange && Math.abs(tp.loopRange[0] - third.startSec) < 0.01 && Math.abs(tp.loopRange[1] - fourth.startSec) < 0.01, JSON.stringify(tp.loopRange));
  await invoke("transport_set_loop", { startSec: 0, endSec: 0 });
  await invoke("transport_stop");

  // ---- Phase 5: Setlists ----
  const shortSong = await invoke("studio_open_files", { paths: [join(testAudio, "short")] });
  for (let i = 0; i < 100 && (await invoke("studio_status")).engine?.state !== "ready"; i++) await sleep(100);
  await evaluate(`location.hash = "#/setlists"`);
  await waitFor(`document.querySelector("h1")?.textContent === "Setlists"`, "setlists page");
  await clickButton("x");
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Nuevo").click()`);
  await waitFor(`!!document.querySelector("[aria-label='Nombre del setlist']")`, "setlist editor");
  await setValue("[aria-label='Nombre del setlist']", "Domingo E2E");
  await clickButton("Agregar short");
  await clickButton("Agregar song");
  await waitFor(`document.querySelectorAll("[data-setlist-row]").length === 2`, "2 rows");
  await setValue("[aria-label='Notas de short']", "entrar con pads");
  // Drag "song" (2nd) above "short".
  await drag("[aria-label='Arrastrar song']", 0, -58);
  await waitFor(`document.querySelectorAll("[data-setlist-row]")[0]?.dataset.setlistRow === "song"`, "reordered");
  await waitSaved("data-setlist-saved");
  const lists = await invoke("setlist_list");
  const e2eList = lists.find((l) => l.name === "Domingo E2E");
  const rec = e2eList && (await invoke("setlist_get", { id: e2eList.id }));
  check("setlist: create, add songs, notes, drag to reorder, autosaved", rec && rec.items.map((i) => i.title).join(",") === "song,short" && rec.items[1].notes === "entrar con pads", rec ? rec.items.map((i) => `${i.title}(${i.notes})`).join(", ") : "missing");
  await shot("11-setlists");

  // ---- Phase 5: Live Mode ----
  await invoke("ui_setting_set", { key: "live.lastSetlist", value: e2eList.id });
  await evaluate(`location.hash = "#/live"`);
  await waitFor(`document.querySelectorAll("[data-live-song]").length === 2`, "live setlist");
  await evaluate(`document.querySelector("[data-live-song='song']").click()`);
  await waitFor(`document.querySelector("[data-live-title]")?.textContent === "song"`, "live song loaded");
  await waitFor(`document.querySelector("[data-preload]")?.dataset.preload === "ready"`, "next song preloaded");
  check("Live: open a song from the setlist; the next one is prepared in the background", true);
  const liveSong = await invoke("studio_get_song", { songId: folderSong.id });
  await clickButton("Reproducir");
  await sleep(700);

  // Jump to a part: happens at the next bar line, seamlessly.
  const targetPart = liveSong.sections[3];
  const jumpsBefore = (await transport()).jumpsDone;
  await evaluate(`document.querySelector("[data-live-jump='${targetPart.label}']").click()`);
  await sleep(120);
  const pend = (await transport()).pendingJump;
  const liveBar = (4 * 60) / liveSong.originalBpm;
  const atBar = pend && Math.abs(((pend.atSec - liveSong.downbeatOffsetSec) / liveBar) - Math.round((pend.atSec - liveSong.downbeatOffsetSec) / liveBar)) < 0.001;
  check("Live: a part jump is scheduled on the next bar line", !!pend && atBar && Math.abs(pend.targetSec - targetPart.startSec) < 0.01, pend ? `at ${pend.atSec.toFixed(3)} s → ${pend.targetSec.toFixed(2)} s` : "none");
  for (let i = 0; i < 40 && (await transport()).jumpsDone === jumpsBefore; i++) await sleep(100);
  await sleep(500); // the render prepares the jump ~150 ms before it is heard
  tp = await transport();
  check("Live: the jump happened (no seek gap) and plays the part", tp.jumpsDone === jumpsBefore + 1 && tp.positionSec >= targetPart.startSec && tp.positionSec < targetPart.startSec + 2 && tp.underruns === 0, `pos ${tp.positionSec.toFixed(2)}`);
  await shot("12-live");

  // Loop the current part, cancel with Esc.
  await clickButton("Repetir la parte");
  await sleep(300);
  tp = await transport();
  check("Live: repeat the current part (loop)", tp.loopRange && Math.abs(tp.loopRange[0] - targetPart.startSec) < 0.01, JSON.stringify(tp.loopRange));
  await key("Escape", { code: "Escape" });
  await sleep(300);
  check("Live: Esc cancels the loop", (await transport()).loopRange === null);

  // Mixer changes are only for now (option B) until "Guardar mezcla".
  const savedBass = liveSong.tracks.find((t) => t.name === "Bass").volumeDb;
  await typeDb("Bass", "-12");
  await sleep(600);
  let dbBass = (await invoke("studio_get_song", { songId: folderSong.id })).tracks.find((t) => t.name === "Bass").volumeDb;
  const dirtyShown = await evaluate(`document.body.innerText.includes("Mezcla cambiada solo para ahora")`);
  check("Live: a fader change is only for now (the saved mix is untouched)", dirtyShown && dbBass === savedBass, `saved ${savedBass}, db ${dbBass}`);
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Volver a la guardada")).click()`);
  await sleep(300);
  const backTo = await evaluate(`document.querySelector("[aria-label^='Volumen de Bass:']")?.textContent`);
  check("Live: 'Volver a la guardada' restores the prepared mix", Number(backTo.replace("−", "-")) === savedBass, backTo);
  await typeDb("Bass", "-9");
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("Guardar mezcla")).click()`);
  await sleep(600);
  dbBass = (await invoke("studio_get_song", { songId: folderSong.id })).tracks.find((t) => t.name === "Bass").volumeDb;
  check("Live: 'Guardar mezcla' saves it with the song", dbBass === -9, String(dbBass));

  // Changing song while one plays asks first; the prepared song starts at once.
  await evaluate(`document.querySelector("[data-live-song='short']").click()`);
  await waitFor(`!!document.querySelector("[role=dialog][aria-label='Cambiar de canción']")`, "confirm switch");
  check("Live: switching songs while playing asks first", (await transport()).playState === "playing");
  const tSwitch = Date.now();
  await evaluate(`[...document.querySelectorAll("[role=dialog] button")].find(b => b.textContent.includes("Cambiar")).click()`);
  let st = null;
  for (let i = 0; i < 100; i++) {
    st = await invoke("studio_status");
    if (st.songId === shortSong.id && st.engine.state === "ready") break;
    await sleep(20);
  }
  const switchMs = Date.now() - tSwitch;
  check("Live: the prepared next song is ready instantly", st.songId === shortSong.id && st.engine.state === "ready" && switchMs < 600, `${switchMs} ms`);
  await waitFor(`document.querySelector("[data-live-title]")?.textContent === "short"`, "short shown");

  // Lock.
  await clickButton("Bloquear");
  await sleep(150);
  const lockedRows = await evaluate(`document.querySelector("[data-live-song='song']").disabled`);
  check("Live: lock prevents changing songs by accident", lockedRows === true);
  await clickButton("Desbloquear");
  await invoke("transport_stop");

  // ---- Phase 5: General Settings ----
  await evaluate(`location.hash = "#/settings"`);
  await waitFor(`document.querySelector("h1")?.textContent === "General Settings"`, "settings");
  await clickButton("Cambiar atajo: Repetir la parte actual (bucle)");
  await sleep(100);
  await key("b");
  await sleep(300);
  const sc = await invoke("ui_setting_get", { key: "shortcuts" });
  check("change a keyboard shortcut (loop → B), saved", sc?.loopPart === "B" && (await evaluate(`document.querySelector("[data-shortcut=loopPart]").textContent`)) === "B");
  await clickButton("Cambiar atajo: Repetir la parte actual (bucle)");
  await key("m");
  await sleep(300);
  const swapped = await invoke("ui_setting_get", { key: "shortcuts" });
  check("taking another action's key swaps them", swapped.loopPart === "M" && swapped.markPart === "B", JSON.stringify({ loop: swapped.loopPart, mark: swapped.markPart }));
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("atajos de fábrica")).click()`);
  await sleep(300);
  check("restore default shortcuts", (await invoke("ui_setting_get", { key: "shortcuts" })).loopPart === "L");
  await shot("13-settings");

  // Backup: export everything, import it back (nothing duplicated).
  const backupZip = join(dataDir, "copia-e2e.zip");
  const exp = await invoke("backup_export", { path: backupZip });
  check("backup: export songs + setlists to one zip", exp.songs >= 2 && exp.setlists >= 1 && existsSync(backupZip), exp.__error?.message ?? JSON.stringify(exp));
  const imp = await invoke("backup_import", { path: backupZip });
  check("backup: restoring it again duplicates nothing", imp.songs === 0 && imp.skippedSongs === exp.songs && imp.setlists === 0, imp.__error?.message ?? JSON.stringify(imp));

  await invoke("transport_set_master_gain", { gain: 1 });

  console.log(JSON.stringify(checks, null, 2));
  exitCode = checks.every((c) => c.ok) ? 0 : 1;
  ws.close();
} catch (e) {
  console.log(JSON.stringify(globalThis.__checks ?? [], null, 2));
  console.error("E2E FAILED:", e.message);
  try { await failureShot?.(); } catch {}
} finally {
  app.kill();
  await sleep(500);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
