import { Headphones, Speaker } from "lucide-react";
import type { CSSProperties } from "react";
import type { Bus, TrackRole } from "@/lib/ipc/types";
import { Meter } from "./Meter";
import { formatDb, MAX_DB, MIN_DB, ROLE_COLORS, textOn } from "./model";
import type { MeterStore } from "./useStudio";

export interface MixerTrack {
  index: number;
  name: string;
  role: TrackRole;
  bus: Bus;
}

const FADER_H = 150;

/** Vertical fader made from a native range input (keyboard + wheel accessible). */
function Fader({ value, onChange, label }: { value: number; onChange: (db: number) => void; label: string }) {
  const style: CSSProperties = { writingMode: "vertical-lr", direction: "rtl", height: FADER_H, width: 22 };
  return (
    <input
      type="range"
      aria-label={label}
      min={MIN_DB}
      max={MAX_DB}
      step={0.5}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => onChange(0)}
      onWheel={(e) => onChange(Math.min(MAX_DB, Math.max(MIN_DB, value + (e.deltaY < 0 ? 0.5 : -0.5))))}
      title="Doble clic: 0 dB"
      className="lp-fader cursor-ns-resize accent-ink-100"
      style={style}
    />
  );
}

function ToggleButton({ active, onClick, children, color, label }: { active: boolean; onClick: () => void; children: string; color: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="h-6 w-7 rounded text-[11px] font-bold transition-colors"
      style={active ? { background: color, color: "#0a0b0d" } : { background: "#272c33", color: "#a3aab5" }}
    >
      {children}
    </button>
  );
}

interface StripProps {
  name: string;
  color: string;
  db: number;
  onDb: (db: number) => void;
  read: () => number[];
  badge: Bus;
  mute?: boolean;
  solo?: boolean;
  onMute?: () => void;
  onSolo?: () => void;
  wide?: boolean;
  footnote?: string;
}

function Strip({ name, color, db, onDb, read, badge, mute, solo, onMute, onSolo, wide, footnote }: StripProps) {
  return (
    <div
      className={`flex shrink-0 flex-col items-center gap-1.5 border-r border-ink-800 px-1.5 pt-2 ${wide ? "w-28 bg-ink-850" : "w-[78px]"}`}
      data-strip={name}
    >
      <span
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
          badge === "monitor" ? "bg-info-500/20 text-info-400" : "bg-go-500/15 text-go-400"
        }`}
        title={badge === "monitor" ? "Solo la banda (in-ears)" : "PA (público)"}
      >
        {badge === "monitor" ? <Headphones size={10} /> : <Speaker size={10} />}
        {badge === "monitor" ? "Banda" : "PA"}
      </span>
      <span className="font-mono text-[11px] text-ink-100">{formatDb(db).replace(" dB", "")}</span>
      <div className="flex items-end gap-1.5">
        <Fader value={db} onChange={onDb} label={`Volumen de ${name}`} />
        <Meter read={read} height={FADER_H} barWidth={wide ? 6 : 4} />
      </div>
      <div className="flex gap-1">
        {onMute && <ToggleButton active={!!mute} onClick={onMute} color="#f97316" label={`Silenciar ${name}`}>M</ToggleButton>}
        {onSolo && <ToggleButton active={!!solo} onClick={onSolo} color="#facc15" label={`Solo ${name}`}>S</ToggleButton>}
      </div>
      {footnote && <span className="text-center text-[9px] leading-tight text-ink-400">{footnote}</span>}
      <div
        className="mt-auto mb-1.5 w-full truncate rounded px-1 py-1 text-center text-[10px] font-bold uppercase"
        style={{ background: color, color: textOn(color) }}
        title={name}
      >
        {name}
      </div>
    </div>
  );
}

interface MixerProps {
  tracks: MixerTrack[];
  volumesDb: number[];
  mute: boolean[];
  solo: boolean[];
  meters: MeterStore;
  masterDb: number;
  monitorDb: number;
  limiting: { main: boolean; monitor: boolean };
  onVolume: (track: number, db: number) => void;
  onMute: (track: number) => void;
  onSolo: (track: number) => void;
  onMaster: (db: number) => void;
  onMonitor: (db: number) => void;
}

/** Console-style mixer: one strip per track, then the PA and band buses. */
export function Mixer(p: MixerProps) {
  return (
    <div className="flex h-full min-w-0 overflow-x-auto overflow-y-hidden" role="group" aria-label="Mezclador">
      {p.tracks.map((t) => (
        <Strip
          key={t.index}
          name={t.name}
          color={ROLE_COLORS[t.role]}
          db={p.volumesDb[t.index] ?? 0}
          onDb={(db) => p.onVolume(t.index, db)}
          read={() => [p.meters.current.tracks[t.index] ?? 0]}
          badge={t.bus}
          mute={p.mute[t.index]}
          solo={p.solo[t.index]}
          onMute={() => p.onMute(t.index)}
          onSolo={() => p.onSolo(t.index)}
        />
      ))}
      <div className="ml-auto flex border-l-2 border-ink-700">
        <Strip
          name="PA · instrumentos"
          color="#22c55e"
          db={p.masterDb}
          onDb={p.onMaster}
          read={() => p.meters.current.main}
          badge="main"
          wide
          footnote={p.limiting.main ? "limitador actuando" : undefined}
        />
        <Strip
          name="Banda · click/cues"
          color="#38bdf8"
          db={p.monitorDb}
          onDb={p.onMonitor}
          read={() => p.meters.current.monitor}
          badge="monitor"
          wide
          footnote={p.limiting.monitor ? "limitador actuando" : undefined}
        />
      </div>
    </div>
  );
}
