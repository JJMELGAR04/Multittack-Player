import type { Bus, DetectedSection, SectionKind, SectionRecord, TimeSignature, TrackRole } from "@/lib/ipc/types";

/** "1:05.3" (m:ss.d). */
export function formatTime(sec: number, decimals = 1): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = s.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, "0");
  return `${m}:${ss}`;
}

// ---- Volume ------------------------------------------------------------------

export const MIN_DB = -60;
export const MAX_DB = 8;

export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(gain)));
}

/**
 * Reads a volume typed by the user: "-3,5", "−6.5", "+8", "0", "-inf"/"−∞"
 * (= silence). Returns null if it is not a number; clamps to the fader range.
 */
export function parseDbInput(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s*db$/, "").replace("−", "-").replace(",", ".");
  if (t === "-inf" || t === "-∞" || t === "inf" || t === "∞") return MIN_DB;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return Math.round(Math.min(MAX_DB, Math.max(MIN_DB, v)) * 10) / 10;
}

/**
 * Console-style fader curve: 0 dB sits in the middle of the travel, the upper
 * half covers 0..+8 dB and the lower half -60..0 dB, with most of it spent on
 * the useful zone (-20..0) instead of on near-silence. [position 0..1, dB]
 */
export const FADER_CURVE: readonly (readonly [number, number])[] = [
  [0, MIN_DB],
  [0.04, -45],
  [0.1, -32],
  [0.18, -20],
  [0.27, -12],
  [0.37, -6],
  [0.5, 0],
  [1, MAX_DB],
];

/** dB -> fader position (0 = bottom, 1 = top). */
export function dbToFader(db: number): number {
  if (db <= MIN_DB) return 0;
  if (db >= MAX_DB) return 1;
  for (let i = 1; i < FADER_CURVE.length; i++) {
    const [p1, d1] = FADER_CURVE[i]!;
    const [p0, d0] = FADER_CURVE[i - 1]!;
    if (db <= d1) return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
  }
  return 1;
}

/** Fader position -> dB, rounded to 0.1 dB and snapping to 0 dB near the centre. */
export function faderToDb(pos: number): number {
  if (pos <= 0) return MIN_DB;
  if (pos >= 1) return MAX_DB;
  let db = MAX_DB;
  for (let i = 1; i < FADER_CURVE.length; i++) {
    const [p1, d1] = FADER_CURVE[i]!;
    const [p0, d0] = FADER_CURVE[i - 1]!;
    if (pos <= p1) {
      db = d0 + ((pos - p0) / (p1 - p0)) * (d1 - d0);
      break;
    }
  }
  if (Math.abs(db) < 0.25) return 0; // detent at 0 dB
  return Math.round(db * 10) / 10;
}

