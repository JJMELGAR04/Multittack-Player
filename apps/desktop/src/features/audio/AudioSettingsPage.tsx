import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Cpu, Headphones, RefreshCw, Settings2, SlidersHorizontal, Speaker, SplitSquareHorizontal, Volume2 } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { AudioDiagnostics, DeviceCapabilities, DeviceChoice, OutputMode, OutputSettings } from "@/lib/ipc/types";
import {
  bufferMs,
  choiceLabel,
  driverHint,
  driverLabel,
  formatRate,
  loadVerdict,
  outputChoices,
  outputLabel,
  routingFits,
  sortDriverTypes,
} from "./model";
import { useAudioStatus } from "./useAudioStatus";

const MODES: { mode: OutputMode; title: string; detail: string; icon: typeof Speaker; needs: number }[] = [
  { mode: "split", title: "En vivo · 2 salidas", detail: "Banda (instrumentos, mono) por una salida; click y cues por otra. Las dos van a la consola.", icon: SplitSquareHorizontal, needs: 2 },
  { mode: "stereo", title: "Ensayo · todo junto", detail: "Todo mezclado en estéreo por un par de salidas. Para audífonos o ensayar en casa.", icon: Headphones, needs: 1 },
  { mode: "quad", title: "En vivo · 4 salidas", detail: "Banda en estéreo por un par; click y cues en estéreo por otro.", icon: Speaker, needs: 4 },
];

const field = "w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100 disabled:opacity-50";

function Card({ title, icon: Icon, children }: { title: string; icon: typeof Speaker; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
        <Icon size={16} className="text-info-400" /> {title}
      </h2>
      {children}
    </section>
  );
}

