import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Magnet, Pause, PencilRuler, Play, Plus, Redo2, Repeat, Square, Tags, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { LibrarySong, SectionKind, SectionRecord, SongDetails, TimeSignature } from "@/lib/ipc/types";
import {
  beatsPerBar,
  formatBpm,
  formatTime,
  parseTime,
  renumber,
  SECTION_COLORS,
  SECTION_KINDS,
  snapToBar,
  TIME_SIGNATURES,
  withEnds,
} from "@/features/studio/model";
import { useStudio } from "@/features/studio/useStudio";
import { TracksPanel } from "@/features/studio/OutputPanel";
import { historyOf, keyLabel, moveBoundary, pushHistory, redo, removePart, rename, setKind, splitAt, undo, type History } from "@/features/live/model";
import { livePosition, useShortcutKeys, useShortcutSettings, useSongView } from "@/features/live/songView";

const PEAKS_PER_SECOND = 100;
const WAVE_H = 150;
const KEYS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];
const KEY_OPTIONS = [...KEYS, ...KEYS.map((k) => `${k}m`)];
/** How much the ‹ › buttons move a start or an end. */
const STEPS = [
  { id: "beat", label: "1 tiempo" },
  { id: "0.1", label: "0,1 s" },
  { id: "0.01", label: "0,01 s" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

/** A start or end time the user can type exactly (m:ss.ss), with ‹ › fine nudges. */
function TimeEdit({ label, value, disabled, onSet, onNudge }: { label: string; value: number; disabled?: boolean; onSet: (t: number) => void; onNudge: (dir: -1 | 1) => void }) {
  const commit = (el: HTMLInputElement) => {
    const t = parseTime(el.value);
    if (t === null || Math.abs(t - value) < 0.0005) el.value = formatTime(value, 2);
    else onSet(t);
  };
  return (
    <div className="grid gap-1 text-xs text-ink-300">
      {label}
      <div className="flex items-center gap-1">
        <button type="button" disabled={disabled} onClick={() => onNudge(-1)} aria-label={`${label}: antes`} className="rounded-md bg-ink-800 p-1.5 text-ink-100 hover:bg-ink-700 disabled:opacity-30">
          <ChevronLeft size={14} />
        </button>
        <input
          key={value}
          aria-label={label}
          defaultValue={formatTime(value, 2)}
          disabled={disabled}
          inputMode="decimal"
          onBlur={(e) => commit(e.target)}
          onKeyDown={(e) => {
            e.stopPropagation();
            const el = e.target as HTMLInputElement;
            if (e.key === "Enter") el.blur();
            if (e.key === "Escape") {
              el.value = formatTime(value, 2);
              el.blur();
            }
          }}
          className="w-24 rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-center font-mono text-sm text-ink-100 disabled:opacity-50"
          title="Escribe el tiempo exacto, por ejemplo 1:23.45"
        />
        <button type="button" disabled={disabled} onClick={() => onNudge(1)} aria-label={`${label}: después`} className="rounded-md bg-ink-800 p-1.5 text-ink-100 hover:bg-ink-700 disabled:opacity-30">
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

interface EditState {
  sections: SectionRecord[];
  details: SongDetails;
}

/** Mix waveform of the whole song (white over dark), at the current zoom. */
function Waveform({ peaks, width, durationSec }: { peaks: Uint8Array | undefined; width: number; durationSec: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    // Canvases have a maximum size: very long zooms draw at reduced density.
    const w = Math.min(width, 32000);
    c.width = Math.round(w * dpr);
    c.height = Math.round(WAVE_H * dpr);
    c.style.width = `${width}px`;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, WAVE_H);
    if (!peaks || peaks.length === 0 || durationSec <= 0) return;
    const total = durationSec * PEAKS_PER_SECOND;
    const per = total / w;
    const mid = WAVE_H / 2;
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    for (let px = 0; px < w; px++) {
      const a = Math.floor(px * per), b = Math.max(a + 1, Math.floor((px + 1) * per));
      let v = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i]! > v) v = peaks[i]!;
      const bar = Math.max(0.5, (v / 255) * (mid - 4));
      ctx.fillRect(px, mid - bar, 1, bar * 2);
    }
  }, [peaks, width, durationSec]);
  return <canvas ref={ref} className="pointer-events-none absolute left-0 top-0" style={{ height: WAVE_H }} />;
}

