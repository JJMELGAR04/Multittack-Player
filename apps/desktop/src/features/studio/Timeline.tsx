import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TransportState } from "@/lib/ipc/types";
import { formatTime, SECTION_COLORS, snapToBar, type TimedSection } from "./model";
import type { Peaks } from "./useStudio";

const PEAKS_PER_SECOND = 100;
const NAME_COLUMN = 148;
const RULER_H = 22;
const SECTIONS_H = 34;
const MIX_H = 96;
const TRACK_H = 34;

interface TimelineProps {
  durationSec: number;
  peaks: Peaks | null;
  trackNames: string[];
  sections: TimedSection[];
  bpm: number | null;
  beatsPerBar: number;
  downbeatSec: number;
  transport: TransportState | null;
  transportAt: number;
  editing: boolean;
  selected: number;
  onSeek: (sec: number) => void;
  onSectionClick: (index: number) => void;
  onSectionMove: (index: number, startSec: number) => void;
}

/** Current position, interpolated between transport updates for a smooth playhead. */
function livePosition(t: TransportState | null, at: number): number {
  if (!t) return 0;
  if (t.playState !== "playing") return t.positionSec;
  const elapsed = (performance.now() - at) / 1000;
  return Math.min(t.durationSec, t.positionSec + Math.min(elapsed, 0.25) * t.tempoRatio);
}

function drawWave(
  ctx: CanvasRenderingContext2D,
  peaks: Uint8Array,
  x0: number,
  y0: number,
  width: number,
  height: number,
  durationSec: number,
  colorAt: (sec: number) => string,
) {
  const mid = y0 + height / 2;
  const perPixel = (durationSec * PEAKS_PER_SECOND) / width;
  for (let px = 0; px < width; px++) {
    const a = Math.floor(px * perPixel);
    const b = Math.max(a + 1, Math.floor((px + 1) * perPixel));
    let v = 0;
    for (let i = a; i < b && i < peaks.length; i++) if (peaks[i]! > v) v = peaks[i]!;
    const h = Math.max(1, (v / 255) * (height / 2 - 2));
    ctx.fillStyle = colorAt(px / width * durationSec);
    ctx.fillRect(x0 + px, mid - h, 1, h * 2);
  }
}