export function AudioSettingsPage() {
  const native = isNativeAvailable();
  const { info, setInfo, refresh } = useAudioStatus(1000);
  const [diag, setDiag] = useState<AudioDiagnostics | null>(null);
  const [draft, setDraft] = useState<DeviceChoice | null>(null);
  const [caps, setCaps] = useState<DeviceCapabilities | null>(null);
  const [outputs, setOutputs] = useState<OutputSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toneOn, setToneOn] = useState<number | null>(null);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const scan = useCallback(() => {
    if (!native) return;
    backend.audioDiagnostics().then(setDiag, fail);
  }, [native]);
  useEffect(() => {
    scan();
    if (native) backend.studioOutputSettings().then(setOutputs, fail);
  }, [native, scan]);

  // Start the form from the saved choice (or the device that is open).
  useEffect(() => {
    if (draft || !info?.open) return;
    const p = info.preferred;
    setDraft(
      p ?? { typeName: info.typeName ?? "", deviceName: info.deviceName ?? "", sampleRate: info.sampleRate ?? 0, bufferSize: info.bufferSize ?? 0 },
    );
  }, [info, draft]);

  // Capabilities of the device in the form.
  useEffect(() => {
    if (!native || !draft?.typeName || !draft.deviceName) {
      setCaps(null);
      return;
    }
    let live = true;
    backend.audioDescribeDevice(draft.typeName, draft.deviceName).then((c) => live && setCaps(c), () => live && setCaps(null));
    return () => {
      live = false;
    };
  }, [native, draft?.typeName, draft?.deviceName]);

  const types = useMemo(() => sortDriverTypes(diag?.deviceTypes ?? []), [diag]);
  const devices = types.find((t) => t.name === draft?.typeName)?.outputDevices ?? [];
  const changed =
    !!draft &&
    !!info &&
    (draft.typeName !== (info.preferred?.typeName ?? info.typeName) ||
      draft.deviceName !== (info.preferred?.deviceName ?? info.deviceName) ||
      (draft.sampleRate > 0 && draft.sampleRate !== info.sampleRate) ||
      (draft.bufferSize > 0 && draft.bufferSize !== info.bufferSize) ||
      info.usingPreferred === false);

  const apply = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await backend.audioSetDevice(draft));
      scan();
    } catch (e) {
      fail(e);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const n = info?.outputChannels ?? 0;
  const mode: OutputMode = outputs?.mode ?? "stereo";
  const main = info?.mainChannel ?? 0;
  const monitor = info?.monitorChannel ?? 1;
  const names = info?.outputChannelNames;

  const setMode = async (m: OutputMode) => {
    if (!outputs) return;
    const next = { ...outputs, mode: m };
    try {
      await backend.studioSetOutput(next);
      setOutputs(next);
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const setChannels = async (nextMain: number, nextMonitor: number) => {
    // Picking the output the other bus uses swaps them (never both on one output).
    let m = nextMain;
    let s = nextMonitor;
    if (!routingFits(mode, m, s, n)) {
      if (nextMain !== main) s = main;
      else m = monitor;
    }
    if (!routingFits(mode, m, s, n)) {
      setError("Esa combinación de salidas no es posible con este dispositivo.");
      return;
    }
    setError(null);
    try {
      setInfo(await backend.audioSetChannels({ main: m, monitor: s }));
    } catch (e) {
      fail(e);
    }
  };

  const tone = async (ch: number) => {
    try {
      if (toneOn === ch) {
        await backend.audioTestTone(-1);
        setToneOn(null);
        return;
      }
      await backend.audioTestTone(ch);
      setToneOn(ch);
      window.setTimeout(() => setToneOn((cur) => (cur === ch ? null : cur)), 2000);
    } catch (e) {
      fail(e);
    }
  };

  /** What plays on each physical output with the current routing. */
  const busOn = (ch: number): string | null => {
    if (mode === "split") return ch === main ? "Banda" : ch === monitor ? "Click y cues" : null;
    if (mode === "quad") return ch === main || ch === main + 1 ? "Banda" : ch === monitor || ch === monitor + 1 ? "Click y cues" : null;
    return ch === main || ch === main + 1 ? "Todo" : null;
  };

  const rate = info?.sampleRate ?? 0;
  const verdict = loadVerdict(info?.cpuLoad ?? 0);
  const rates = caps?.available ? caps.sampleRates : [];
  const sizes = caps?.available ? caps.bufferSizes : [];

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <header className="mb-5 flex items-center gap-3">
        <SlidersHorizontal className="text-info-400" size={26} />
        <div>
          <h1 className="text-2xl font-bold">Audio Settings</h1>
          <p className="text-sm text-ink-300">Tu interfaz de audio y por qué salida va la banda y por cuál el click.</p>
        </div>
      </header>

      {!native && (
        <p className="mb-4 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: no hay acceso a los dispositivos de audio.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-3 text-sm text-stop-500">
          {error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Tarjeta de sonido" icon={Settings2}>
          {info?.preferred && info.usingPreferred === false && (
            <p className="mb-3 rounded-md border border-live-500/40 bg-live-500/10 px-3 py-2 text-xs text-live-400">
              «{info.preferred.deviceName}» no está conectado. Sonando por «{info.deviceName}» mientras tanto; al conectarlo vuelve solo.
            </p>
          )}
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs text-ink-300">
              Controlador
              <select
                aria-label="Controlador"
                className={field}
                value={draft?.typeName ?? ""}
                disabled={!draft}
                onChange={(e) => {
                  const t = types.find((x) => x.name === e.target.value);
                  setDraft({ typeName: e.target.value, deviceName: t?.outputDevices[0] ?? "", sampleRate: 0, bufferSize: 0 });
                }}
              >
                {types.map((t) => (
                  <option key={t.name} value={t.name}>
                    {driverLabel(t.name)}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-ink-400">{draft ? driverHint(draft.typeName) : ""}</span>
              {diag && !diag.asioSupported && <span className="text-[11px] text-ink-400">Esta compilación no incluye ASIO.</span>}
              {draft?.typeName === "ASIO" && devices.length === 0 && (
                <span className="text-[11px] text-live-400">No hay controladores ASIO instalados: instala el de tu interfaz (lo da el fabricante).</span>
              )}
            </label>

            <label className="grid gap-1 text-xs text-ink-300">
              <span className="flex items-center justify-between">
                Dispositivo
                <button type="button" onClick={scan} className="flex items-center gap-1 text-[11px] text-info-400 hover:text-ink-100" title="Volver a buscar">
                  <RefreshCw size={11} /> Buscar
                </button>
              </span>
              <select
                aria-label="Dispositivo de audio"
                className={field}
                value={draft?.deviceName ?? ""}
                disabled={!draft || devices.length === 0}
                onChange={(e) => draft && setDraft({ ...draft, deviceName: e.target.value, sampleRate: 0, bufferSize: 0 })}
              >
                {draft?.deviceName && !devices.includes(draft.deviceName) && <option value={draft.deviceName}>{draft.deviceName} (no conectado)</option>}
                {devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-xs text-ink-300">
                Frecuencia
                <select
                  aria-label="Frecuencia"
                  className={field}
                  value={draft?.sampleRate ?? 0}
                  disabled={!draft || rates.length === 0}
                  onChange={(e) => draft && setDraft({ ...draft, sampleRate: Number(e.target.value) })}
                >
                  <option value={0}>Por defecto</option>
                  {rates.map((r) => (
                    <option key={r} value={r}>
                      {formatRate(r)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-ink-300">
                Búfer
                <select
                  aria-label="Búfer"
                  className={field}
                  value={draft?.bufferSize ?? 0}
                  disabled={!draft || sizes.length === 0}
                  onChange={(e) => draft && setDraft({ ...draft, bufferSize: Number(e.target.value) })}
                >
                  <option value={0}>Por defecto{caps?.defaultBufferSize ? ` (${caps.defaultBufferSize})` : ""}</option>
                  {sizes.map((b) => (
                    <option key={b} value={b}>
                      {b} muestras · {bufferMs(b, draft?.sampleRate || rates[0] || rate).toFixed(1).replace(".", ",")} ms
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-[11px] text-ink-400">
              Búfer más pequeño = menos retraso; más grande = más estable. Si oyes cortes, súbelo.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void apply()}
                disabled={!changed || busy || !draft?.deviceName}
                className="rounded-lg bg-info-500 px-4 py-2 text-sm font-semibold text-white hover:bg-info-400 disabled:opacity-40"
              >
                {busy ? "Abriendo…" : "Aplicar dispositivo"}
              </button>
              {info?.hasControlPanel && (
                <button
                  type="button"
                  onClick={() => backend.audioShowPanel().then(refresh, fail)}
                  className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:border-ink-500"
                >
                  Panel del controlador
                </button>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-ink-950 px-3 py-2 text-xs" data-audio-current>
              <dt className="text-ink-400">Sonando por</dt>
              <dd className="truncate font-semibold text-ink-100" title={info?.deviceName}>
                {info?.open ? info.deviceName : "ninguna salida"}
              </dd>
              <dt className="text-ink-400">Controlador</dt>
              <dd className="text-ink-200">{info?.typeName ? driverLabel(info.typeName) : "—"}</dd>
              <dt className="text-ink-400">Frecuencia · búfer</dt>
              <dd className="font-mono text-ink-200">
                {rate ? `${formatRate(rate)} · ${info?.bufferSize} muestras` : "—"}
              </dd>
              <dt className="text-ink-400">Retraso de salida</dt>
              <dd className="font-mono text-ink-200">{info?.outputLatencyMs != null ? `${info.outputLatencyMs.toFixed(1).replace(".", ",")} ms` : "—"}</dd>
              <dt className="text-ink-400">Salidas</dt>
              <dd className="text-ink-200">{n || "—"}</dd>
            </dl>
            {info?.reloading && <p className="text-xs text-info-400">Adaptando la canción a la nueva frecuencia…</p>}
          </div>
        </Card>

        <Card title="Salidas" icon={Volume2}>
          <div className="grid gap-2" role="radiogroup" aria-label="Modo de salida">
            {MODES.map((m) => {
              const disabled = n > 0 && n < m.needs;
              const active = mode === m.mode;
              const Icon = m.icon;
              return (
                <button
                  key={m.mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled || !outputs}
                  onClick={() => void setMode(m.mode)}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-left disabled:opacity-40 ${
                    active ? "border-info-500 bg-info-500/10" : "border-ink-800 bg-ink-900 hover:border-ink-600"
                  }`}
                >
                  <Icon size={18} className={active ? "mt-0.5 text-info-400" : "mt-0.5 text-ink-400"} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-100">{m.title}</span>
                    <span className="block text-xs text-ink-400">
                      {m.detail}
                      {disabled && ` (este dispositivo tiene ${n} salidas)`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {n > 0 && (
            <div className="mt-4 grid gap-2">
              {mode === "stereo" ? (
                <label className="flex items-center gap-3 text-sm text-ink-200">
                  <span className="w-32 shrink-0">Todo por</span>
                  <select aria-label="Salida de la banda" className={field} value={main} onChange={(e) => void setChannels(Number(e.target.value), monitor)}>
                    {outputChoices(mode, n).map((c) => (
                      <option key={c.value} value={c.value}>
                        {choiceLabel(c.value, c.pair, names)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="flex items-center gap-3 text-sm text-ink-200">
                    <span className="flex w-32 shrink-0 items-center gap-1.5">
                      <Speaker size={14} className="text-go-400" /> Banda
                    </span>
                    <select aria-label="Salida de la banda" className={field} value={main} onChange={(e) => void setChannels(Number(e.target.value), monitor)}>
                      {outputChoices(mode, n).map((c) => (
                        <option key={c.value} value={c.value}>
                          {choiceLabel(c.value, c.pair, names)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-3 text-sm text-ink-200">
                    <span className="flex w-32 shrink-0 items-center gap-1.5">
                      <Headphones size={14} className="text-info-400" /> Click y cues
                    </span>
                    <select aria-label="Salida del click y cues" className={field} value={monitor} onChange={(e) => void setChannels(main, Number(e.target.value))}>
                      {outputChoices(mode, n).map((c) => (
                        <option key={c.value} value={c.value}>
                          {choiceLabel(c.value, c.pair, names)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    aria-label="Intercambiar salidas"
                    onClick={() => void setChannels(monitor, main)}
                    disabled={!routingFits(mode, monitor, main, n)}
                    className="flex items-center justify-center gap-2 justify-self-start rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 hover:border-ink-500 disabled:opacity-40"
                  >
                    <ArrowLeftRight size={14} /> Intercambiar salidas
                  </button>
                </>
              )}
            </div>
          )}

          {n > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs text-ink-300">
                <b>Probar salidas</b>: manda un tono de 1 kHz (−18 dBFS, 2 s) para identificar el canal en la consola.
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: n }, (_, ch) => {
                  const bus = busOn(ch);
                  return (
                    <button
                      key={ch}
                      type="button"
                      aria-label={`Probar salida ${ch + 1}`}
                      aria-pressed={toneOn === ch}
                      onClick={() => void tone(ch)}
                      title={outputLabel(ch, names)}
                      className={`flex min-w-[88px] flex-col items-start rounded-lg border px-3 py-1.5 text-left ${
                        toneOn === ch ? "border-go-500 bg-go-500/15" : "border-ink-700 bg-ink-950 hover:border-ink-500"
                      }`}
                    >
                      <span className="text-sm font-semibold text-ink-100">
                        {toneOn === ch ? "■" : "▶"} Salida {ch + 1}
                      </span>
                      <span className={`text-[10px] ${bus === "Banda" ? "text-go-400" : bus ? "text-info-400" : "text-ink-400"}`}>{bus ?? "sin uso"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </Card>

        <Card title="Estado en vivo" icon={Cpu}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" data-audio-health>
            <dt className="text-ink-400">Carga del audio</dt>
            <dd className={verdict.tone === "ok" ? "text-go-400" : verdict.tone === "warn" ? "text-live-400" : "text-stop-500"}>
              {Math.round((info?.cpuLoad ?? 0) * 100)} % · {verdict.label}
            </dd>
            <dt className="text-ink-400">Cortes del motor</dt>
            <dd className={(info?.underruns ?? 0) > 0 ? "text-stop-500" : "text-ink-100"}>{info?.underruns ?? 0}</dd>
            <dt className="text-ink-400">Cortes del controlador</dt>
            <dd className={(info?.xruns ?? 0) > 0 ? "text-stop-500" : "text-ink-100"}>
              {info?.xruns == null || info.xruns < 0 ? "no los informa" : info.xruns}
            </dd>
            <dt className="text-ink-400">Último aviso</dt>
            <dd className="text-xs text-ink-200">{info?.lastDeviceEvent || "ninguno"}</dd>
          </dl>
          <p className="mt-3 text-[11px] text-ink-400">
            Si la interfaz se desconecta en plena canción, LIVEPLAYER no se congela: avisa, sigue por la salida por defecto y vuelve a la
            interfaz en cuanto la conectas.
          </p>
        </Card>
      </div>
    </div>
  );
}
