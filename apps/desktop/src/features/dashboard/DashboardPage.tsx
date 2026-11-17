import { useState } from "react";
import { AudioWaveform, Cpu, Database, MonitorCog, RefreshCw, Zap } from "lucide-react";
import { KeyValue, Panel, type StatusTone } from "@/components/ui/Panel";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { EnginePing } from "@/lib/ipc/types";
import { useAsync, type AsyncState } from "@/lib/useAsync";

function toneOf(state: AsyncState<unknown>): StatusTone {
  if (state.status === "loading") return "pending";
  return state.status === "success" ? "ok" : "error";
}

function labelOf(state: AsyncState<unknown>, ok = "Conectado"): string {
  if (state.status === "loading") return "Comprobando…";
  return state.status === "success" ? ok : "Error";
}

function ErrorText({ error }: { error: Error }) {
  return <p className="text-sm text-stop-500">{error.message}</p>;
}

function ReloadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Volver a comprobar"
      className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
    >
      <RefreshCw size={14} />
    </button>
  );
}

function SystemPanel() {
  const app = useAsync(backend.appInfo);
  return (
    <Panel title="Aplicación" icon={<MonitorCog size={18} />} tone={toneOf(app)} statusLabel={labelOf(app, "Tauri activo")}>
      {app.status === "success" && (
        <dl>
          <KeyValue label="Versión" value={app.data.appVersion} />
          <KeyValue label="Sistema operativo" value={app.data.os} />
          <KeyValue label="Arquitectura" value={app.data.arch} />
        </dl>
      )}
      {app.status === "error" && <ErrorText error={app.error} />}
    </Panel>
  );
}

function EnginePanel() {
  const engine = useAsync(backend.engineInfo);
  const [ping, setPing] = useState<EnginePing | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [roundTrip, setRoundTrip] = useState<number | null>(null);

  async function runPing() {
    setBusy(true);
    setPingError(null);
    try {
      const value = Math.floor(Math.random() * 1_000_000);
      const started = performance.now();
      const result = await backend.enginePing(value);
      const roundTripMs = performance.now() - started;
      if (result.received !== value + 1) {
        throw new Error(`Respuesta inesperada del motor: ${result.received} ≠ ${value + 1}`);
      }
      setPing(result);
      setRoundTrip(roundTripMs);
    } catch (e) {
      setPing(null);
      setPingError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Motor de audio (C++ / JUCE)"
      icon={<Cpu size={18} />}
      tone={toneOf(engine)}
      statusLabel={labelOf(engine, "Motor cargado")}
      action={<ReloadButton onClick={engine.reload} />}
    >
      {engine.status === "success" && (
        <dl>
          <KeyValue label="Versión del motor" value={engine.data.engineVersion} />
          <KeyValue label="Versión de JUCE" value={engine.data.juceVersion} />
          <KeyValue label="ABI" value={`v${engine.data.abiVersion}`} />
          <KeyValue label="Compilación" value={engine.data.buildType} />
        </dl>
      )}
      {engine.status === "error" && <ErrorText error={engine.error} />}

      <div className="mt-4 flex items-center gap-4 border-t border-ink-800 pt-4">
        <button
          type="button"
          onClick={runPing}
          disabled={busy || engine.status !== "success"}
          className="flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-info-500 px-4 text-sm font-semibold text-white transition hover:bg-info-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Zap size={16} />
          Probar comunicación
        </button>
        <div className="font-mono text-xs text-ink-300" aria-live="polite">
          {ping && roundTrip !== null && (
            <span className="text-go-400">
              OK · {ping.sent} → {ping.received} · UI↔motor {roundTrip.toFixed(2)} ms · llamada nativa{" "}
              {ping.nativeMicros} µs
            </span>
          )}
          {pingError && <span className="text-stop-500">{pingError}</span>}
        </div>
      </div>
    </Panel>
  );
}

function AudioDriversPanel() {
  const diag = useAsync(backend.audioDiagnostics);
  return (
    <Panel
      title="Sistemas de audio detectados"
      icon={<AudioWaveform size={18} />}
      tone={toneOf(diag)}
      statusLabel={labelOf(diag, "Detección OK")}
      action={<ReloadButton onClick={diag.reload} />}
    >
      {diag.status === "success" &&
        (diag.data.deviceTypes.length === 0 ? (
          <p className="text-sm text-live-400">No se detectó ningún sistema de audio.</p>
        ) : (
          <ul className="space-y-3">
            {diag.data.deviceTypes.map((t) => (
              <li key={t.name}>
                <p className="text-sm font-semibold text-ink-100">{t.name}</p>
                {t.outputDevices.length === 0 ? (
                  <p className="text-xs text-ink-400">Sin dispositivos de salida</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {t.outputDevices.map((d) => (
                      <li key={d} className="truncate font-mono text-xs text-ink-300">
                        · {d}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ))}
      {diag.status === "error" && <ErrorText error={diag.error} />}
      <p className="mt-4 text-xs text-ink-400">
        Solo lectura. La selección de dispositivo y el enrutamiento llegan en la Fase 4.
      </p>
    </Panel>
  );
}

function DatabasePanel() {
  const db = useAsync(backend.databaseStatus);
  return (
    <Panel
      title="Base de datos (SQLite)"
      icon={<Database size={18} />}
      tone={toneOf(db)}
      statusLabel={labelOf(db, "Abierta")}
      action={<ReloadButton onClick={db.reload} />}
    >
      {db.status === "success" && (
        <dl>
          <KeyValue label="SQLite" value={db.data.sqliteVersion} />
          <KeyValue label="Versión del esquema" value={db.data.schemaVersion} />
          <KeyValue label="Tablas" value={db.data.tables.join(", ") || "—"} />
          <KeyValue label="Archivo" value={<span title={db.data.path}>{db.data.path}</span>} />
        </dl>
      )}
      {db.status === "error" && <ErrorText error={db.error} />}
    </Panel>
  );
}

export function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-live-400">Fase 4 · Tarjeta de sonido y salidas</p>
        <h1 className="mt-1 text-3xl font-bold">Dashboard</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-300">
          Estado de los componentes de LIVEPLAYER. Todos los datos provienen del backend nativo en tiempo real.
        </p>
      </header>

      {!isNativeAvailable() && (
        <div className="mb-6 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio. Inicia LIVEPLAYER con{" "}
          <code className="font-mono">npm run dev</code> para conectar con el motor nativo.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <EnginePanel />
        <AudioDriversPanel />
        <DatabasePanel />
        <SystemPanel />
      </div>
    </div>
  );
}
