import { useEffect, useState } from "react";
import { Pause, Play, SkipBack, Square, Volume2 } from "lucide-react";
import type { TransportState } from "@/lib/ipc/types";
import { dbToGain, formatDb, formatTime, gainToDb, MAX_DB, MIN_DB } from "./model";

interface Props {
  transport: TransportState | null;
  disabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onRestart: () => void;
  onGain: (gain: number) => void;
}

export function TransportBar({ transport, disabled, onPlay, onPause, onStop, onRestart, onGain }: Props) {
  const playing = transport?.playState === "playing";
  const [db, setDb] = useState<number | null>(null);

  // Follow the engine's value until the user moves the fader.
  useEffect(() => {
    if (db === null && transport) setDb(gainToDb(transport.masterGain));
  }, [transport, db]);

  const btn =
    "flex h-12 w-12 items-center justify-center rounded-xl border border-ink-700 bg-ink-850 text-ink-100 transition hover:bg-ink-700 disabled:opacity-40";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={btn} onClick={onRestart} disabled={disabled} aria-label="Volver al inicio" title="Volver al inicio (Inicio)">
        <SkipBack size={20} />
      </button>
      {playing ? (
        <button
          type="button"
          className={`${btn} h-14 w-14 border-live-500 bg-live-500/15 text-live-400`}
          onClick={onPause}
          disabled={disabled}
          aria-label="Pausa"
          title="Pausa (Espacio)"
        >
          <Pause size={26} />
        </button>
      ) : (
        <button
          type="button"
          className={`${btn} h-14 w-14 border-go-500 bg-go-500/15 text-go-400`}
          onClick={onPlay}
          disabled={disabled}
          aria-label="Reproducir"
          title="Reproducir (Espacio)"
        >
          <Play size={26} />
        </button>
      )}
      <button type="button" className={btn} onClick={onStop} disabled={disabled} aria-label="Detener" title="Detener (Esc)">
        <Square size={18} />
      </button>

      <div className="ml-2 font-mono text-2xl tabular-nums text-ink-100" aria-label="Posición">
        {formatTime(transport?.positionSec ?? 0)}
        <span className="text-base text-ink-400"> / {formatTime(transport?.durationSec ?? 0)}</span>
      </div>

      <label className="ml-auto flex items-center gap-2 text-xs text-ink-300">
        <Volume2 size={16} />
        <span className="sr-only">Volumen maestro</span>
        <input
          type="range"
          aria-label="Volumen maestro"
          min={MIN_DB}
          max={MAX_DB}
          step={0.5}
          value={db ?? 0}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDb(v);
            onGain(dbToGain(v));
          }}
          onDoubleClick={() => {
            setDb(0);
            onGain(1);
          }}
          className="w-36 accent-info-500"
          title="Doble clic: 0 dB"
        />
        <span className="w-16 text-right font-mono text-ink-100">{formatDb(db ?? 0)}</span>
      </label>
    </div>
  );
}