export function formatDb(db: number): string {
  if (db <= MIN_DB) return "−∞ dB";
  const r = Math.round(db * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)} dB`;
}

// ---- Tempo -------------------------------------------------------------------

export const MIN_RATIO = 0.5;
export const MAX_RATIO = 2.0;
/** Range offered by the tempo slider (beyond it, time-stretching is audible). */
export const SLIDER_MIN_RATIO = 0.7;
export const SLIDER_MAX_RATIO = 1.3;

export type TempoQuality = "original" | "excellent" | "veryGood" | "good" | "audible";

/**
 * How transparent the time-stretch will sound. Based on the library's own
 * guidance (best between 0.75x and 1.5x) and listening: under ±10 % changes
 * are practically inaudible on band material.
 */
export function tempoQuality(ratio: number): TempoQuality {
  const change = Math.abs(ratio - 1);
  if (change < 1e-9) return "original";
  if (change <= 0.1) return "excellent";
  if (change <= 0.2) return "veryGood";
  if (change <= 0.25) return "good";
  return "audible";
}

export const TEMPO_QUALITY_LABEL: Record<TempoQuality, string> = {
  original: "Audio original, sin procesar",
  excellent: "Calidad excelente",
  veryGood: "Muy buena calidad",
  good: "Buena calidad",
  audible: "Cambio grande: pueden notarse artefactos",
};

export function clampRatio(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

/** Rounds a BPM for display/storage (0.1 precision, integers stay integers). */
export function roundBpm(bpm: number): number {
  return Math.round(bpm * 10) / 10;
}

export function formatBpm(bpm: number): string {
  const r = roundBpm(bpm);
  return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}

export function formatPercent(ratio: number): string {
  const p = Math.round((ratio - 1) * 1000) / 10;
  if (p === 0) return "0 %";
  return `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(Number.isInteger(p) ? 0 : 1)} %`;
}

/**
 * Tap tempo: BPM from tap timestamps (ms). Uses the last taps within a
 * 2-second gap; needs at least 3 taps. Returns null if not enough data.
 */
export function tapTempo(taps: number[]): number | null {
  const recent: number[] = [];
  for (let i = taps.length - 1; i >= 0; i--) {
    const t = taps[i]!;
    if (recent.length > 0 && recent[0]! - t > 2000) break;
    recent.unshift(t);
    if (recent.length >= 9) break;
  }
  if (recent.length < 3) return null;
  const intervals = recent.slice(1).map((t, i) => t - recent[i]!);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (avg <= 0) return null;
  return roundBpm(60000 / avg);
}

// ---- Tracks and outputs ------------------------------------------------------

export const TRACK_ROLES: { role: TrackRole; label: string }[] = [
  { role: "drums", label: "Batería" },
  { role: "percussion", label: "Percusión" },
  { role: "bass", label: "Bajo" },
  { role: "electric_guitar", label: "Guitarra eléctrica" },
  { role: "acoustic_guitar", label: "Guitarra acústica" },
  { role: "piano", label: "Piano" },
  { role: "keys", label: "Teclados" },
  { role: "pads", label: "Pads" },
  { role: "synth", label: "Sintetizador" },
  { role: "strings", label: "Cuerdas" },
  { role: "brass", label: "Vientos" },
  { role: "lead_vocal", label: "Voz principal" },
  { role: "backing_vocals", label: "Coros" },
  { role: "loops", label: "Loops / efectos" },
  { role: "backing_track", label: "Backtrack / pista" },
  { role: "click", label: "Click" },
  { role: "cues", label: "Cues / guía" },
  { role: "other", label: "Otro" },
];

/** Track colour by instrument family (labels, lanes, mixer strips). */
export const ROLE_COLORS: Record<TrackRole, string> = {
  drums: "#e8c21b",
  percussion: "#f59e0b",
  bass: "#e11d74",
  electric_guitar: "#dc2626",
  acoustic_guitar: "#a855f7",
  piano: "#f97316",
  keys: "#0d9488",
  pads: "#3b82f6",
  synth: "#ea580c",
  strings: "#6366f1",
  brass: "#ca8a04",
  lead_vocal: "#d946ef",
  backing_vocals: "#8b5cf6",
  loops: "#65a30d",
  backing_track: "#0891b2",
  click: "#94a3b8",
  cues: "#38bdf8",
  other: "#64748b",
};

/** Text colour that stays readable on a role colour. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0a0b0d" : "#ffffff";
}

/** Linear peak -> 0..1 on a -60..+6 dB meter scale. */
export function meterFraction(linear: number): number {
  if (linear <= 0) return 0;
  const db = 20 * Math.log10(linear);
  return Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

/** "Compás 12 · 3" position in the bar grid (1-based), or null without tempo. */
export function barBeat(sec: number, bpm: number | null, downbeatSec: number, beats: number): { bar: number; beat: number } | null {
  if (!bpm || bpm <= 0) return null;
  const beatSec = 60 / bpm;
  const totalBeats = Math.floor((sec - downbeatSec) / beatSec + 1e-6);
  const bar = Math.floor(totalBeats / beats) + 1;
  const beat = (((totalBeats % beats) + beats) % beats) + 1;
  return { bar, beat };
}

/** Returns a copy of `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item as T);
  return out;
}

/** Effective per-track gains from mixer state (solo wins over mute; dB faders). */
export function effectiveGains(volumesDb: number[], mute: boolean[], solo: boolean[]): number[] {
  const anySolo = solo.some(Boolean);
  return volumesDb.map((db, i) => {
    if (anySolo ? !solo[i] : mute[i]) return 0;
    return dbToGain(db);
  });
}

export function roleLabel(role: TrackRole): string {
  return TRACK_ROLES.find((r) => r.role === role)?.label ?? "Otro";
}

/** Click and cues are heard only by the band (monitor bus). */
export function busForRole(role: TrackRole): Bus {
  return role === "click" || role === "cues" ? "monitor" : "main";
}

export const BUS_LABEL: Record<Bus, string> = {
  main: "PA · instrumentos",
  monitor: "Solo banda · in-ears",
};

export const TIME_SIGNATURES: { value: TimeSignature; label: string }[] = [
  { value: "4/4", label: "4/4" },
  { value: "3/4", label: "3/4" },
  { value: "6/8", label: "6/8 (BPM en negra con puntillo)" },
  { value: "2/4", label: "2/4" },
  { value: "12/8", label: "12/8 (BPM en negra con puntillo)" },
  { value: "5/4", label: "5/4" },
];

/** Same rule as the backend: 6/8 and 12/8 count dotted quarters. */
export function beatsPerBar(ts: TimeSignature): number {
  switch (ts) {
    case "2/4":
    case "6/8":
      return 2;
    case "3/4":
      return 3;
    case "5/4":
      return 5;
    default:
      return 4;
  }
}

/** Default name for a track the user just identified ("Batería", "Batería 2"...). */
export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

// ---- Sections ----------------------------------------------------------------

export const SECTION_KINDS: { kind: SectionKind; label: string }[] = [
  { kind: "intro", label: "Intro" },
  { kind: "verse", label: "Estrofa" },
  { kind: "prechorus", label: "Pre-coro" },
  { kind: "chorus", label: "Coro" },
  { kind: "bridge", label: "Puente" },
  { kind: "interlude", label: "Interludio" },
  { kind: "outro", label: "Final" },
  { kind: "section", label: "Sección" },
];

