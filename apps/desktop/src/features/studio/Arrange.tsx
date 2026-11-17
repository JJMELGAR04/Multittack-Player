import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, Headphones, Speaker } from "lucide-react";
import type { Bus, TrackRole, TransportState } from "@/lib/ipc/types";
import { Meter } from "./Meter";
import { formatTime, ROLE_COLORS, roleLabel, SECTION_COLORS, snapToBar, textOn, type TimedSection } from "./model";
import type { MeterStore } from "./useStudio";

const PEAKS_PER_SECOND = 100;
const HEADER_W = 236;
const RULER_H = 34;
const MARKERS_H = 30;
const LANE_H = 58;

export interface ArrangeTrack {
  /** Engine track index (load position). */
  index: number;
  name: string;
  role: TrackRole;
  bus: Bus;
}

interface Props {
  durationSec: number;
  /** Tracks in display order (top to bottom). */
  tracks: ArrangeTrack[];
  peaks: Uint8Array[] | null;
  sections: TimedSection[];
  bpm: number | null;
  beatsPerBar: number;
  downbeatSec: number;
  transport: TransportState | null;
  transportAt: number;
  meters: MeterStore;
  mute: boolean[];
  solo: boolean[];
  editing: boolean;
  selected: number;
  onSeek: (sec: number) => void;
  onSectionClick: (index: number) => void;
  onSectionMove: (index: number, startSec: number) => void;
  onMute: (track: number) => void;
  onSolo: (track: number) => void;
  /** Moves the track shown at `from` to row `to` (display indices). */
  onReorder: (from: number, to: number) => void;
}

function livePosition(t: TransportState | null, at: number): number {
  if (!t) return 0;
  if (t.playState !== "playing") return t.positionSec;
  const elapsed = (performance.now() - at) / 1000;
  return Math.min(t.durationSec, t.positionSec + Math.min(elapsed, 0.25) * t.tempoRatio);
}

/** One clip: the track's waveform in white over its colour. */
function Lane({ peaks, color, width, durationSec, dim }: { peaks: Uint8Array | undefined; color: string; width: number; durationSec: number; dim: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const h = LANE_H - 8;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    if (!peaks || peaks.length === 0) return;

    let first = 0, last = peaks.length - 1;
    while (first < peaks.length && peaks[first]! < 3) first++;
    while (last > first && peaks[last]! < 3) last--;
    if (first >= peaks.length) return;
    const total = durationSec * PEAKS_PER_SECOND;
    const x0 = (first / total) * width, x1 = ((last + 1) / total) * width;

    // Clip body + a lighter title strip, like a region in a DAW.
    ctx.fillStyle = color + "99";
    ctx.beginPath();
    ctx.roundRect(x0, 0, Math.max(3, x1 - x0), h, 5);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.93)";
    const mid = h / 2;
    const per = total / width;
    for (let px = Math.floor(x0); px < x1; px++) {
      const a = Math.floor(px * per), b = Math.max(a + 1, Math.floor((px + 1) * per));
      let v = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i]! > v) v = peaks[i]!;
      const bar = Math.max(0.5, (v / 255) * (mid - 3));
      ctx.fillRect(px, mid - bar, 1, bar * 2);
    }
  }, [peaks, color, width, durationSec]);
  return <canvas ref={ref} className={`block transition-opacity ${dim ? "opacity-25" : ""}`} style={{ width, height: LANE_H - 8 }} />;
}

