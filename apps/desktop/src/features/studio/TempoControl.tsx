import { useEffect, useRef, useState } from "react";
import { Gauge, Hand, RotateCcw } from "lucide-react";
import type { DetectedTempo, SongRecord, TransportState } from "@/lib/ipc/types";
import {
  formatBpm,
  formatPercent,
  SLIDER_MAX_RATIO,
  SLIDER_MIN_RATIO,
  tapTempo,
  TEMPO_QUALITY_LABEL,
  tempoQuality,
} from "./model";

interface Props {
  song: SongRecord;
  detected: DetectedTempo | null | undefined;
  analysing: boolean;
  ratio: number;
  transport: TransportState | null;
  onTargetBpm: (bpm: number | null) => void;
  onOriginalBpm: (bpm: number) => void;
}

const QUALITY_COLOR = {
  original: "text-ink-300",
  excellent: "text-go-400",
  veryGood: "text-go-400",
  good: "text-live-400",
  audible: "text-stop-500",
} as const;

function sourceLabel(song: SongRecord, detected: DetectedTempo | null | undefined): string {
  if (song.bpmSource === "user") return "Manual";
  if (song.bpmSource === "detected")
    return detected?.source === "click" ? "Detectado (pista de click)" : "Detectado (mezcla)";
  return "Sin detectar";
}

function BpmInput({ value, onCommit, label }: { value: number | null; onCommit: (v: number) => void; label: string }) {
  const [text, setText] = useState(value != null ? formatBpm(value) : "");
  useEffect(() => setText(value != null ? formatBpm(value) : ""), [value]);
  const commit = () => {
    const v = Number(text.replace(",", "."));
    if (Number.isFinite(v) && v > 0) onCommit(v);
    else setText(value != null ? formatBpm(value) : "");
  };
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        e.stopPropagation(); // typing must not trigger transport shortcuts
      }}
      className="w-20 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-center font-mono text-lg text-ink-100 focus:border-info-500 focus:outline-none"
    />
  );
}

export function TempoControl({ song, detected, analysing, ratio, transport, onTargetBpm, onOriginalBpm }: Props) {
  const taps = useRef<number[]>([]);
  const [tapped, setTapped] = useState<number | null>(null);
  const original = song.originalBpm;
  const target = original ? (song.targetBpm ?? original) : null;
  const quality = tempoQuality(ratio);
  const small = "rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40";

  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 8000), now];
    const bpm = tapTempo(taps.current);
    setTapped(bpm);
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-ink-400">
          <Gauge size={14} /> Tempo original
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BpmInput value={original} onCommit={onOriginalBpm} label="BPM original" />
          <span className="text-sm text-ink-300">BPM</span>
          <button type="button" className={small} disabled={!original} onClick={() => original && onOriginalBpm(original / 2)} title="La mitad (si se detectó al doble)">
            ÷2
          </button>
          <button type="button" className={small} disabled={!original} onClick={() => original && onOriginalBpm(original * 2)} title="El doble (si se detectó a la mitad)">
            ×2
          </button>
          <button type="button" className={`${small} flex items-center gap-1`} onClick={tap} title="Toca al ritmo (3+ toques)">
            <Hand size={12} /> Tap{tapped ? ` ${formatBpm(tapped)}` : ""}
          </button>
          {tapped && (
            <button type="button" className={small} onClick={() => { onOriginalBpm(tapped); setTapped(null); taps.current = []; }}>
              Usar {formatBpm(tapped)}
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-400">
          {analysing && !original ? "Analizando el tempo…" : sourceLabel(song, detected)}
          {song.bpmSource === "detected" && detected && ` · confianza ${Math.round(detected.confidence * 100)} %`}
        </p>
      </div>

      <div>
        <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-ink-400">Tocar a</div>
        {original && target ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={small} onClick={() => onTargetBpm(target - 1)} aria-label="Bajar 1 BPM">−1</button>
              <BpmInput value={target} onCommit={onTargetBpm} label="BPM de reproducción" />
              <button type="button" className={small} onClick={() => onTargetBpm(target + 1)} aria-label="Subir 1 BPM">+1</button>
              <span className="font-mono text-sm text-ink-200">{formatPercent(ratio)}</span>
              <button type="button" className={`${small} flex items-center gap-1`} disabled={ratio === 1} onClick={() => onTargetBpm(null)}>
                <RotateCcw size={12} /> Original
              </button>
            </div>
            <input
              type="range"
              aria-label="Tempo"
              min={original * SLIDER_MIN_RATIO}
              max={original * SLIDER_MAX_RATIO}
              step={0.5}
              value={target}
              onChange={(e) => onTargetBpm(Number(e.target.value))}
              className="mt-2 w-full accent-live-500"
            />
            <p className={`text-xs ${QUALITY_COLOR[quality]}`}>
              {TEMPO_QUALITY_LABEL[quality]}
              {transport?.stretching ? " · tono conservado" : ""}
            </p>
          </>
        ) : (
          <p className="text-sm text-ink-400">
            {analysing ? "Esperando la detección del tempo…" : "Escribe el BPM original o usa Tap para poder cambiar el tempo."}
          </p>
        )}
      </div>
    </div>
  );
}
