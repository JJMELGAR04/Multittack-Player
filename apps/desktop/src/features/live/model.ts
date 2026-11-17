import type { SectionKind, SectionRecord } from "@/lib/ipc/types";
import { kindLabel, renumber, withEnds } from "@/features/studio/model";

// ---- Musical jumps ---------------------------------------------------------------

export type JumpMode = "bar" | "section" | "now";

export const JUMP_MODES: { mode: JumpMode; label: string; hint: string }[] = [
  { mode: "bar", label: "Al compás", hint: "Salta al terminar el compás actual: la banda no pierde el pulso." },
  { mode: "section", label: "Al terminar la parte", hint: "Termina la parte que suena y entonces salta." },
  { mode: "now", label: "Inmediato", hint: "Salta enseguida (con un fundido corto)." },
];

/** Length of one bar in song seconds. */
export function barSeconds(bpm: number, beatsPerBar: number): number {
  return (beatsPerBar * 60) / bpm;
}

/**
 * First bar line at or after `fromSec + leadSec` (song time). Without a tempo
 * the jump simply happens `leadSec` from now.
 */
export function nextBarAt(fromSec: number, leadSec: number, bpm: number | null, downbeatSec: number, beatsPerBar: number): number {
  const earliest = fromSec + leadSec;
  if (!bpm || bpm <= 0) return earliest;
  const bar = barSeconds(bpm, beatsPerBar);
  let n = Math.ceil((earliest - downbeatSec) / bar - 1e-9);
  let at = downbeatSec + n * bar;
  while (at < earliest - 1e-9) at = downbeatSec + ++n * bar;
  return Math.max(0, at);
}

/**
 * When a jump requested now should happen. `null` = do it immediately
 * (a plain seek) because there is no musical point far enough ahead.
 */
export function jumpTime(
  mode: JumpMode,
  positionSec: number,
  leadSec: number,
  bpm: number | null,
  downbeatSec: number,
  beatsPerBar: number,
  currentSectionEnd: number | null,
  durationSec: number,
): number | null {
  if (mode === "now") return null;
  if (mode === "section" && currentSectionEnd !== null && currentSectionEnd >= positionSec + leadSec) return currentSectionEnd;
  const at = nextBarAt(positionSec, leadSec, bpm, downbeatSec, beatsPerBar);
  return at < durationSec ? at : null;
}

// ---- Song Editor: editing parts ------------------------------------------------------

/** Shortest part allowed while editing (seconds). */
export const MIN_PART_SEC = 0.5;

/** Moves the start of part `index` (index 0 cannot move: the song starts with it). */
export function moveBoundary(sections: SectionRecord[], index: number, startSec: number, durationSec: number): SectionRecord[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  if (index <= 0 || index >= sorted.length) return sorted;
  const lo = sorted[index - 1]!.startSec + MIN_PART_SEC;
  const hi = (index + 1 < sorted.length ? sorted[index + 1]!.startSec : durationSec) - MIN_PART_SEC;
  if (hi < lo) return sorted;
  const clamped = Math.min(hi, Math.max(lo, startSec));
  return sorted.map((s, i) => (i === index ? { ...s, startSec: round3(clamped), source: "user" } : s));
}

/** Splits the part that contains `atSec` there; the new part gets `kind`. */
export function splitAt(sections: SectionRecord[], atSec: number, kind: SectionKind, durationSec: number): SectionRecord[] {
  const t = round3(atSec);
  if (t <= 0 || t >= durationSec) return sections;
  const timed = withEnds(sections, durationSec);
  if (timed.length === 0) {
    return renumber([
      { startSec: 0, kind: "intro", label: kindLabel("intro"), source: "user" },
      { startSec: t, kind, label: kindLabel(kind), source: "user" },
    ]);
  }
  if (timed.some((s) => Math.abs(s.startSec - t) < MIN_PART_SEC || Math.abs(s.endSec - t) < MIN_PART_SEC)) return sections;
  const plain = timed.map(({ endSec: _e, ...s }) => s);
  return renumber([...plain, { startSec: t, kind, label: kindLabel(kind), source: "user" }]);
}

