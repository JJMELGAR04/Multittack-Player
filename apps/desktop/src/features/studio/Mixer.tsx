import { GripHorizontal, Headphones, Speaker } from "lucide-react";
import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Bus, TrackRole } from "@/lib/ipc/types";
import { Meter } from "./Meter";
import { formatDb, MAX_DB, MIN_DB, parseDbInput, ROLE_COLORS, textOn } from "./model";
import type { MeterStore } from "./useStudio";

export interface MixerTrack {
  index: number;
  name: string;
  role: TrackRole;
  bus: Bus;
}

const FADER_H = 140;
const STRIP_W = 80;

interface GripHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

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

/** dB readout; double-click to type an exact value (Enter applies, Esc cancels). */
function DbReadout({ value, onCommit, name }: { value: number; onCommit: (db: number) => void; name: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  const shown = formatDb(value).replace(" dB", "");
  if (editing !== null) {
    const commit = () => {
      const v = parseDbInput(editing);
      if (v !== null) onCommit(v);
      setEditing(null);
    };
    return (
      <input
        autoFocus
        aria-label={`Escribir volumen de ${name}`}
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(null);
        }}
        inputMode="decimal"
        className="w-14 rounded border border-info-500 bg-black px-1 text-center font-mono text-[11px] text-go-400 outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`Volumen de ${name}: ${shown} dB (doble clic para escribir)`}
      title="Doble clic para escribir el valor exacto (−60 a +8 dB)"
      onDoubleClick={() => setEditing(value <= MIN_DB ? "-inf" : (Math.round(value * 10) / 10).toString())}
      className="w-14 cursor-text rounded bg-black px-1 text-center font-mono text-[11px] text-go-400 hover:ring-1 hover:ring-ink-600"
    >
      {shown}
    </button>
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
  number?: number;
  /** Drag handle (track strips only). */
  grip?: GripHandlers;
  dragX?: number;
}

function Strip({ name, color, db, onDb, read, badge, mute, solo, onMute, onSolo, wide, footnote, number, grip, dragX }: StripProps) {
  const dragging = dragX !== undefined;
  return (
    <div
      className={`relative flex shrink-0 flex-col items-center gap-1.5 border-r border-black/60 px-1.5 pt-1 ${
        wide ? "w-28 bg-gradient-to-b from-ink-800 to-ink-850" : "w-[80px] bg-gradient-to-b from-ink-850 to-ink-900"
      } ${dragging ? "z-10 opacity-90 shadow-[0_6px_20px_rgba(0,0,0,0.8)]" : ""}`}
      style={{ transform: dragging ? `translateX(${dragX}px)` : undefined }}
      data-strip={name}
    >
      <div className="absolute inset-x-0 top-0 h-0.5" style={{ background: color }} />
      {grip ? (
        <button
          type="button"
          aria-label={`Arrastrar el canal ${name} para cambiar el orden`}
          title="Arrastra a la izquierda o a la derecha para cambiar el orden"
          {...grip}
          className="flex h-4 w-full cursor-grab touch-none items-center justify-center gap-1 rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100 active:cursor-grabbing"
        >
          <GripHorizontal size={12} />
          <span className="font-mono text-[9px]">{number}</span>
        </button>
      ) : (
        number !== undefined && <span className="font-mono text-[9px] text-ink-400">{number}</span>
      )}
      <span
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
          badge === "monitor" ? "bg-info-500/20 text-info-400" : "bg-go-500/15 text-go-400"
        }`}
        title={badge === "monitor" ? "Solo la banda (in-ears)" : "PA (público)"}
      >
        {badge === "monitor" ? <Headphones size={10} /> : <Speaker size={10} />}
        {badge === "monitor" ? "Banda" : "PA"}
      </span>
      <DbReadout value={db} onCommit={onDb} name={name} />
      <div className="flex items-end gap-1.5">
        <Fader value={db} onChange={onDb} label={`Volumen de ${name}`} />
        <Meter read={read} height={FADER_H} barWidth={wide ? 7 : 5} />
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
  /** Moves the strip shown at `from` to position `to` (display indices). */
  onReorder: (from: number, to: number) => void;
}

/** Console-style mixer: one strip per track, then the PA and band buses. */
export function Mixer(p: MixerProps) {
  const [drag, setDrag] = useState<{ from: number; startX: number; dx: number } | null>(null);
  const target = drag ? Math.max(0, Math.min(p.tracks.length - 1, drag.from + Math.round(drag.dx / STRIP_W))) : -1;

  const gripFor = (col: number): GripHandlers => ({
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers (tests) cannot be captured; dragging still works.
      }
      setDrag({ from: col, startX: e.clientX, dx: 0 });
    },
    onPointerMove: (e) => {
      if (!drag || drag.from !== col) return;
      setDrag({ ...drag, dx: e.clientX - drag.startX });
      // Auto-scroll when dragging near the edges of the mixer.
      const scroller = e.currentTarget.closest("[data-mixer-scroll]");
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (e.clientX < r.left + 30) scroller.scrollLeft -= 10;
        else if (e.clientX > r.right - 30) scroller.scrollLeft += 10;
      }
    },
    onPointerUp: () => {
      if (drag && target >= 0 && target !== drag.from) p.onReorder(drag.from, target);
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  });

  return (
    <div className="flex h-full min-w-0 overflow-x-auto overflow-y-hidden" role="group" aria-label="Mezclador" data-mixer-scroll>
      <div className="relative flex shrink-0">
      {p.tracks.map((t, col) => (
        <Strip
          key={t.index}
          number={col + 1}
          grip={gripFor(col)}
          dragX={drag?.from === col ? drag.dx : undefined}
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
      {drag && target >= 0 && target !== drag.from && (
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-info-400 shadow-[0_0_8px] shadow-info-400"
          style={{ left: (target > drag.from ? target + 1 : target) * STRIP_W - 1 }}
        />
      )}
      </div>
      <div className="min-w-4 flex-1 bg-ink-950" />
      <div className="flex border-l-2 border-ink-700 shadow-[-6px_0_12px_rgba(0,0,0,0.5)]">
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
