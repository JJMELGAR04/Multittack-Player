import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileArchive, Folder, Music, Pencil, PencilRuler, Play, Plus, Search, Trash2 } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { LibrarySong } from "@/lib/ipc/types";
import { formatBpm, formatTime } from "@/features/studio/model";
import { ImportDialog } from "@/features/studio/ImportDialog";
import { useStudio } from "@/features/studio/useStudio";
import { pickSongFiles, useFileDrop } from "./importFiles";

type SortKey = "title" | "recent" | "added" | "bpm" | "duration";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Título (A-Z)" },
  { key: "recent", label: "Abiertas recientemente" },
  { key: "added", label: "Agregadas recientemente" },
  { key: "bpm", label: "BPM" },
  { key: "duration", label: "Duración" },
];

/** Accent-insensitive search over title and artist ("cancion" finds "Canción"). */
function normalise(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function sortSongs(songs: LibrarySong[], key: SortKey): LibrarySong[] {
  const out = [...songs];
  const byTitle = (a: LibrarySong, b: LibrarySong) => a.title.localeCompare(b.title, "es", { sensitivity: "base" });
  switch (key) {
    case "title":
      return out.sort(byTitle);
    case "recent":
      return out.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || byTitle(a, b));
    case "added":
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byTitle(a, b));
    case "bpm":
      return out.sort((a, b) => (a.targetBpm ?? a.originalBpm ?? 1e9) - (b.targetBpm ?? b.originalBpm ?? 1e9) || byTitle(a, b));
    case "duration":
      return out.sort((a, b) => (a.durationSec ?? 1e9) - (b.durationSec ?? 1e9) || byTitle(a, b));
  }
}

export function filterSongs(songs: LibrarySong[], query: string): LibrarySong[] {
  const q = normalise(query.trim());
  return q ? songs.filter((s) => normalise(`${s.title} ${s.artist}`).includes(q)) : songs;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" });
}

function RenameField({ song, onDone }: { song: LibrarySong; onDone: (title: string | null) => void }) {
  const [text, setText] = useState(song.title);
  // Enter commits directly (it does not depend on the field having focus); blur commits too, once.
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const t = value?.trim() ?? "";
    onDone(t && t !== song.title ? t : null);
  };
  return (
    <input
      autoFocus
      aria-label={`Nuevo título de ${song.title}`}
      value={text}
      maxLength={200}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      // Read the field itself: Enter right after typing can arrive before React re-renders.
      onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
      }}
      className="w-full rounded border border-info-500 bg-ink-950 px-2 py-1 text-sm text-ink-100 outline-none"
    />
  );
}