/** Removes part `index`: the previous part grows to cover it (the first one is merged into the next). */
export function removePart(sections: SectionRecord[], index: number): SectionRecord[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  if (index < 0 || index >= sorted.length || sorted.length <= 1) return sorted;
  if (index === 0) {
    // The next part now starts at 0.
    const rest = sorted.slice(1);
    rest[0] = { ...rest[0]!, startSec: 0, source: "user" };
    return renumber(rest);
  }
  return renumber(sorted.filter((_, i) => i !== index));
}

/** Changes what a part is (and its default name). */
export function setKind(sections: SectionRecord[], index: number, kind: SectionKind): SectionRecord[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  return renumber(sorted.map((s, i) => (i === index ? { ...s, kind, label: kindLabel(kind), source: "user" } : s)));
}

export function rename(sections: SectionRecord[], index: number, label: string): SectionRecord[] {
  const name = label.trim().slice(0, 60);
  if (!name) return sections;
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  return sorted.map((s, i) => (i === index ? { ...s, label: name, source: "user" } : s));
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Undo / redo stack of immutable states. */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export function historyOf<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function pushHistory<T>(h: History<T>, next: T, limit = 100): History<T> {
  if (JSON.stringify(next) === JSON.stringify(h.present)) return h;
  return { past: [...h.past, h.present].slice(-limit), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) };
}

// ---- Setlists ----------------------------------------------------------------------

/** "1 h 05 min" / "23 min" / "45 s". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** "dom 23 nov 2026" from "2026-11-23" ("" stays ""). */
export function formatEventDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("es", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// ---- Keyboard shortcuts ---------------------------------------------------------------

export type ShortcutAction = "playPause" | "stop" | "prevPart" | "nextPart" | "loopPart" | "cancelJump" | "nextSong" | "prevSong" | "markPart";

export const SHORTCUT_ACTIONS: { action: ShortcutAction; label: string; where: string }[] = [
  { action: "playPause", label: "Reproducir / pausar", where: "Live y Song Editor" },
  { action: "stop", label: "Detener (pide confirmación en Live)", where: "Live" },
  { action: "prevPart", label: "Saltar a la parte anterior", where: "Live" },
  { action: "nextPart", label: "Saltar a la parte siguiente", where: "Live" },
  { action: "loopPart", label: "Repetir la parte actual (bucle)", where: "Live y Song Editor" },
  { action: "cancelJump", label: "Cancelar el salto o el bucle", where: "Live" },
  { action: "prevSong", label: "Seleccionar la canción anterior del setlist", where: "Live" },
  { action: "nextSong", label: "Seleccionar la canción siguiente del setlist", where: "Live" },
  { action: "markPart", label: "Marcar el inicio de una parte aquí", where: "Song Editor" },
];

export type Shortcuts = Record<ShortcutAction, string>;

export const DEFAULT_SHORTCUTS: Shortcuts = {
  playPause: "Space",
  stop: "Shift+Space",
  prevPart: "ArrowLeft",
  nextPart: "ArrowRight",
  loopPart: "L",
  cancelJump: "Escape",
  prevSong: "ArrowUp",
  nextSong: "ArrowDown",
  markPart: "M",
};

/** Normalised name of a key press: "Ctrl+Shift+K", "Space", "ArrowLeft"... */
export function keyName(e: { key: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }): string {
  let key = e.key;
  if (key === " " || e.code === "Space") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return "";
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
}

/** Readable label: "Espacio", "←", "Mayús+Espacio". */
export function keyLabel(name: string): string {
  const map: Record<string, string> = {
    Space: "Espacio",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Escape: "Esc",
    Enter: "Intro",
    Shift: "Mayús",
  };
  return name
    .split("+")
    .map((p) => map[p] ?? p)
    .join(" + ")
    .replace("Shift", "Mayús");
}

/** Which action a key press triggers (null = none). */
export function actionFor(shortcuts: Shortcuts, name: string): ShortcutAction | null {
  if (!name) return null;
  const hit = (Object.keys(shortcuts) as ShortcutAction[]).find((a) => shortcuts[a] === name);
  return hit ?? null;
}

/** Merges saved shortcuts with the defaults (new actions get their default key). */
export function withDefaults(saved: Partial<Shortcuts> | null | undefined): Shortcuts {
  return { ...DEFAULT_SHORTCUTS, ...(saved ?? {}) };
}

/** Keys typed into text fields must not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "textarea" || tag === "select" || (tag === "input" && !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type)) || el.isContentEditable;
}
