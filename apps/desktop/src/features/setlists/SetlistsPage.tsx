import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, Copy, GripVertical, ListMusic, Plus, Radio, Search, Trash2, X } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { LibrarySong, SetlistInput, SetlistRecord, SetlistSummary } from "@/lib/ipc/types";
import { formatBpm, formatSemitones, formatTime, MAX_TRANSPOSE, moveItem, transposeKey } from "@/features/studio/model";
import { filterSongs } from "@/features/songs/SongsPage";
import { formatDuration, formatEventDate } from "@/features/live/model";

const ROW_H = 58;

interface Row {
  key: string;
  songId: number;
  notes: string;
  /** Key for this setlist (null = the song's own). */
  transpose: number | null;
}

let rowSeq = 0;
const newKey = () => `r${++rowSeq}`;

export function SetlistsPage() {
  const native = isNativeAvailable();
  const navigate = useNavigate();
  const [lists, setLists] = useState<SetlistSummary[] | null>(null);
  const [library, setLibrary] = useState<LibrarySong[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ name: string; eventDate: string; place: string; notes: string; rows: Row[] } | null>(null);
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState<"saved" | "saving" | "dirty">("saved");
  const [error, setError] = useState<string | null>(null);
  const [drag, setDragState] = useState<{ from: number; startY: number; dy: number } | null>(null);
  // Handlers read the ref: several pointer events can arrive before React re-renders.
  const dragRef = useRef<{ from: number; startY: number; dy: number } | null>(null);
  const setDrag = (d: { from: number; startY: number; dy: number } | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const saveTimer = useRef<number | undefined>(undefined);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const reloadLists = useCallback(() => {
    if (native) backend.setlists().then(setLists, fail);
  }, [native]);

  useEffect(() => {
    if (!native) return;
    reloadLists();
    backend.librarySongs().then(setLibrary, fail);
  }, [native, reloadLists]);

  const open = useCallback(async (id: number) => {
    window.clearTimeout(saveTimer.current);
    const rec: SetlistRecord = await backend.setlist(id);
    setSelected(id);
    setDraft({
      name: rec.name,
      eventDate: rec.eventDate,
      place: rec.place,
      notes: rec.notes,
      rows: rec.items.map((i) => ({ key: newKey(), songId: i.songId, notes: i.notes, transpose: i.transpose })),
    });
    setSaved("saved");
  }, []);

  useEffect(() => {
    if (selected === null && lists && lists.length > 0) void open(lists[0]!.id);
  }, [lists, selected, open]);

  // Autosave (0.5 s after the last change).
  const update = (next: NonNullable<typeof draft>) => {
    setDraft(next);
    setSaved("dirty");
    window.clearTimeout(saveTimer.current);
    const id = selected;
    if (id === null) return;
    saveTimer.current = window.setTimeout(() => {
      setSaved("saving");
      const input: SetlistInput = {
        name: next.name.trim() || "Sin nombre",
        eventDate: next.eventDate,
        place: next.place,
        notes: next.notes,
        items: next.rows.map((r) => ({ songId: r.songId, notes: r.notes, transpose: r.transpose })),
      };
      backend.saveSetlist(id, input).then(
        () => {
          setSaved("saved");
          reloadLists();
        },
        (e) => {
          setSaved("dirty");
          fail(e);
        },
      );
    }, 500);
  };

  const create = async () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    try {
      const id = await backend.createSetlist({ name: "Nuevo setlist", eventDate: iso, place: "", notes: "", items: [] });
      reloadLists();
      await open(id);
    } catch (e) {
      fail(e);
    }
  };

  const duplicate = async () => {
    if (selected === null) return;
    const id = await backend.duplicateSetlist(selected).catch(fail);
    if (typeof id === "number") {
      reloadLists();
      await open(id);
    }
  };

  const remove = async () => {
    if (selected === null || !draft) return;
    if (!window.confirm(`¿Borrar el setlist «${draft.name}»? Las canciones siguen en tu biblioteca.`)) return;
    await backend.deleteSetlist(selected).catch(fail);
    setSelected(null);
    setDraft(null);
    reloadLists();
  };

  const songById = useMemo(() => new Map(library.map((s) => [s.id, s])), [library]);
  const results = useMemo(() => (query.trim() ? filterSongs(library, query) : library).slice(0, 50), [library, query]);
  const total = draft ? draft.rows.reduce((s, r) => s + (songById.get(r.songId)?.durationSec ?? 0), 0) : 0;
  const target = drag && draft ? Math.max(0, Math.min(draft.rows.length - 1, drag.from + Math.round(drag.dy / ROW_H))) : -1;

  const grip = (i: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // synthetic pointers (tests)
      }
      setDrag({ from: i, startY: e.clientY, dy: 0 });
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (drag && drag.from === i) setDrag({ ...drag, dy: e.clientY - drag.startY });
    },
    onPointerUp: () => {
      const drag = dragRef.current;
      if (drag && draft) {
        const to = Math.max(0, Math.min(draft.rows.length - 1, drag.from + Math.round(drag.dy / ROW_H)));
        if (to !== drag.from) update({ ...draft, rows: moveItem(draft.rows, drag.from, to) });
      }
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
  });

  const field = "rounded-md border border-ink-700 bg-ink-950 px-2 py-1.5 text-sm text-ink-100";

  return (
    <div className="flex h-full overflow-hidden">
      {/* Setlist list */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-ink-800 bg-ink-950">
        <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-3">
          <ListMusic size={20} className="text-info-400" />
          <h1 className="flex-1 text-lg font-bold">Setlists</h1>
          <button type="button" onClick={() => void create()} disabled={!native} className="flex items-center gap-1 rounded-md bg-info-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-info-400 disabled:opacity-40">
            <Plus size={14} /> Nuevo
          </button>
        </div>
        {!native && <p className="p-4 text-sm text-live-400">La interfaz se está ejecutando fuera de la aplicación de escritorio: los setlists no están disponibles.</p>}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {(lists ?? []).map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => void open(l.id)}
                data-setlist={l.name}
                className={`w-full border-b border-ink-900 px-4 py-3 text-left ${selected === l.id ? "bg-info-500/15" : "hover:bg-ink-900"}`}
              >
                <span className="block truncate font-semibold text-ink-100">{l.name}</span>
                <span className="block text-xs text-ink-400">
                  {[formatEventDate(l.eventDate), `${l.songCount} canciones`, l.totalSec ? formatDuration(l.totalSec) : ""].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {lists && lists.length === 0 && <p className="p-4 text-sm text-ink-400">Crea tu primer setlist con «Nuevo».</p>}
      </aside>

      {/* Editor */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {error && (
          <p role="alert" className="flex items-center gap-2 border-b border-stop-500/40 bg-stop-500/10 px-4 py-2 text-sm text-stop-500">
            {error}
            <button type="button" className="ml-auto" aria-label="Cerrar" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </p>
        )}
        {draft ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-6 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <input aria-label="Nombre del setlist" value={draft.name} maxLength={200} onChange={(e) => update({ ...draft, name: e.target.value })} className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-2xl font-bold text-ink-100 hover:border-ink-700 focus:border-info-500 focus:outline-none" />
                <span className="text-xs text-ink-400" data-setlist-saved={saved}>
                  {saved === "saved" ? "Guardado ✓" : saved === "saving" ? "Guardando…" : "Cambios sin guardar"}
                </span>
                <button type="button" onClick={() => { void backend.setUiSetting("live.lastSetlist", selected); navigate("/live"); }} className="flex items-center gap-1 rounded-md bg-live-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-live-400">
                  <Radio size={14} /> Tocar en Live
                </button>
                <button type="button" onClick={() => void duplicate()} title="Duplicar" aria-label="Duplicar setlist" className="rounded-md p-2 text-ink-300 hover:bg-ink-800">
                  <Copy size={16} />
                </button>
                <button type="button" onClick={() => void remove()} title="Borrar" aria-label="Borrar setlist" className="rounded-md p-2 text-ink-300 hover:bg-stop-500/15 hover:text-stop-500">
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-ink-300">
                <label className="flex items-center gap-2">
                  <CalendarDays size={14} /> Fecha
                  <input type="date" aria-label="Fecha" value={draft.eventDate} onChange={(e) => update({ ...draft, eventDate: e.target.value })} className={field} />
                </label>
                <label className="flex flex-1 items-center gap-2">
                  Lugar
                  <input aria-label="Lugar" value={draft.place} maxLength={200} onChange={(e) => update({ ...draft, place: e.target.value })} className={`${field} flex-1`} placeholder="Templo, auditorio…" />
                </label>
              </div>
              <textarea aria-label="Notas del setlist" value={draft.notes} maxLength={4000} onChange={(e) => update({ ...draft, notes: e.target.value })} placeholder="Notas para el equipo (opcional)" className={`${field} mt-3 h-16 resize-none`} />

              <div className="mt-4 flex items-center justify-between text-xs text-ink-400">
                <span>
                  {draft.rows.length} canciones · {formatDuration(total)}
                </span>
                <span>Arrastra desde ⋮⋮ para cambiar el orden</span>
              </div>
              <ol className="relative mt-2 rounded-xl border border-ink-800" style={{ minHeight: ROW_H }} aria-label="Canciones del setlist">
                {draft.rows.map((r, i) => {
                  const s = songById.get(r.songId);
                  const dragging = drag?.from === i;
                  const shift = drag && !dragging ? (drag.from < i && target >= i ? -ROW_H : drag.from > i && target <= i ? ROW_H : 0) : 0;
                  return (
                    <li
                      key={r.key}
                      data-setlist-row={s?.title ?? r.songId}
                      className={`flex items-center gap-3 border-b border-ink-900 bg-ink-950 px-3 ${dragging ? "relative z-10 shadow-[0_6px_20px_rgba(0,0,0,0.8)]" : ""}`}
                      style={{ height: ROW_H, transform: `translateY(${dragging ? drag!.dy : shift}px)`, transition: dragging ? "none" : "transform 120ms" }}
                    >
                      <button type="button" aria-label={`Arrastrar ${s?.title ?? "canción"}`} {...grip(i)} className="cursor-grab touch-none text-ink-400 hover:text-ink-100 active:cursor-grabbing">
                        <GripVertical size={18} />
                      </button>
                      <span className="w-6 text-right font-mono text-sm text-ink-400">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink-100">{s?.title ?? "(canción borrada)"}</span>
                        <span className="block text-xs text-ink-400">
                          {[s?.artist, s?.songKey, s && (s.targetBpm ?? s.originalBpm) ? `${formatBpm((s.targetBpm ?? s.originalBpm)!)} BPM` : "", s?.durationSec ? formatTime(s.durationSec, 0) : ""].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <select
                        aria-label={`Tono de ${s?.title ?? "la canción"}`}
                        value={r.transpose === null ? "song" : String(r.transpose)}
                        onChange={(e) => update({ ...draft, rows: draft.rows.map((x, j) => (j === i ? { ...x, transpose: e.target.value === "song" ? null : Number(e.target.value) } : x)) })}
                        className={`${field} w-36`}
                        title="Tono para este setlist"
                      >
                        <option value="song">Tono: {s?.songKey ? transposeKey(s.songKey, s.transpose) || s.songKey : "como la canción"}{s?.transpose ? ` (${formatSemitones(s.transpose)})` : ""}</option>
                        {Array.from({ length: 2 * MAX_TRANSPOSE + 1 }, (_, k) => k - MAX_TRANSPOSE).map((n) => (
                          <option key={n} value={n}>
                            {s?.songKey ? `${transposeKey(s.songKey, n) || s.songKey} (${formatSemitones(n)})` : `${formatSemitones(n)} semitonos`}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`Notas de ${s?.title ?? "la canción"}`}
                        value={r.notes}
                        maxLength={1000}
                        placeholder="Notas (p. ej. coro x2)"
                        onChange={(e) => update({ ...draft, rows: draft.rows.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)) })}
                        className={`${field} w-48`}
                      />
                      <button type="button" aria-label={`Quitar ${s?.title ?? "canción"} del setlist`} onClick={() => update({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })} className="rounded p-1.5 text-ink-400 hover:bg-stop-500/15 hover:text-stop-500">
                        <X size={15} />
                      </button>
                    </li>
                  );
                })}
                {draft.rows.length === 0 && <li className="px-4 py-4 text-sm text-ink-400">Agrega canciones desde la biblioteca de la derecha.</li>}
              </ol>
            </div>

            {/* Library to add from */}
            <aside className="flex w-80 shrink-0 flex-col border-l border-ink-800 bg-ink-950">
              <label className="m-3 flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
                <Search size={15} className="text-ink-400" />
                <input aria-label="Buscar en la biblioteca" placeholder="Buscar canción…" value={query} onChange={(e) => setQuery(e.target.value)} className="flex-1 bg-transparent text-sm outline-none" />
              </label>
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {results.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 border-b border-ink-900 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{s.title}</span>
                      <span className="block text-[11px] text-ink-400">{[s.artist, s.songKey, s.durationSec ? formatTime(s.durationSec, 0) : ""].filter(Boolean).join(" · ")}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Agregar ${s.title}`}
                      onClick={() => update({ ...draft, rows: [...draft.rows, { key: newKey(), songId: s.id, notes: "", transpose: null }] })}
                      className="rounded-md bg-go-500/15 p-1.5 text-go-400 hover:bg-go-500/25"
                    >
                      <Plus size={15} />
                    </button>
                  </li>
                ))}
                {library.length === 0 && <li className="p-4 text-sm text-ink-400">Tu biblioteca está vacía: importa canciones en Songs.</li>}
              </ul>
            </aside>
          </div>
        ) : (
          native && <p className="m-auto text-sm text-ink-400">Elige un setlist o crea uno nuevo.</p>
        )}
      </section>
    </div>
  );
}