export function Arrange(p: Props) {
  const { durationSec, tracks, sections, bpm, beatsPerBar, downbeatSec, transport, transportAt } = p;
  const wrapRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(900);
  const [drag, setDrag] = useState<{ index: number; sec: number } | null>(null);
  const [rowDrag, setRowDrag] = useState<{ from: number; startY: number; dy: number } | null>(null);
  const laneW = Math.max(100, width - HEADER_W - 12);
  const lanesH = tracks.length * LANE_H;
  const anySolo = p.solo.some(Boolean);
  const current = sections[p.selected];
  const xOf = (sec: number) => (durationSec > 0 ? (sec / durationSec) * laneW : 0);
  const secOf = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    return Math.min(durationSec, Math.max(0, ((clientX - rect.left) / laneW) * durationSec));
  };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Ruler: bar numbers (top row) + time (bottom row).
  useEffect(() => {
    const c = rulerRef.current;
    if (!c || durationSec <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(laneW * dpr);
    c.height = Math.round(RULER_H * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, laneW, RULER_H);
    ctx.font = "10px Inter, Segoe UI, sans-serif";
    const step = durationSec > 600 ? 60 : durationSec > 240 ? 20 : durationSec > 60 ? 10 : 5;
    for (let t = 0; t <= durationSec; t += step / 5) {
      const x = xOf(t);
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.fillStyle = major ? "#a3aab5" : "#3a4049";
      ctx.fillRect(x, major ? RULER_H - 14 : RULER_H - 5, 1, major ? 14 : 5);
      if (major) ctx.fillText(formatTime(t, 0), x + 3, RULER_H - 3);
    }
    if (bpm && bpm > 0) {
      const bar = (beatsPerBar * 60) / bpm;
      const every = Math.max(1, Math.ceil(36 / ((bar / durationSec) * laneW)));
      ctx.fillStyle = "#60a5fa";
      for (let n = 0, t = downbeatSec; t < durationSec; t += bar, n++)
        if (n % every === 0) {
          ctx.fillRect(xOf(t), 0, 1, 6);
          ctx.fillText(String(n + 1), xOf(t) + 3, 10);
        }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneW, durationSec, bpm, beatsPerBar, downbeatSec]);

  // Background grid behind the lanes: row stripes, bar lines, section starts.
  useEffect(() => {
    const c = gridRef.current;
    if (!c || durationSec <= 0 || lanesH <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(laneW * dpr);
    c.height = Math.round(lanesH * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, laneW, lanesH);
    for (let r = 0; r < tracks.length; r++) {
      ctx.fillStyle = r % 2 ? "#121418" : "#0f1114";
      ctx.fillRect(0, r * LANE_H, laneW, LANE_H);
    }
    if (bpm && bpm > 0) {
      const bar = (beatsPerBar * 60) / bpm;
      if ((bar / durationSec) * laneW > 5) {
        ctx.fillStyle = "rgba(255,255,255,0.045)";
        for (let t = downbeatSec; t < durationSec; t += bar) ctx.fillRect(xOf(t), 0, 1, lanesH);
      }
    }
    for (const s of sections) {
      ctx.fillStyle = SECTION_COLORS[s.kind] + "88";
      ctx.fillRect(xOf(s.startSec), 0, 1, lanesH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneW, lanesH, durationSec, bpm, beatsPerBar, downbeatSec, sections, tracks.length]);

  // Playhead (no React render per frame).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pos = livePosition(transport, transportAt);
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${HEADER_W + xOf(pos)}px)`;
      if (timeRef.current) timeRef.current.textContent = formatTime(pos);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, transportAt, laneW, durationSec]);

  // ---- Section marker dragging (edit mode) ----
  const startDrag = (index: number, e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ index, sec: sections[index]?.startSec ?? 0 });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const lane = (e.currentTarget as Element).closest("[data-markers]");
    if (!lane) return;
    const raw = secOf(e.clientX, lane);
    const sec = e.altKey ? raw : snapToBar(raw, bpm, downbeatSec, beatsPerBar);
    const min = (sections[drag.index - 1]?.startSec ?? -0.5) + 0.5;
    const max = (sections[drag.index + 1]?.startSec ?? durationSec) - 0.5;
    setDrag({ ...drag, sec: Math.min(max, Math.max(min, sec)) });
  };
  const endDrag = () => {
    if (drag) p.onSectionMove(drag.index, drag.sec);
    setDrag(null);
  };

  // ---- Track reordering (drag the grip of a header) ----
  const rowTarget = rowDrag ? Math.max(0, Math.min(tracks.length - 1, rowDrag.from + Math.round(rowDrag.dy / LANE_H))) : -1;
  const startRowDrag = (row: number, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers (tests) cannot be captured; dragging still works.
    }
    setRowDrag({ from: row, startY: e.clientY, dy: 0 });
  };
  const moveRowDrag = (e: ReactPointerEvent) => {
    if (!rowDrag) return;
    setRowDrag({ ...rowDrag, dy: e.clientY - rowDrag.startY });
    // Auto-scroll near the edges of the view.
    const wrap = wrapRef.current;
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      if (e.clientY < r.top + RULER_H + MARKERS_H + 20) wrap.scrollTop -= 8;
      else if (e.clientY > r.bottom - 20) wrap.scrollTop += 8;
    }
  };
  const endRowDrag = () => {
    if (rowDrag && rowTarget >= 0 && rowTarget !== rowDrag.from) p.onReorder(rowDrag.from, rowTarget);
    setRowDrag(null);
  };

  return (
    <div ref={wrapRef} className="relative h-full overflow-y-auto overflow-x-hidden bg-ink-950 select-none">
      {/* Sticky top: ruler + markers */}
      <div className="sticky top-0 z-20 bg-ink-900 shadow-[0_2px_6px_rgba(0,0,0,0.5)]">
        <div className="flex border-b border-ink-800" style={{ height: RULER_H }}>
          <div className="flex shrink-0 flex-col justify-center px-3 text-[10px] leading-tight text-ink-400" style={{ width: HEADER_W }}>
            <span className="text-info-400">Compás</span>
            <span>Tiempo</span>
          </div>
          <canvas
            ref={rulerRef}
            style={{ width: laneW, height: RULER_H }}
            className="cursor-pointer"
            onPointerDown={(e) => p.onSeek(secOf(e.clientX, e.currentTarget))}
          />
        </div>
        <div className="flex border-b border-ink-800" style={{ height: MARKERS_H }}>
          <div className="flex shrink-0 items-center justify-between px-3 text-[10px] uppercase tracking-wider text-ink-400" style={{ width: HEADER_W }}>
            <span>Partes</span>
            <span className="normal-case tracking-normal">{tracks.length} pistas</span>
          </div>
          <div className="relative" style={{ width: laneW }} data-markers>
            {sections.map((s, i) => {
              const start = drag?.index === i ? drag.sec : s.startSec;
              const left = xOf(start);
              const right = xOf(drag?.index === i + 1 ? drag.sec : s.endSec);
              const color = SECTION_COLORS[s.kind];
              const active = p.selected === i;
              return (
                <button
                  key={`${i}-${s.startSec}`}
                  type="button"
                  data-section={s.label}
                  title={`${s.label} · ${formatTime(start)} — clic para tocar desde aquí`}
                  onClick={() => p.onSectionClick(i)}
                  className="absolute top-1 flex h-[22px] items-center gap-1 overflow-hidden rounded-[4px] pr-2 text-left text-[11px] font-semibold text-white transition-[filter] hover:brightness-125"
                  style={{
                    left,
                    width: Math.max(6, right - left - 2),
                    background: active ? color : color + "4d",
                    borderLeft: `3px solid ${color}`,
                    boxShadow: active ? `0 0 10px ${color}99` : undefined,
                  }}
                >
                  <span className="ml-1 truncate">{s.label}</span>
                  {p.editing && i > 0 && (
                    <span
                      role="separator"
                      aria-label={`Mover inicio de ${s.label}`}
                      onPointerDown={(e) => startDrag(i, e)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/70"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Lanes area */}
      <div ref={rowsRef} className="relative" style={{ height: lanesH }}>
        <canvas ref={gridRef} className="pointer-events-none absolute top-0" style={{ left: HEADER_W, width: laneW, height: lanesH }} />
        {current && (
          <div
            className="pointer-events-none absolute top-0 bg-white/[0.035]"
            style={{ left: HEADER_W + xOf(current.startSec), width: Math.max(0, xOf(current.endSec) - xOf(current.startSec)), height: lanesH }}
          />
        )}

        {tracks.map((t, row) => {
          const color = ROLE_COLORS[t.role];
          const fg = textOn(color);
          const audible = anySolo ? p.solo[t.index] : !p.mute[t.index];
          const dragging = rowDrag?.from === row;
          return (
            <div
              key={t.index}
              data-track={t.name}
              className={`absolute inset-x-0 flex ${dragging ? "z-10 opacity-90 shadow-[0_6px_20px_rgba(0,0,0,0.7)]" : ""}`}
              style={{
                top: row * LANE_H,
                height: LANE_H,
                transform: dragging ? `translateY(${rowDrag!.dy}px)` : undefined,
                transition: dragging ? "none" : "top 120ms ease",
              }}
            >
              {/* Header */}
              <div className="flex shrink-0 items-stretch border-b border-black/70 bg-ink-900" style={{ width: HEADER_W }}>
                <button
                  type="button"
                  aria-label={`Arrastrar ${t.name} para cambiar el orden`}
                  title="Arrastra para cambiar el orden"
                  onPointerDown={(e) => startRowDrag(row, e)}
                  onPointerMove={moveRowDrag}
                  onPointerUp={endRowDrag}
                  onPointerCancel={() => setRowDrag(null)}
                  className="flex w-6 cursor-grab touch-none flex-col items-center justify-center bg-ink-850 text-ink-400 hover:text-ink-100 active:cursor-grabbing"
                >
                  <GripVertical size={14} />
                  <span className="font-mono text-[9px]">{row + 1}</span>
                </button>
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2" style={{ background: `linear-gradient(90deg, ${color}, ${color}cc)`, color: fg }}>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-bold uppercase leading-none" title={t.name}>
                      {t.name}
                    </span>
                    <span className="ml-auto shrink-0 opacity-80" title={t.bus === "monitor" ? "Solo la banda (in-ears)" : "PA"}>
                      {t.bus === "monitor" ? <Headphones size={12} /> : <Speaker size={12} />}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Silenciar ${t.name}`}
                      aria-pressed={p.mute[t.index]}
                      onClick={() => p.onMute(t.index)}
                      className="h-5 w-6 rounded-sm text-[10px] font-bold"
                      style={p.mute[t.index] ? { background: "#f97316", color: "#0a0b0d" } : { background: "rgba(0,0,0,0.4)", color: "#fff" }}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      aria-label={`Solo ${t.name}`}
                      aria-pressed={p.solo[t.index]}
                      onClick={() => p.onSolo(t.index)}
                      className="h-5 w-6 rounded-sm text-[10px] font-bold"
                      style={p.solo[t.index] ? { background: "#facc15", color: "#0a0b0d" } : { background: "rgba(0,0,0,0.4)", color: "#fff" }}
                    >
                      S
                    </button>
                    <span className="ml-1 truncate text-[10px] opacity-80">{roleLabel(t.role)}</span>
                  </div>
                </div>
                <div className="flex items-center bg-black px-1">
                  <Meter read={() => [p.meters.current.tracks[t.index] ?? 0]} height={LANE_H - 12} barWidth={5} />
                </div>
              </div>
              {/* Clip */}
              <div
                className="relative flex items-center border-b border-black/40"
                style={{ width: laneW }}
                onPointerDown={(e) => p.onSeek(secOf(e.clientX, e.currentTarget))}
              >
                <Lane peaks={p.peaks?.[t.index]} color={color} width={laneW} durationSec={durationSec} dim={!audible} />
              </div>
            </div>
          );
        })}

        {/* Drop indicator while reordering */}
        {rowDrag && rowTarget >= 0 && rowTarget !== rowDrag.from && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-info-400 shadow-[0_0_8px] shadow-info-400"
            style={{ top: (rowTarget > rowDrag.from ? rowTarget + 1 : rowTarget) * LANE_H - 1 }}
          />
        )}
      </div>

      {/* Playhead over ruler, markers and lanes */}
      <div
        ref={playheadRef}
        className="pointer-events-none absolute top-0 z-30 w-0.5 bg-[#ef4444] shadow-[0_0_6px_rgba(239,68,68,0.8)]"
        style={{ left: 0, height: Math.max(RULER_H + MARKERS_H + lanesH, 100) }}
      >
        <span ref={timeRef} className="absolute top-0.5 left-1 rounded bg-[#ef4444] px-1 font-mono text-[10px] font-semibold text-white" />
      </div>
    </div>
  );
}
