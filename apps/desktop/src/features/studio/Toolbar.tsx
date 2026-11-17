import { FolderOpen, Headphones, ListMusic, Pause, Play, RotateCcw, SkipBack, Speaker, SplitSquareHorizontal, Square } from "lucide-react";
import type { OutputInfo, OutputMode, SongRecord, SongSummary, TimeSignature, TransportState } from "@/lib/ipc/types";
import { barBeat, formatBpm, formatPercent, TIME_SIGNATURES } from "./model";

interface Props {
  native: boolean;
  song: SongRecord | null;
  recent: SongSummary[];
  transport: TransportState | null;
  output: OutputInfo | null;
  outputMode: OutputMode;
  ratio: number;
  beatsPerBar: number;
  ready: boolean;
  onOpen: () => void;
  onOpenRecent: (id: number) => void;
  onMeter: (ts: TimeSignature) => void;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onRestart: () => void;
  onTargetBpm: (bpm: number | null) => void;
  onOutputMode: (mode: OutputMode) => void;
}

function clock(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
}

const OUTPUTS: { mode: OutputMode; label: string; short: string; icon: typeof Speaker; needs: number; hint: string }[] = [
  { mode: "stereo", label: "Ensayo", short: "Ensayo", icon: Headphones, needs: 1, hint: "Todo junto por 1-2 (audífonos, ensayo)" },
  { mode: "split", label: "En vivo · 2 salidas", short: "Vivo 2", icon: SplitSquareHorizontal, needs: 2, hint: "Salida 1: instrumentos → PA · Salida 2: click y cues → banda" },
  { mode: "quad", label: "En vivo · 4 salidas", short: "Vivo 4", icon: Speaker, needs: 4, hint: "1-2: instrumentos → PA · 3-4: click y cues → banda" },
];

