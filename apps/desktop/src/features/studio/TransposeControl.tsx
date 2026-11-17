import { Music2, RotateCcw } from "lucide-react";
import { formatSemitones, MAX_TRANSPOSE, transposeKey } from "./model";

interface Props {
  /** Key of the recording ("D", "F#m"; "" if unknown). */
  songKey: string;
  semitones: number;
  disabled?: boolean;
  onChange: (semitones: number) => void;
  /** Larger buttons for the stage view. */
  large?: boolean;
}

/**
 * Key change: half a tone up / down at a time. Shows the key that sounds
 * ("D → E") when the song's key is known. Click and cues are never shifted.
 */
export function TransposeControl({ songKey, semitones, disabled, onChange, large }: Props) {
  const sounding = songKey ? transposeKey(songKey, semitones) || songKey : "";
  const btn = large
    ? "h-10 w-10 rounded-lg bg-ink-800 text-lg font-bold text-ink-100 hover:bg-ink-700 disabled:opacity-40"
    : "h-7 w-7 rounded bg-ink-800 text-sm text-ink-100 hover:bg-ink-700 disabled:opacity-40";
  return (
    <div
      className={`flex items-center gap-1.5 rounded-lg border border-ink-800 bg-ink-950/60 px-2 py-1 ${semitones ? "border-live-500/50" : ""}`}
      title="Cambio de tono: mueve las pistas de música medio tono cada vez, sin cambiar el tempo. El click y los cues no cambian."
      data-transpose={semitones}
    >
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-ink-400">
        <Music2 size={11} /> <span className={large ? "" : "hidden 2xl:inline"}>Tono</span>
      </span>
      <button type="button" className={btn} disabled={disabled || semitones <= -MAX_TRANSPOSE} onClick={() => onChange(semitones - 1)} aria-label="Bajar medio tono">
        −
      </button>
      <span className={`min-w-[4.5rem] text-center ${large ? "text-lg" : "text-sm"}`}>
        {songKey ? (
          <>
            <span className={`font-bold ${semitones ? "text-live-400" : "text-ink-100"}`} data-sounding-key>
              {sounding}
            </span>
            {semitones !== 0 && <span className="ml-1 font-mono text-xs text-ink-400">({formatSemitones(semitones)})</span>}
          </>
        ) : (
          <span className={`font-mono ${semitones ? "text-live-400" : "text-ink-100"}`}>{semitones ? formatSemitones(semitones) : "Original"}</span>
        )}
      </span>
      <button type="button" className={btn} disabled={disabled || semitones >= MAX_TRANSPOSE} onClick={() => onChange(semitones + 1)} aria-label="Subir medio tono">
        +
      </button>
      <button
        type="button"
        disabled={disabled || semitones === 0}
        onClick={() => onChange(0)}
        aria-label="Volver al tono original"
        title={songKey ? `Volver al tono original (${songKey})` : "Volver al tono original"}
        className={`flex items-center gap-1 rounded bg-ink-800 px-2 text-xs text-ink-200 hover:bg-ink-700 disabled:opacity-40 ${large ? "h-10" : "h-7"}`}
      >
        <RotateCcw size={11} /> <span className={large ? "" : "hidden 2xl:inline"}>{songKey || "Original"}</span>
      </button>
    </div>
  );
}
