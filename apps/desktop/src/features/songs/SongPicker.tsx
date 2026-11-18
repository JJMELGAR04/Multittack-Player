import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { backend } from "@/lib/ipc/client";
import type { LibrarySong } from "@/lib/ipc/types";
import { filterSongs } from "./SongsPage";

interface Props {
  disabled?: boolean;
  /** Title of the song that is open (shown as placeholder). */
  current?: string | null;
  onPick: (songId: number) => void;
}

/** Search box over the library: type part of the title or artist, pick a song. */
export function SongPicker({ disabled, current, onPick }: Props) {
  const [songs, setSongs] = useState<LibrarySong[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const load = () => {
    backend.librarySongs().then(setSongs, () => {});
  };
  // Fresh list every time the results open (by focus or by typing): the
  // focus event alone is not delivered while the window is in the background.
  useEffect(() => {
    if (open) load();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const shown = useMemo(() => filterSongs(songs, query).slice(0, 30), [songs, query]);
  const pick = (s: LibrarySong | undefined) => {
    if (!s) return;
    setOpen(false);
    setQuery("");
    onPick(s.id);
  };

  return (
    <div ref={box} className="relative">
      <label className="flex h-9 w-48 items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-2.5 focus-within:border-info-500">
        <Search size={15} className="shrink-0 text-ink-400" />
        <input
          aria-label="Buscar canción para abrir"
          disabled={disabled}
          value={query}
          placeholder={current ? `${current} · buscar otra…` : "Buscar canción…"}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown") setActive((a) => Math.min(shown.length - 1, a + 1));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
            else if (e.key === "Enter") pick(shown[active]);
            else if (e.key === "Escape") setOpen(false);
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-ink-100 outline-none placeholder:text-ink-400 disabled:opacity-50"
        />
      </label>
      {open && (
        <ul className="absolute left-0 top-10 z-50 max-h-80 w-80 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 py-1 shadow-xl" role="listbox" aria-label="Canciones">
          {shown.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                data-pick-song={s.title}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s)}
                className={`flex w-full flex-col px-3 py-1.5 text-left ${i === active ? "bg-info-500/20" : ""}`}
              >
                <span className="truncate text-sm font-semibold text-ink-100">{s.title}</span>
                <span className="truncate text-[11px] text-ink-400">{[s.artist, s.songKey, s.originalBpm ? `${Math.round(s.targetBpm ?? s.originalBpm)} BPM` : ""].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-3 py-2 text-xs text-ink-400">{songs.length === 0 ? "Tu biblioteca está vacía: importa canciones en Songs." : "Ninguna canción coincide."}</li>
          )}
        </ul>
      )}
    </div>
  );
}