export function SongsPage() {
  const native = isNativeAvailable();
  const navigate = useNavigate();
  const [songs, setSongs] = useState<LibrarySong[] | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!native) return;
    backend.librarySongs().then(setSongs, (e) => setError(String(e?.message ?? e)));
  }, [native]);
  useEffect(reload, [reload]);

  // ---- Import (zip / folder / files) with the review dialog ----
  const studio = useStudio();
  const [imported, setImported] = useState<{ id: number; title: string } | null>(null);
  const importing = !!studio.importDraft;
  const startImport = useCallback(
    async (paths: string[]) => {
      setImported(null);
      await studio.startImport(paths);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [studio.startImport],
  );
  const pickAndImport = async () => {
    try {
      const paths = await pickSongFiles();
      if (paths) await startImport(paths);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const hovering = useFileDrop(startImport, native && !importing);
  // The dialog closed after saving: refresh the list and offer to open it.
  const wasImporting = useRef(false);
  useEffect(() => {
    if (wasImporting.current && !importing) {
      reload();
      if (studio.song) setImported({ id: studio.song.id, title: studio.song.title });
    }
    wasImporting.current = importing;
  }, [importing, studio.song, reload]);
  // /songs?import=1 opens the picker; debug builds expose the import to the E2E test.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (!params.get("import") || !native) return;
    setParams({}, { replace: true });
    void pickAndImport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  useEffect(() => {
    const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
    if (!env.TAURI_ENV_DEBUG) return;
    (window as unknown as { __LIVEPLAYER_TEST__?: unknown }).__LIVEPLAYER_TEST__ = { startImport };
  }, [startImport]);
  const engine = studio.status?.engine;
  const previewReady = engine?.state === "ready" && !!engine.song && studio.status?.songId == null;

  const shown = useMemo(() => sortSongs(filterSongs(songs ?? [], query), sort), [songs, query, sort]);

  const rename = async (song: LibrarySong, title: string | null) => {
    setRenaming(null);
    if (!title) return;
    try {
      await backend.libraryRename(song.id, title);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (song: LibrarySong) => {
    const own = song.sourceArchive
      ? "Las pistas que se extrajeron del zip también se borrarán (el zip original no se toca)."
      : "Tus archivos de audio NO se borran: solo se quita la canción de la biblioteca.";
    if (!window.confirm(`¿Quitar «${song.title}» de la biblioteca?\n\n${own}`)) return;
    try {
      await backend.libraryDelete(song.id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <Music className="text-info-400" size={26} />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Songs</h1>
          <p className="text-sm text-ink-300">Tu biblioteca de canciones. Importa aquí (o arrastra el zip o la carpeta a esta ventana) y ábrelas en el Multitrack Studio.</p>
        </div>
        <button
          type="button"
          disabled={!native}
          onClick={() => void pickAndImport()}
          className="flex items-center gap-2 rounded-lg bg-info-500 px-4 py-2 text-sm font-semibold text-white hover:bg-info-400 disabled:opacity-40"
        >
          <Plus size={16} /> Importar canción
        </button>
      </header>

      {hovering && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-info-500/10 text-xl font-semibold text-info-400 ring-4 ring-inset ring-info-500">
          Suelta el zip, la carpeta o los archivos de la canción
        </div>
      )}
      {studio.importDraft && (
        <ImportDialog
          draft={studio.importDraft}
          peaks={previewReady && studio.peaks?.loadId === engine?.loadId ? studio.peaks.tracks : null}
          previewReady={previewReady}
          previewProgress={engine?.state === "loading" ? engine.progress : previewReady ? 1 : 0}
          soloTrack={studio.soloTrack}
          onSolo={studio.previewSolo}
          onCommit={studio.commitImport}
          onCancel={studio.cancelImport}
        />
      )}
      {imported && (
        <p role="status" className="mb-4 flex items-center gap-3 rounded-lg border border-go-500/40 bg-go-500/10 px-4 py-3 text-sm text-go-400" data-imported={imported.title}>
          «{imported.title}» está en tu biblioteca.
          <button type="button" onClick={() => navigate(`/studio?song=${imported.id}`)} className="rounded-md bg-go-500/20 px-2 py-1 text-xs font-semibold hover:bg-go-500/30">
            Escucharla en Multitrack Studio
          </button>
          <button type="button" onClick={() => setImported(null)} className="ml-auto text-xs text-ink-300 hover:text-ink-100">
            Cerrar
          </button>
        </p>
      )}
      {studio.error && (
        <p role="alert" className="mb-4 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-3 text-sm text-stop-500">
          {studio.error}
        </p>
      )}
      {!native && (
        <p className="mb-4 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: la biblioteca no está disponible.
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-3 text-sm text-stop-500">
          {error}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
          <Search size={16} className="text-ink-400" />
          <input
            aria-label="Buscar canción"
            placeholder="Buscar por título o artista…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-400"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          Ordenar por
          <select
            aria-label="Ordenar por"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-md border border-ink-700 bg-ink-900 px-2 py-2 text-sm text-ink-100"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-ink-400">{songs ? `${shown.length} de ${songs.length}` : ""}</span>
      </div>

      {songs && songs.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed border-ink-700 px-6 py-16 text-center text-ink-300">
          <Music size={36} className="mx-auto mb-3 text-ink-400" />
          <p className="font-semibold">Todavía no tienes canciones.</p>
          <p className="mt-1 text-sm text-ink-400">Usa «Importar canción» con un zip, una carpeta o las pistas.</p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Título</th>
                <th className="px-3 py-2.5 font-semibold">BPM</th>
                <th className="px-3 py-2.5 font-semibold">Compás</th>
                <th className="px-3 py-2.5 font-semibold">Duración</th>
                <th className="px-3 py-2.5 font-semibold">Pistas</th>
                <th className="px-3 py-2.5 font-semibold">Abierta</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((s, i) => (
                <tr
                  key={s.id}
                  data-library-song={s.title}
                  className={`border-t border-ink-800 ${i % 2 ? "bg-ink-900/40" : "bg-ink-950"} hover:bg-ink-850`}
                  onDoubleClick={() => renaming === null && navigate(`/studio?song=${s.id}`)}
                >
                  <td className="px-4 py-2.5">
                    {renaming === s.id ? (
                      <RenameField song={s} onDone={(t) => void rename(s, t)} />
                    ) : (
                      <div className="flex items-center gap-2">
                        {s.sourceArchive ? (
                          <FileArchive size={14} className="shrink-0 text-ink-400" aria-label="Importada de un zip" />
                        ) : (
                          <Folder size={14} className="shrink-0 text-ink-400" aria-label="Importada de archivos" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink-100">{s.title}</span>
                          {(s.artist || s.songKey) && <span className="block truncate text-[11px] text-ink-400">{[s.artist, s.songKey && `Tono ${s.songKey}`].filter(Boolean).join(" · ")}</span>}
                        </span>
                        {s.sectionCount > 0 && <span className="shrink-0 text-[10px] text-ink-400">{s.sectionCount} partes</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-ink-200">
                    {s.originalBpm ? (
                      s.targetBpm && s.targetBpm !== s.originalBpm ? (
                        <span title={`Original ${formatBpm(s.originalBpm)} BPM`}>
                          {formatBpm(s.targetBpm)} <span className="text-[10px] text-ink-400">({formatBpm(s.originalBpm)})</span>
                        </span>
                      ) : (
                        formatBpm(s.originalBpm)
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-ink-200">{s.timeSignature}</td>
                  <td className="px-3 py-2.5 font-mono text-ink-200">{s.durationSec != null ? formatTime(s.durationSec, 0) : "—"}</td>
                  <td className="px-3 py-2.5 text-ink-200">{s.trackCount}</td>
                  <td className="px-3 py-2.5 text-xs text-ink-400">{dateLabel(s.lastOpenedAt)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => navigate(`/studio?song=${s.id}`)}
                        aria-label={`Abrir ${s.title}`}
                        className="flex items-center gap-1 rounded-md bg-go-500/15 px-2.5 py-1.5 text-xs font-semibold text-go-400 hover:bg-go-500/25"
                      >
                        <Play size={12} /> Abrir
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(`/song-editor?song=${s.id}`)}
                        aria-label={`Editar partes de ${s.title}`}
                        title="Editar partes y datos (Song Editor)"
                        className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                      >
                        <PencilRuler size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenaming(s.id)}
                        aria-label={`Renombrar ${s.title}`}
                        title="Renombrar"
                        className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(s)}
                        aria-label={`Quitar ${s.title}`}
                        title="Quitar de la biblioteca"
                        className="rounded-md p-1.5 text-ink-400 hover:bg-stop-500/15 hover:text-stop-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {songs && songs.length > 0 && shown.length === 0 && (
        <p className="py-8 text-center text-sm text-ink-400">Ninguna canción coincide con «{query}».</p>
      )}
    </div>
  );
}