export function Toolbar(p: Props) {
  const playing = p.transport?.playState === "playing";
  const pos = p.transport?.positionSec ?? 0;
  const bb = p.song ? barBeat(pos, p.song.originalBpm, p.song.downbeatOffsetSec, p.beatsPerBar) : null;
  const original = p.song?.originalBpm ?? null;
  const target = original ? (p.song?.targetBpm ?? original) : null;
  const channels = p.transport?.outputChannels ?? 0;
  const btn = "flex h-11 w-11 items-center justify-center rounded-lg bg-ink-800 text-ink-100 hover:bg-ink-700 disabled:opacity-40";

  return (
    <div className="flex h-16 shrink-0 items-center gap-4 border-b border-ink-800 bg-gradient-to-b from-ink-850 to-ink-900 px-3">
      {/* Song */}
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={p.onOpen}
          disabled={!p.native}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-info-500 px-3 text-sm font-semibold text-white hover:bg-info-400 disabled:opacity-40"
          title="Abrir un zip, una carpeta o pistas"
        >
          <FolderOpen size={16} /> <span className="hidden 2xl:inline">Abrir pistas</span><span className="2xl:hidden sr-only">Abrir pistas</span>
        </button>
        {p.recent.length > 0 && (
          <label className="flex items-center" title="Canciones recientes">
            <ListMusic size={16} className="mr-1 text-ink-400" />
            <select
              aria-label="Canciones recientes"
              value=""
              onChange={(e) => e.target.value && p.onOpenRecent(Number(e.target.value))}
              className="w-28 rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-xs text-ink-100"
            >
              <option value="">Recientes…</option>
              {p.recent.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="min-w-0 pl-1">
          <h1 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Multitrack Studio</h1>
          <div className="flex items-center gap-2">
            <span className="max-w-40 truncate text-sm font-bold text-ink-100" title={p.song?.title}>
              {p.song?.title ?? "Sin canción"}
            </span>
            {p.song && (
              <select
                aria-label="Compás de la canción"
                value={p.song.timeSignature}
                onChange={(e) => p.onMeter(e.target.value as TimeSignature)}
                className="rounded border border-ink-700 bg-ink-850 px-1 py-0.5 text-[11px] text-ink-200"
              >
                {TIME_SIGNATURES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.value}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Transport + clock */}
      <div className="flex items-center gap-2">
        <button type="button" className={btn} onClick={p.onRestart} disabled={!p.ready} aria-label="Volver al inicio" title="Volver al inicio (Inicio)">
          <SkipBack size={20} />
        </button>
        {playing ? (
          <button type="button" onClick={p.onPause} disabled={!p.ready} aria-label="Pausa" title="Pausa (Espacio)"
            className="flex h-11 w-14 items-center justify-center rounded-lg bg-info-500 text-white shadow-[0_0_14px] shadow-info-500/50 hover:bg-info-400 disabled:opacity-40">
            <Pause size={24} />
          </button>
        ) : (
          <button type="button" onClick={p.onPlay} disabled={!p.ready} aria-label="Reproducir" title="Reproducir (Espacio)"
            className="flex h-11 w-14 items-center justify-center rounded-lg bg-info-500 text-white hover:bg-info-400 disabled:opacity-40">
            <Play size={24} />
          </button>
        )}
        <button type="button" className={btn} onClick={p.onStop} disabled={!p.ready} aria-label="Detener" title="Detener (Esc)">
          <Square size={18} />
        </button>
        <div className="ml-1 flex min-w-40 flex-col items-center rounded-lg border border-ink-800 bg-black px-3 py-1 shadow-[inset_0_0_12px_rgba(0,0,0,0.9)]" aria-label="Posición">
          <span className="font-mono text-[26px] leading-none font-semibold tabular-nums text-go-400" style={{ textShadow: "0 0 10px rgba(74,222,128,0.45)" }}>
            {clock(pos)}
          </span>
          <span className="font-mono text-[10px] text-ink-400">
            {bb ? `Compás ${bb.bar} · ${bb.beat}` : "—"} {original ? `· ${formatBpm(target ?? original)} BPM` : ""}
          </span>
        </div>
      </div>

      {/* Tempo */}
      <div className="flex items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-950/60 px-2 py-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-400">Tempo</span>
        <button type="button" disabled={!target} onClick={() => target && p.onTargetBpm(target - 1)} aria-label="Bajar 1 BPM"
          className="h-7 w-7 rounded bg-ink-800 text-sm text-ink-100 hover:bg-ink-700 disabled:opacity-40">−</button>
        <span className="w-12 text-center font-mono text-base text-ink-100">{target ? formatBpm(target) : "—"}</span>
        <button type="button" disabled={!target} onClick={() => target && p.onTargetBpm(target + 1)} aria-label="Subir 1 BPM"
          className="h-7 w-7 rounded bg-ink-800 text-sm text-ink-100 hover:bg-ink-700 disabled:opacity-40">+</button>
        <span className={`w-12 text-center font-mono text-xs ${p.ratio === 1 ? "text-ink-400" : "text-live-400"}`}>{formatPercent(p.ratio)}</span>
        <button type="button" disabled={p.ratio === 1} onClick={() => p.onTargetBpm(null)} title="Volver al tempo original"
          className="flex h-7 items-center gap-1 rounded bg-ink-800 px-2 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40">
          <RotateCcw size={11} /> Original
        </button>
      </div>

      {/* Outputs + engine */}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <div className="flex overflow-hidden rounded-lg border border-ink-700" role="radiogroup" aria-label="Salida">
          {OUTPUTS.map((o) => {
            const Icon = o.icon;
            const disabled = channels > 0 && channels < o.needs;
            const active = p.outputMode === o.mode;
            return (
              <button
                key={o.mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => p.onOutputMode(o.mode)}
                title={disabled ? `${o.hint} (tu salida tiene ${channels} canales)` : o.hint}
                className={`flex h-9 items-center gap-1.5 px-2.5 text-xs font-semibold disabled:opacity-35 ${
                  active ? "bg-info-500 text-white" : "bg-ink-850 text-ink-300 hover:bg-ink-800"
                }`}
              >
                <Icon size={14} />
                <span className="hidden 2xl:inline">{o.label}</span>
                <span className="2xl:hidden">{o.short}</span>
                <span className="sr-only 2xl:hidden">{o.label}</span>
              </button>
            );
          })}
        </div>
        <div className="hidden font-mono text-[10px] leading-tight text-ink-400 2xl:block">
          <div>{p.output?.sampleRate ? `${p.output.sampleRate / 1000} kHz · ${p.output.bufferSize} smp` : "Sin salida"}</div>
          <div>
            Render {Math.round((p.transport?.renderLoad ?? 0) * 100)} % · Cortes{" "}
            <span className={(p.transport?.underruns ?? 0) > 0 ? "text-stop-500" : "text-go-400"}>{p.transport?.underruns ?? 0}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
