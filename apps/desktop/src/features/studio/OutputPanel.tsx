import { useEffect, useState } from "react";
import { Headphones, Speaker, SplitSquareHorizontal } from "lucide-react";
import type { LoadedSong, OutputMode, OutputSettings, SongRecord, TrackRole, TransportState } from "@/lib/ipc/types";
import { BUS_LABEL, busForRole, dbToGain, dbToFader, faderToDb, formatDb, gainToDb, TRACK_ROLES } from "./model";

const MODES: { mode: OutputMode; title: string; detail: string; icon: typeof Speaker; needs: number }[] = [
  {
    mode: "stereo",
    title: "Ensayo · todo junto",
    detail: "Instrumentos, click y cues mezclados por las salidas 1-2. Para audífonos o ensayar en casa.",
    icon: Headphones,
    needs: 1,
  },
  {
    mode: "split",
    title: "En vivo · 2 salidas",
    detail: "Salida 1 (izq.): instrumentos en mono → consola / PA. Salida 2 (der.): click y cues → in-ears de la banda.",
    icon: SplitSquareHorizontal,
    needs: 2,
  },
  {
    mode: "quad",
    title: "En vivo · 4 salidas",
    detail: "Salidas 1-2: instrumentos en estéreo → PA. Salidas 3-4: click y cues → in-ears.",
    icon: Speaker,
    needs: 4,
  },
];

interface OutputProps {
  settings: OutputSettings | null;
  transport: TransportState | null;
  song: LoadedSong | null;
  onChange: (s: OutputSettings) => void;
}

export function OutputPanel({ settings, transport, song, onChange }: OutputProps) {
  const channels = transport?.outputChannels ?? 0;
  const mode = settings?.mode ?? "stereo";
  const [monDb, setMonDb] = useState(gainToDb(settings?.monitorGain ?? 1));
  useEffect(() => setMonDb(gainToDb(settings?.monitorGain ?? 1)), [settings?.monitorGain]);
  const limiting = (transport?.mainLimiterGain ?? 1) < 0.999 || (transport?.monitorLimiterGain ?? 1) < 0.999;

  return (
    <div className="grid gap-3">
      <div className="grid gap-2" role="radiogroup" aria-label="Modo de salida">
        {MODES.map((m) => {
          const disabled = channels > 0 && channels < m.needs;
          const active = mode === m.mode;
          const Icon = m.icon;
          return (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange({ mode: m.mode, monitorGain: dbToGain(monDb), mainGain: settings?.mainGain ?? 1 })}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-left disabled:opacity-40 ${
                active ? "border-info-500 bg-info-500/10" : "border-ink-800 bg-ink-900 hover:border-ink-600"
              }`}
            >
              <Icon size={18} className={active ? "mt-0.5 text-info-400" : "mt-0.5 text-ink-400"} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-100">{m.title}</span>
                <span className="block text-xs text-ink-400">
                  {m.detail}
                  {disabled && ` (tu salida actual tiene ${channels} canales)`}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {mode === "split" && (
        <p className="rounded-md border border-live-500/40 bg-live-500/10 px-3 py-2 text-xs text-live-400">
          En este modo no escuches con audífonos: oirás los instrumentos por un lado y el click por el otro. Conecta la salida
          izquierda a la consola y la derecha al sistema de in-ears.
        </p>
      )}

      <label className="flex items-center gap-2 text-xs text-ink-300">
        <span className="w-28">Click y cues</span>
        <input
          type="range"
          aria-label="Volumen de click y cues"
          aria-valuetext={formatDb(monDb)}
          min={0}
          max={1000}
          step={1}
          value={Math.round(dbToFader(monDb) * 1000)}
          onDoubleClick={() => {
            setMonDb(0);
            onChange({ mode, monitorGain: 1, mainGain: settings?.mainGain ?? 1 });
          }}
          onChange={(e) => {
            const v = faderToDb(Number(e.target.value) / 1000);
            setMonDb(v);
            onChange({ mode, monitorGain: dbToGain(v), mainGain: settings?.mainGain ?? 1 });
          }}
          className="flex-1 accent-info-500"
        />
        <span className="w-16 text-right font-mono text-ink-100">{formatDb(monDb)}</span>
      </label>

      {song && (
        <p className="text-xs text-ink-400">
          Nivel ajustado automáticamente para que la suma de pistas no sature:{" "}
          <span className="font-mono text-ink-200">
            PA {formatDb(song.mainTrimDb)} · banda {formatDb(song.monitorTrimDb)}
          </span>
          . Limitador de seguridad: {limiting ? <span className="text-live-400">actuando</span> : "en reposo"}.
        </p>
      )}
    </div>
  );
}

interface TracksProps {
  song: SongRecord;
  onUpdate: (position: number, name: string, role: TrackRole) => void;
}

/** What each file is and where it goes (PA or band in-ears). */
export function TracksPanel({ song, onUpdate }: TracksProps) {
  const field = "rounded border border-ink-700 bg-ink-950 px-2 py-0.5 text-xs text-ink-100";
  return (
    <ul className="grid gap-1.5">
      {song.tracks.map((t) => (
        <li key={t.position} className="flex items-center gap-2" title={t.filePath}>
          <input
            aria-label={`Nombre de la pista ${t.position + 1}`}
            value={t.name}
            maxLength={80}
            onChange={(e) => onUpdate(t.position, e.target.value || t.name, t.role)}
            onKeyDown={(e) => e.stopPropagation()}
            className={`${field} min-w-0 flex-1`}
          />
          <select
            aria-label={`Qué es la pista ${t.position + 1}`}
            value={t.role}
            onChange={(e) => onUpdate(t.position, t.name, e.target.value as TrackRole)}
            className={field}
          >
            {TRACK_ROLES.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
          </select>
          <span
            className={`w-28 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-semibold ${
              busForRole(t.role) === "monitor" ? "bg-info-500/15 text-info-400" : "bg-go-500/10 text-go-400"
            }`}
          >
            {BUS_LABEL[busForRole(t.role)]}
          </span>
        </li>
      ))}
    </ul>
  );
}