export function Timeline(props: TimelineProps) {
  const { durationSec, peaks, trackNames, sections, bpm, beatsPerBar, downbeatSec, transport, transportAt } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<{ index: number; sec: number } | null>(null);

  const totalH = RULER_H + SECTIONS_H + MIX_H + trackNames.length * TRACK_H + 8;
  const waveW = Math.max(100, width - NAME_COLUMN);
  const xOf = (sec: number) => NAME_COLUMN + (durationSec > 0 ? (sec / durationSec) * waveW : 0);
  const secOf = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    return Math.min(durationSec, Math.max(0, ((clientX - rect.left - NAME_COLUMN) / waveW) * durationSec));
  };

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Static layers: ruler, bar grid, waveforms (section-coloured).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || durationSec <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(totalH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, totalH);

    // Ruler.
    ctx.fillStyle = "#7d8592";
    ctx.font = "10px Inter, Segoe UI, sans-serif";
    const step = durationSec > 600 ? 60 : durationSec > 240 ? 30 : durationSec > 60 ? 10 : 5;
    for (let t = 0; t <= durationSec; t += step) {
      const x = xOf(t);
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillText(formatTime(t, 0), x + 3, 12);
    }

    // Bar grid (subtle), only when bars are wide enough to be useful.
    const top = RULER_H + SECTIONS_H;
    if (bpm && bpm > 0) {
      const bar = (beatsPerBar * 60) / bpm;
      if ((bar / durationSec) * waveW > 6) {
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        for (let t = downbeatSec; t < durationSec; t += bar) ctx.fillRect(xOf(t), top, 1, totalH - top);
      }
    }

    const colorAt = (alpha: string) => (sec: number) => {
      let kind: TimedSection["kind"] | null = null;
      for (const s of sections) if (sec >= s.startSec) kind = s.kind;
      return (kind ? SECTION_COLORS[kind] : "#a3aab5") + alpha;
    };

    // Mix overview.
    ctx.fillStyle = "#16191d";
    ctx.fillRect(NAME_COLUMN, top, waveW, MIX_H);
    if (peaks) drawWave(ctx, peaks.mix, NAME_COLUMN, top, waveW, MIX_H, durationSec, colorAt("dd"));

    // Track lanes.
    trackNames.forEach((name, i) => {
      const y = top + MIX_H + 4 + i * TRACK_H;
      ctx.fillStyle = i % 2 ? "#111316" : "#14171a";
      ctx.fillRect(0, y, width, TRACK_H);
      ctx.fillStyle = "#a3aab5";
      ctx.font = "11px Inter, Segoe UI, sans-serif";
      ctx.fillText(name.length > 20 ? name.slice(0, 19) + "…" : name, 10, y + TRACK_H / 2 + 4);
      if (peaks?.tracks[i]) drawWave(ctx, peaks.tracks[i], NAME_COLUMN, y + 2, waveW, TRACK_H - 4, durationSec, () => "#7d8592");
    });

    ctx.fillStyle = "#a3aab5";
    ctx.font = "600 11px Inter, Segoe UI, sans-serif";
    ctx.fillText("MEZCLA", 10, top + MIX_H / 2 + 4);
    ctx.fillText("SECCIONES", 10, RULER_H + SECTIONS_H / 2 + 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, totalH, durationSec, peaks, trackNames, sections, bpm, beatsPerBar, downbeatSec]);

  // Playhead animation (no React re-render per frame).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pos = livePosition(transport, transportAt);
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${xOf(pos)}px)`;
      if (timeRef.current) timeRef.current.textContent = formatTime(pos);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, transportAt, width, durationSec]);

  const onWavePointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    if (e.clientX - rect.left < NAME_COLUMN) return;
    props.onSeek(secOf(e.clientX));
  };

  const startDrag = (index: number, e: ReactPointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ index, sec: sections[index]?.startSec ?? 0 });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    const raw = secOf(e.clientX);
    const sec = e.altKey ? raw : snapToBar(raw, bpm, downbeatSec, beatsPerBar);
    const min = (sections[drag.index - 1]?.startSec ?? -0.5) + 0.5;
    const max = (sections[drag.index + 1]?.startSec ?? durationSec) - 0.5;
    setDrag({ ...drag, sec: Math.min(max, Math.max(min, sec)) });
  };
  const endDrag = () => {
    if (drag) props.onSectionMove(drag.index, drag.sec);
    setDrag(null);
  };

  return (
    <div ref={wrapRef} className="relative select-none" style={{ height: totalH }}>
      <canvas ref={canvasRef} className="absolute inset-0" style={{ width, height: totalH }} />

      {/* Sections lane */}
      <div className="absolute" style={{ left: 0, top: RULER_H, width, height: SECTIONS_H }}>
        {sections.map((s, i) => {
          const start = drag?.index === i ? drag.sec : s.startSec;
          const left = xOf(start);
          const right = xOf(drag?.index === i + 1 ? drag.sec : s.endSec);
          const active = props.selected === i;
          return (
            <button
              key={`${i}-${s.startSec}`}
              type="button"
              data-section={s.label}
              title={`${s.label} · ${formatTime(start)} — clic para tocar desde aquí`}
              onClick={() => props.onSectionClick(i)}
              className={`absolute top-1 flex h-[26px] items-center overflow-hidden rounded-md px-2 text-left text-xs font-semibold text-white ring-offset-0 transition-[filter] hover:brightness-125 ${
                active ? "ring-2 ring-white" : ""
              }`}
              style={{ left: left + 1, width: Math.max(4, right - left - 2), background: SECTION_COLORS[s.kind] }}
            >
              <span className="truncate">{s.label}</span>
              {props.editing && i > 0 && (
                <span
                  role="separator"
                  aria-label={`Mover inicio de ${s.label}`}
                  onPointerDown={(e) => startDrag(i, e)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/60"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Click-to-seek area over the waveforms */}
      <div
        className="absolute cursor-text"
        style={{ left: 0, top: RULER_H + SECTIONS_H, width, height: totalH - RULER_H - SECTIONS_H }}
        onPointerDown={onWavePointer}
      />

      {/* Playhead */}
      <div
        ref={playheadRef}
        className="pointer-events-none absolute top-0 w-px bg-white shadow-[0_0_6px_rgba(255,255,255,0.8)]"
        style={{ left: 0, height: totalH }}
      >
        <span
          ref={timeRef}
          className="absolute -top-0.5 left-1 rounded bg-white px-1 font-mono text-[10px] font-semibold text-ink-950"
        />
      </div>
    </div>
  );
}
