// End-to-end smoke test: launches the real LIVEPLAYER exe with WebView2 remote
// debugging enabled and drives the UI through the Chrome DevTools Protocol.
// Usage: node scripts/e2e-smoke.mjs <path-to-liveplayer-desktop.exe> <screenshot-dir>
// (Windows only: relies on WebView2.)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const [exe, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
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
  check("engine_info: ABI v1", text.includes("v1"));
  check("audio_diagnostics: Windows Audio listed", text.includes("Windows Audio"));
  check("database_status: schema 1 + app_settings", text.includes("app_settings"));
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
  for (const [path, label] of [["/songs", "Songs"], ["/studio", "Multitrack Studio"], ["/setlists", "Setlists"], ["/live", "Live Mode"], ["/song-editor", "Song Editor"], ["/audio-settings", "Audio Settings"], ["/settings", "General Settings"]]) {
    await evaluate(`location.hash = "#${path}"`);
    await waitFor(`document.querySelector("h1")?.textContent === ${JSON.stringify(label)}`, label);
    check(`navigate ${path}`, true);
  }
  await shot("02-planned-module");

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
