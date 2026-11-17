import { useEffect, useRef } from "react";
import { meterFraction } from "./model";

interface Props {
  /** Returns the latest peak (linear) for each channel. */
  read: () => number[];
  height: number;
  /** Width of one channel bar in px. */
  barWidth?: number;
}

const FALL_DB_PER_SEC = 24;
const HOLD_MS = 1500;

/**
 * Vertical peak meter (-60..+6 dB): green, yellow above -12 dB, red above
 * -3 dB, with peak hold. Animated in requestAnimationFrame by writing styles
 * directly, so dozens of meters cost no React renders.
 */
export function Meter({ read, height, barWidth = 4 }: Props) {
  const fills = useRef<(HTMLDivElement | null)[]>([]);
  const holds = useRef<(HTMLDivElement | null)[]>([]);
  const readRef = useRef(read);
  readRef.current = read;
  const channels = read().length || 1;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const level: number[] = [];
    const hold: { v: number; t: number }[] = [];
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const values = readRef.current();
      values.forEach((peak, c) => {
        const target = meterFraction(peak);
        const fall = (FALL_DB_PER_SEC * dt) / 66;
        level[c] = Math.max(target, (level[c] ?? 0) - fall);
        const h = hold[c] ?? { v: 0, t: 0 };
        if (level[c]! >= h.v || now - h.t > HOLD_MS) hold[c] = { v: level[c]!, t: now };
        const fill = fills.current[c];
        if (fill) fill.style.height = `${(1 - level[c]!) * 100}%`; // mask over the fixed gradient
        const mark = holds.current[c];
        if (mark) {
          const v = hold[c]!.v;
          mark.style.bottom = `${v * 100}%`;
          mark.style.opacity = v > 0.01 ? "1" : "0";
          mark.style.background = v > 57 / 66 ? "#ef4444" : v > 48 / 66 ? "#facc15" : "#4ade80";
        }
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex gap-px" style={{ height }} aria-hidden>
      {Array.from({ length: channels }, (_, c) => (
        <div key={c} className="relative overflow-hidden rounded-[1px] bg-black/60" style={{ width: barWidth }}>
          {/* -60..+6 dB: red from -3 dB (57/66), yellow from -12 dB (48/66). */}
          <div
            className="absolute inset-0"
            style={{ background: "linear-gradient(to top, #22c55e 0%, #4ade80 72.7%, #facc15 72.7%, #facc15 86.4%, #ef4444 86.4%)" }}
          />
          <div
            ref={(el) => {
              fills.current[c] = el;
            }}
            className="absolute inset-x-0 top-0 bg-[#0b0d10]"
            style={{ height: "100%" }}
          />
          <div
            ref={(el) => {
              holds.current[c] = el;
            }}
            className="absolute inset-x-0 h-px"
            style={{ bottom: 0, opacity: 0 }}
          />
        </div>
      ))}
    </div>
  );
}