export const SECTION_COLORS: Record<SectionKind, string> = {
  intro: "#64748b",
  verse: "#3b82f6",
  prechorus: "#14b8a6",
  chorus: "#f97316",
  bridge: "#a855f7",
  interlude: "#0ea5e9",
  outro: "#6b7280",
  section: "#84cc16",
};

export function kindLabel(kind: SectionKind): string {
  return SECTION_KINDS.find((k) => k.kind === kind)?.label ?? "Sección";
}

export interface TimedSection extends SectionRecord {
  endSec: number;
}

/** Sorted sections with their end time (next start or song end). */
export function withEnds(sections: SectionRecord[], durationSec: number): TimedSection[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  return sorted.map((s, i) => ({ ...s, endSec: i + 1 < sorted.length ? sorted[i + 1]!.startSec : durationSec }));
}

/** Index of the section that contains `positionSec`, or -1. */
export function sectionAt(sections: TimedSection[], positionSec: number): number {
  for (let i = sections.length - 1; i >= 0; i--) if (positionSec >= sections[i]!.startSec) return i;
  return -1;
}

export function fromDetected(detected: DetectedSection[]): SectionRecord[] {
  return detected.map((d) => ({ startSec: d.startSec, kind: d.kind, label: d.label, source: "auto" }));
}

/**
 * Renumbers labels that follow the default pattern ("Coro", "Coro 2"...) in
 * time order; custom names typed by the user are kept.
 */
export function renumber(sections: SectionRecord[]): SectionRecord[] {
  const sorted = [...sections].sort((a, b) => a.startSec - b.startSec);
  const totals = new Map<SectionKind, number>();
  for (const s of sorted) totals.set(s.kind, (totals.get(s.kind) ?? 0) + 1);
  const seen = new Map<SectionKind, number>();
  return sorted.map((s) => {
    const base = kindLabel(s.kind);
    const isDefault = s.label === base || new RegExp(`^${base} \\d+$`).test(s.label);
    const n = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, n);
    if (!isDefault) return s;
    const numbered = (totals.get(s.kind) ?? 0) > 1 && s.kind !== "intro" && s.kind !== "outro";
    return { ...s, label: numbered ? `${base} ${n}` : base };
  });
}

/** Snaps a time to the nearest bar line of the grid, if a tempo is known. */
export function snapToBar(sec: number, bpm: number | null, downbeatSec: number, beats = 4): number {
  if (!bpm || bpm <= 0) return Math.max(0, sec);
  const bar = (beats * 60) / bpm;
  const n = Math.round((sec - downbeatSec) / bar);
  return Math.max(0, downbeatSec + n * bar);
}

// ---- Key (tonalidad) and key changes -------------------------------------------

const SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const NOTE_INDEX: Record<string, number> = Object.fromEntries([...SHARPS.map((n, i) => [n, i]), ...FLATS.map((n, i) => [n, i])]);

/** Keys offered in the selectors (major, then minor). */
export const KEY_OPTIONS = [...SHARPS, "Db", "Eb", "Gb", "Ab", "Bb"].sort((a, b) => NOTE_INDEX[a]! - NOTE_INDEX[b]! || a.length - b.length);
export const ALL_KEY_OPTIONS = [...KEY_OPTIONS, ...KEY_OPTIONS.map((k) => `${k}m`)];

/** Largest key change offered (semitones). */
export const MAX_TRANSPOSE = 6;

/**
 * Name of a key moved by `semitones`: "D" +2 -> "E", "Bb" -1 -> "A", "F#m" +1 -> "Gm".
 * Flat keys stay flat (Bb, Eb...), sharp ones sharp. "" if the key is unknown.
 */
export function transposeKey(key: string, semitones: number): string {
  const m = /^([A-G](?:#|b)?)(m?)$/.exec(key.trim());
  if (!m) return "";
  const idx = NOTE_INDEX[m[1]!];
  if (idx === undefined) return "";
  const minor = m[2] === "m";
  const n = (((idx + Math.round(semitones)) % 12) + 12) % 12;
  // Flat spelling for flat keys and for the usual flat keys (F, Bb, Eb, Ab, Db / Dm, Gm, Cm, Fm).
  const flatMajor = [5, 10, 3, 8, 1, 6];
  const flatMinor = [2, 7, 0, 5, 10, 3];
  const useFlats = m[1]!.includes("b") || (minor ? flatMinor.includes(n) : flatMajor.includes(n)) && !m[1]!.includes("#");
  return (useFlats ? FLATS : SHARPS)[n]! + (minor ? "m" : "");
}

/** "+2", "−1", "0". */
export function formatSemitones(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

/** "D → E (+2)", "D", "+2" (unknown key), "" (nothing to say). */
export function keyLabelFor(key: string, semitones: number): string {
  if (!key) return semitones ? `${formatSemitones(semitones)} semitonos` : "";
  if (!semitones) return key;
  const to = transposeKey(key, semitones);
  return to ? `${key} → ${to} (${formatSemitones(semitones)})` : `${key} (${formatSemitones(semitones)})`;
}