export function SongEditorPage() {
  const native = isNativeAvailable();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const studio = useStudio();
  const view = useSongView(studio);
  const { shortcuts } = useShortcutSettings();
  const { song, transport } = studio;
  const [library, setLibrary] = useState<LibrarySong[]>([]);
  const [hist, setHist] = useState<History<EditState> | null>(null);
  const [selected, setSelected] = useState(0);
  const [newKind, setNewKind] = useState<SectionKind>("verse");
  // Free placement by default: a part can start anywhere (to the hundredth of a second).
  const [snap, setSnap] = useState(false);
  const [step, setStep] = useState<StepId>("0.1");
  const [zoom, setZoom] = useState(1);
  const [saved, setSaved] = useState<"saved" | "saving" | "dirty">("saved");
  const [error, setError] = useState<string | null>(null);
  const [drag, setDragState] = useState<{ index: number; startSec: number } | null>(null);
  // The handlers read the ref: several pointer events can arrive before React re-renders.
  const dragRef = useRef<{ index: number; startSec: number } | null>(null);
  const setDrag = (d: { index: number; startSec: number } | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const lastSaved = useRef<string>("");
  const saveTimer = useRef<number | undefined>(undefined);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    if (native) backend.librarySongs().then(setLibrary, fail);
  }, [native]);

  // Which song: ?song=ID, else the one already open in the engine.
  const wanted = Number(params.get("song")) || null;
  // Decide only once the engine status is known: reloading the song that is
  // already open would reset its position (and race with the first edits).
  const statusKnown = studio.status !== null;
  useEffect(() => {
    if (!native || wanted === null || !statusKnown) return;
    if (studio.status?.songId !== wanted) void studio.openSong(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, wanted, statusKnown]);

  // Start editing once the song record is here (and again for another song).
  const editingId = useRef<number | null>(null);
  useEffect(() => {
    if (!song || !view.loaded || editingId.current === song.id) return;
    // Wait for the automatic detection the first time, so it is not overwritten with nothing.
    const analysis = studio.status?.engine.analysis?.state;
    if (!song.sectionsInitialized && analysis !== "error") return;
    editingId.current = song.id;
    const state: EditState = {
      sections: renumber(song.sections),
      details: { title: song.title, artist: song.artist, songKey: song.songKey, notes: song.notes, timeSignature: song.timeSignature },
    };
    lastSaved.current = JSON.stringify(state);
    setHist(historyOf(state));
    setSelected(0);
    setSaved("saved");
  }, [song, view.loaded, studio.status?.engine.analysis?.state]);

  const present = hist?.present ?? null;
  const duration = view.durationSec;
  const sections = useMemo(() => withEnds(present?.sections ?? [], duration), [present?.sections, duration]);
  const beats = present ? beatsPerBar(present.details.timeSignature) : view.beats;
  const bpm = view.bpm;
  const downbeat = view.downbeat;

  // Autosave 0.6 s after the last change (undo stays available).
  useEffect(() => {
    if (!present || !song) return;
    const json = JSON.stringify(present);
    if (json === lastSaved.current) return;
    setSaved("dirty");
    window.clearTimeout(saveTimer.current);
    const id = song.id;
    saveTimer.current = window.setTimeout(async () => {
      setSaved("saving");
      try {
        await backend.studioSaveSections(id, renumber(present.sections));
        await backend.setSongDetails(id, present.details);
        lastSaved.current = json;
        setSaved("saved");
      } catch (e) {
        setSaved("dirty");
        fail(e);
      }
    }, 600);
  }, [present, song]);

  const commit = useCallback((f: (s: EditState) => EditState) => setHist((h) => (h ? pushHistory(h, f(h.present)) : h)), []);
  const setSections = (next: SectionRecord[]) => commit((s) => ({ ...s, sections: next }));
  const setDetails = (patch: Partial<SongDetails>) => commit((s) => ({ ...s, details: { ...s.details, ...patch } }));

  // ---- Geometry ----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, [hist !== null]);
  const contentW = Math.max(200, viewW * zoom);
  const pxPerSec = duration > 0 ? contentW / duration : 1;
  const xOf = (t: number) => t * pxPerSec;
  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.max(0, Math.min(duration, x / pxPerSec));
  };
  const snapped = (t: number) => (snap ? snapToBar(t, bpm, downbeat, beats) : t);

  // Playhead (smooth) + follow while playing.
  const tRef = useRef(transport);
  const atRef = useRef(studio.transportAt);
  tRef.current = transport;
  atRef.current = studio.transportAt;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pos = livePosition(tRef.current, atRef.current);
      const x = pos * pxPerSec;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const el = scrollRef.current;
      if (el && tRef.current?.playState === "playing" && (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40)) el.scrollLeft = Math.max(0, x - 80);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pxPerSec]);

  // Bar ruler: a label every N bars so labels never overlap.
  const ruler = useMemo(() => {
    if (!bpm || duration <= 0) return [] as { t: number; bar: number; label: boolean }[];
    const bar = (beats * 60) / bpm;
    const every = [1, 2, 4, 8, 16, 32].find((n) => n * bar * pxPerSec >= 44) ?? 64;
    const out = [];
    for (let n = 0, t = downbeat; t < duration; n++, t = downbeat + n * bar) out.push({ t, bar: n + 1, label: n % every === 0 });
    return out;
  }, [bpm, beats, downbeat, duration, pxPerSec]);

  // ---- Actions ----
  const position = transport?.positionSec ?? 0;
  const playing = transport?.playState === "playing";
  const sel = sections[selected];
  const loop = transport?.loopRange ?? null;
  const loopingSel = !!loop && !!sel && Math.abs(loop[0] - sel.startSec) < 0.01 && Math.abs(loop[1] - sel.endSec) < 0.01;

  const markHere = () => {
    if (!present) return;
    const at = snapped(livePosition(transport, studio.transportAt));
    const next = splitAt(present.sections, at, newKind, duration);
    if (next === present.sections) return;
    setSections(next);
    const idx = withEnds(next, duration).findIndex((s) => Math.abs(s.startSec - Math.round(at * 1000) / 1000) < 0.001);
    if (idx >= 0) setSelected(idx);
  };
  const toggleLoop = async () => {
    if (!sel) return;
    try {
      if (loopingSel) await backend.setLoop(0, 0);
      else {
        await backend.setLoop(sel.startSec, sel.endSec);
        if (!playing) studio.playFrom(sel.startSec);
      }
    } catch (e) {
      fail(e);
    }
  };
  // A cut is shared: the end of a part is the start of the next one.
  // Both work on the latest state (not the rendered one): fast clicks all count.
  const setCut = (index: number, t: number) => {
    if (index <= 0) return;
    commit((s) => (index < s.sections.length ? { ...s, sections: moveBoundary(s.sections, index, t, duration) } : s));
  };
  const stepSec = step === "beat" ? (bpm ? 60 / bpm : 0.1) : Number(step);
  const nudgeCut = (index: number, dir: -1 | 1) => {
    if (index <= 0) return;
    commit((s) => {
      const cur = withEnds(s.sections, duration)[index];
      return cur ? { ...s, sections: moveBoundary(s.sections, index, cur.startSec + dir * stepSec, duration) } : s;
    });
  };
  const deleteSelected = () => {
    if (!present || sections.length <= 1) return;
    setSections(removePart(present.sections, selected));
    setSelected(Math.max(0, selected - 1));
  };

  useShortcutKeys(
    shortcuts,
    {
      playPause: () => view.loaded && studio.togglePlay(),
      markPart: markHere,
      loopPart: () => void toggleLoop(),
    },
    (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        setHist((h) => (h ? undo(h) : h));
        return true;
      }
      if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        setHist((h) => (h ? redo(h) : h));
        return true;
      }
      if (e.key === "Delete" && !e.ctrlKey) {
        deleteSelected();
        return true;
      }
      return false;
    },
  );

  // Dragging the start of a part.
  const handle = (index: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // synthetic pointers (tests)
      }
      setSelected(index);
      setDrag({ index, startSec: sections[index]!.startSec });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.index !== index || !present) return;
      const t = snapped(timeAt(e.clientX));
      const moved = moveBoundary(present.sections, index, t, duration);
      setDrag({ index, startSec: moved[index]!.startSec });
    },
    onPointerUp: () => {
      const drag = dragRef.current;
      if (drag && present && Math.abs(drag.startSec - sections[drag.index]!.startSec) > 1e-6) setSections(moveBoundary(present.sections, drag.index, drag.startSec, duration));
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  });
  const shown = drag ? sections.map((s, i) => (i === drag.index ? { ...s, startSec: drag.startSec } : s)).map((s, i, arr) => ({ ...s, endSec: i + 1 < arr.length ? arr[i + 1]!.startSec : duration })) : sections;

  const field = "w-full rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-800 bg-ink-950 px-5 py-3">
        <PencilRuler className="text-info-400" size={22} />
        <h1 className="text-lg font-bold">Song Editor</h1>
        <select
          aria-label="Canción a editar"
          value={song?.id ?? ""}
          onChange={(e) => navigate(`/song-editor?song=${e.target.value}`)}
          disabled={!native || library.length === 0}
          className="min-w-[220px] rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100"
        >
          <option value="" disabled>
            Elige una canción…
          </option>
          {library.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button type="button" aria-label="Deshacer" title="Deshacer (Ctrl+Z)" disabled={!hist?.past.length} onClick={() => setHist((h) => (h ? undo(h) : h))} className="rounded-md p-1.5 text-ink-200 hover:bg-ink-800 disabled:opacity-30">
          <Undo2 size={17} />
        </button>
        <button type="button" aria-label="Rehacer" title="Rehacer (Ctrl+Y)" disabled={!hist?.future.length} onClick={() => setHist((h) => (h ? redo(h) : h))} className="rounded-md p-1.5 text-ink-200 hover:bg-ink-800 disabled:opacity-30">
          <Redo2 size={17} />
        </button>
        <span className="text-xs text-ink-400" data-editor-saved={saved}>
          {hist ? (saved === "saved" ? "Guardado ✓" : saved === "saving" ? "Guardando…" : "Cambios sin guardar") : ""}
        </span>
        {error && (
          <span role="alert" className="text-xs text-stop-500">
            {error}
          </span>
        )}
      </div>

      {!native ? (
        <p className="m-6 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: el editor no está disponible.
        </p>
      ) : !hist || !present ? (
        <p className="m-auto text-sm text-ink-400">{studio.status?.engine.state === "loading" ? "Cargando la canción…" : "Elige una canción para editar sus partes."}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Transport + tools */}
          <div className="flex flex-wrap items-center gap-2 px-5 py-3">
            <button type="button" aria-label={playing ? "Pausar" : "Reproducir"} onClick={() => studio.togglePlay()} className={`rounded-lg px-4 py-2 text-white ${playing ? "bg-info-500" : "bg-go-500"}`}>
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button type="button" aria-label="Detener" onClick={() => studio.stop()} className="rounded-lg bg-ink-800 px-3 py-2 text-ink-100">
              <Square size={18} />
            </button>
            <span className="w-20 font-mono text-sm text-ink-200">{formatTime(position, 1)}</span>
            <div className="mx-2 h-6 w-px bg-ink-800" />
            <label className="flex items-center gap-1 text-xs text-ink-300">
              Nueva parte
              <select aria-label="Tipo de la nueva parte" value={newKind} onChange={(e) => setNewKind(e.target.value as SectionKind)} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs">
                {SECTION_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={markHere} className="flex items-center gap-1 rounded-lg bg-info-500 px-3 py-2 text-sm font-semibold text-white hover:bg-info-400" title="Marca el inicio de una parte donde está el cursor (también mientras suena)">
              <Plus size={15} /> Marcar aquí ({keyLabel(shortcuts.markPart)})
            </button>
            <button type="button" aria-pressed={snap} onClick={() => setSnap((s) => !s)} className={`flex items-center gap-1 rounded-lg px-3 py-2 text-xs ${snap ? "bg-go-500/15 text-go-400" : "bg-ink-800 text-ink-300"}`} title="Activado: los cortes caen en el inicio de un compás. Desactivado: puedes ponerlos donde quieras">
              <Magnet size={14} /> {snap ? "Ajuste al compás" : "Sin ajuste"}
            </button>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" aria-label="Alejar" onClick={() => setZoom((z) => Math.max(1, z / 2))} disabled={zoom <= 1} className="rounded-md p-1.5 text-ink-200 hover:bg-ink-800 disabled:opacity-30">
                <ZoomOut size={17} />
              </button>
              <span className="w-10 text-center font-mono text-xs text-ink-300">{zoom}×</span>
              <button type="button" aria-label="Acercar" onClick={() => setZoom((z) => Math.min(32, z * 2))} disabled={zoom >= 32} className="rounded-md p-1.5 text-ink-200 hover:bg-ink-800 disabled:opacity-30">
                <ZoomIn size={17} />
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div ref={scrollRef} className="relative mx-5 shrink-0 overflow-x-auto rounded-xl border border-ink-800 bg-ink-950" data-editor-timeline>
            <div className="relative" style={{ width: contentW, height: 26 + 38 + WAVE_H }}>
              {/* Ruler */}
              <div className="absolute inset-x-0 top-0 h-[26px] border-b border-ink-800">
                {ruler.map((r) => (
                  <div key={r.bar} className="absolute top-0 h-full" style={{ left: xOf(r.t) }}>
                    <div className={`h-full w-px ${r.label ? "bg-ink-600" : "bg-ink-800"}`} />
                    {r.label && <span className="absolute left-1 top-1 font-mono text-[10px] text-ink-400">{r.bar}</span>}
                  </div>
                ))}
              </div>
              {/* Parts lane */}
              <div className="absolute inset-x-0 top-[26px] h-[38px]">
                {shown.map((s, i) => (
                  <div
                    key={`${i}-${s.kind}`}
                    data-editor-part={s.label}
                    onClick={() => setSelected(i)}
                    onDoubleClick={() => studio.playFrom(s.startSec)}
                    className={`absolute top-1 flex h-[30px] cursor-pointer items-center overflow-hidden rounded px-2 text-xs font-bold text-white ${i === selected ? "ring-2 ring-white" : ""}`}
                    style={{ left: xOf(s.startSec), width: Math.max(4, xOf(s.endSec) - xOf(s.startSec) - 2), background: SECTION_COLORS[s.kind] }}
                    title={`${s.label} · ${formatTime(s.startSec, 1)}–${formatTime(s.endSec, 1)} (doble clic: escuchar)`}
                  >
                    <span className="truncate">{s.label}</span>
                  </div>
                ))}
              </div>
              {/* Waveform + boundaries (click = move the cursor there) */}
              <div
                className="absolute inset-x-0 cursor-text"
                style={{ top: 64, height: WAVE_H }}
                onClick={(e) => studio.seek(timeAt(e.clientX))}
                aria-label="Forma de onda: clic para mover el cursor"
              >
                <Waveform peaks={studio.peaks?.mix} width={contentW} durationSec={duration} />
                {loop && <div className="pointer-events-none absolute top-0 h-full bg-live-500/15" style={{ left: xOf(loop[0]), width: xOf(loop[1]) - xOf(loop[0]) }} />}
              </div>
              {shown.map((s, i) =>
                i === 0 ? null : (
                  <div
                    key={`h${i}`}
                    {...handle(i)}
                    role="slider"
                    aria-label={`Inicio de ${s.label}`}
                    aria-valuenow={Math.round(s.startSec * 100) / 100}
                    className="group absolute top-[26px] z-10 w-3 -translate-x-1/2 cursor-ew-resize touch-none"
                    style={{ left: xOf(s.startSec), height: 38 + WAVE_H }}
                    title={`Arrastra para mover el corte: fin de ${shown[i - 1]!.label} / inicio de ${s.label}`}
                  >
                    <div className={`mx-auto h-full w-0.5 ${drag?.index === i ? "bg-white" : "bg-white/60 group-hover:bg-white"}`} />
                  </div>
                ),
              )}
              <div ref={playheadRef} className="pointer-events-none absolute top-0 z-20 h-full w-0.5 bg-stop-500" />
            </div>
          </div>
          <p className="mx-5 mt-1 text-[11px] text-ink-400">
            Clic en la onda: mover el cursor · arrastra las líneas blancas para mover un corte · doble clic en una parte: escucharla · {keyLabel(shortcuts.markPart)} marca una parte mientras suena · Supr borra la parte seleccionada · Ctrl+Z deshace
          </p>

          <div className="grid gap-4 px-5 py-4 lg:grid-cols-2">
            {/* Selected part */}
            <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-200">Parte seleccionada</h2>
              {sel ? (
                <div className="grid gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="grid gap-1 text-xs text-ink-300">
                      Tipo
                      <select aria-label="Tipo de la parte" value={sel.kind} onChange={(e) => setSections(setKind(present.sections, selected, e.target.value as SectionKind))} className={field}>
                        {SECTION_KINDS.map((k) => (
                          <option key={k.kind} value={k.kind}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs text-ink-300">
                      Nombre
                      <input
                        key={`${selected}-${sel.label}`}
                        aria-label="Nombre de la parte"
                        defaultValue={sel.label}
                        maxLength={60}
                        onBlur={(e) => e.target.value.trim() !== sel.label && setSections(rename(present.sections, selected, e.target.value))}
                        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        className={field}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-end gap-4">
                    <TimeEdit label="Empieza en" value={sel.startSec} disabled={selected === 0} onSet={(t) => setCut(selected, t)} onNudge={(d) => nudgeCut(selected, d)} />
                    <TimeEdit label="Termina en" value={sel.endSec} disabled={selected >= sections.length - 1} onSet={(t) => setCut(selected + 1, t)} onNudge={(d) => nudgeCut(selected + 1, d)} />
                    <div className="grid gap-1 text-xs text-ink-300">
                      Mover de a
                      <select aria-label="Cuánto mueven las flechas" value={step} onChange={(e) => setStep(e.target.value as StepId)} className="rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100">
                        {STEPS.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <span className="pb-2 text-xs text-ink-400">
                      dura <b className="font-mono text-ink-200">{formatTime(sel.endSec - sel.startSec, 2)}</b>
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-400">
                    Escribe el tiempo exacto (por ejemplo <span className="font-mono">1:23.45</span>) o usa las flechas. El final de una parte es el inicio de la siguiente: al mover uno se mueve el otro.
                    {selected === 0 && " La primera parte siempre empieza en 0:00."}
                    {selected === sections.length - 1 && " La última parte termina al final de la canción."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => studio.playFrom(sel.startSec)} className="flex items-center gap-1 rounded-lg bg-go-500/15 px-3 py-1.5 text-sm text-go-400 hover:bg-go-500/25">
                      <Play size={14} /> Escuchar desde aquí
                    </button>
                    <button type="button" aria-pressed={loopingSel} onClick={() => void toggleLoop()} className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm ${loopingSel ? "bg-live-500 text-black" : "bg-ink-800 text-ink-100"}`}>
                      <Repeat size={14} /> {loopingSel ? "Repitiendo" : `Repetir en bucle (${keyLabel(shortcuts.loopPart)})`}
                    </button>
                    <button type="button" onClick={deleteSelected} disabled={sections.length <= 1} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-ink-300 hover:bg-stop-500/15 hover:text-stop-500 disabled:opacity-30">
                      <Trash2 size={14} /> Borrar (se une a la anterior)
                    </button>
                  </div>
                  <ol className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-ink-800 text-sm" aria-label="Lista de partes">
                    {sections.map((s, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => setSelected(i)} className={`flex w-full items-center gap-3 px-3 py-1 text-left ${i === selected ? "bg-info-500/15" : "hover:bg-ink-850"}`}>
                          <span className="h-3 w-3 rounded-sm" style={{ background: SECTION_COLORS[s.kind] }} />
                          <span className="flex-1">{s.label}</span>
                          <span className="font-mono text-xs text-ink-400">{formatTime(s.startSec, 1)}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="text-sm text-ink-400">Esta canción no tiene partes: reprodúcela y pulsa «Marcar aquí» en cada cambio.</p>
              )}
            </section>

            {/* Song details */}
            <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-ink-200">Datos de la canción</h2>
              <div className="grid gap-3">
                <label className="grid gap-1 text-xs text-ink-300">
                  Título
                  <input key={`t-${present.details.title}`} aria-label="Título" defaultValue={present.details.title} maxLength={200} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== present.details.title && setDetails({ title: e.target.value.trim() })} className={field} />
                </label>
                <label className="grid gap-1 text-xs text-ink-300">
                  Artista
                  <input key={`a-${present.details.artist}`} aria-label="Artista" defaultValue={present.details.artist} maxLength={200} onBlur={(e) => e.target.value !== present.details.artist && setDetails({ artist: e.target.value })} className={field} />
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <label className="grid gap-1 text-xs text-ink-300">
                    Tonalidad
                    <select aria-label="Tonalidad" value={present.details.songKey} onChange={(e) => setDetails({ songKey: e.target.value })} className={field}>
                      <option value="">—</option>
                      {KEY_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs text-ink-300">
                    Compás
                    <select aria-label="Compás" value={present.details.timeSignature} onChange={(e) => setDetails({ timeSignature: e.target.value as TimeSignature })} className={field}>
                      {TIME_SIGNATURES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="grid gap-1 text-xs text-ink-300">
                    BPM
                    <span className="rounded-md border border-ink-800 px-2 py-1.5 text-sm text-ink-100" title="El tempo se cambia en Multitrack Studio › Tempo">
                      {bpm ? formatBpm(bpm) : "—"}
                    </span>
                  </div>
                </div>
                <label className="grid gap-1 text-xs text-ink-300">
                  Notas
                  <textarea key={`n-${present.details.notes}`} aria-label="Notas de la canción" defaultValue={present.details.notes} maxLength={4000} onBlur={(e) => e.target.value !== present.details.notes && setDetails({ notes: e.target.value })} className={`${field} h-24 resize-none`} placeholder="Indicaciones para la banda (se ven en Live Mode)" />
                </label>
              </div>
            </section>
          </div>

          {/* Tracks: fix a wrong name or what each audio is */}
          {song && (
            <section className="mx-5 mb-5 rounded-xl border border-ink-800 bg-ink-900/60 p-4" data-editor-tracks>
              <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-ink-200">
                <Tags size={16} className="text-info-400" /> Pistas
              </h2>
              <p className="mb-3 text-xs text-ink-400">
                Corrige el nombre de cada audio y elige qué instrumento es. Se guarda solo. Lo que elijas decide por dónde sale: el click y los cues van a los in-ears; lo demás, a la banda.
              </p>
              <TracksPanel song={song} onUpdate={studio.updateTrack} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
