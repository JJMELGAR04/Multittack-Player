import { useEffect, useMemo, useState } from "react";
import { Activity, AudioLines, FolderOpen, ListMusic, Music, X } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import type { SectionRecord } from "@/lib/ipc/types";
import { kindLabel, sectionAt, snapToBar, withEnds } from "./model";
import { SectionsPanel } from "./SectionsPanel";
import { TempoControl } from "./TempoControl";
import { Timeline } from "./Timeline";
import { TransportBar } from "./TransportBar";
import { useStudio, type Studio } from "./useStudio";

const AUDIO_EXTENSIONS = ["wav", "wave", "mp3", "aif", "aiff", "flac", "ogg"];

async function pickFiles(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "Selecciona las pistas de la canción (o una carpeta)",
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked : [picked];
}

/** Space / Esc / Home / 1-9 shortcuts for live use. */
function useShortcuts(studio: Studio, sectionStarts: number[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || !studio.song) return;
      if (e.code === "Space") {
        e.preventDefault();
        studio.togglePlay();
      } else if (e.key === "Escape") {
        studio.stop();
      } else if (e.key === "Home") {
        studio.seek(0);
      } else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
        const start = sectionStarts[Number(e.key) - 1];
        if (start !== undefined) studio.playFrom(start);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [studio, sectionStarts]);
}

/** Files/folders dropped on the window open a song. */
function useFileDrop(onPaths: (paths: string[]) => void, enabled: boolean) {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setHovering(true);
          else if (p.type === "leave") setHovering(false);
          else if (p.type === "drop") {
            setHovering(false);
            if (p.paths.length > 0) onPaths(p.paths);
          }
        })
        .then((fn) => (cancelled ? fn() : (unlisten = fn))),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onPaths, enabled]);
  return hovering;
}

function pct(v: number) {
  return `${Math.round(v * 100)} %`;
}

export function StudioPage() {
  const studio = useStudio();
  const { song, status, transport, peaks } = studio;
  const engine = status?.engine;
  const loaded = engine?.state === "ready" && engine.song && status?.songId === song?.id ? engine.song : null;
  const analysing = engine?.analysis?.state === "running";
  const [editing, setEditing] = useState(false);

  const durationSec = loaded?.durationSec ?? 0;
  const sections = useMemo(() => withEnds(song?.sections ?? [], durationSec), [song?.sections, durationSec]);
  const sectionStarts = useMemo(() => sections.map((s) => s.startSec), [sections]);
  const current = sectionAt(sections, transport?.positionSec ?? 0);
  const bpm = song?.originalBpm ?? null;
  const barSec = bpm ? 240 / bpm : null;

  useShortcuts(studio, sectionStarts);
  const hovering = useFileDrop(studio.openFiles, studio.native);

  const open = async () => {
    try {
      const paths = await pickFiles();
      if (paths) await studio.openFiles(paths);
    } catch (e) {
      console.error(e);
    }
  };

  const moveSection = (index: number, startSec: number) => {
    const next: SectionRecord[] = sections.map((s, i) => ({
      startSec: i === index ? startSec : s.startSec,
      kind: s.kind,
      label: s.label,
      source: i === index ? "user" : s.source,
    }));
    studio.saveSections(next);
  };

  const addAtCursor = () => {
    const at = snapToBar(transport?.positionSec ?? 0, bpm, song?.downbeatOffsetSec ?? 0);
    if (sections.some((s) => Math.abs(s.startSec - at) < 0.5)) return;
    const base: SectionRecord[] = sections.map(({ startSec, kind, label, source }) => ({ startSec, kind, label, source }));
    studio.saveSections([...base, { startSec: at, kind: "section", label: kindLabel("section"), source: "user" }]);
  };

  return (
    <div className="mx-auto max-w-7xl px-8 py-6">
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <AudioLines className="text-info-400" size={26} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">Multitrack Studio</h1>
          <p className="truncate text-sm text-ink-300">
            {song ? song.title : "Abre las pistas de una canción para empezar."}
          </p>
        </div>
        {studio.recent.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <ListMusic size={16} />
            <select
              aria-label="Canciones recientes"
              value=""
              onChange={(e) => e.target.value && studio.openSong(Number(e.target.value))}
              className="max-w-56 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100"
            >
              <option value="">Recientes…</option>
              {studio.recent.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({r.trackCount} pistas)
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={open}
          disabled={!studio.native}
          className="flex items-center gap-2 rounded-lg border border-info-500 bg-info-500/15 px-4 py-2 text-sm font-semibold text-info-400 hover:bg-info-500/25 disabled:opacity-40"
        >
          <FolderOpen size={16} /> Abrir pistas
        </button>
      </header>

      {!studio.native && (
        <p className="mb-4 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: no hay motor de audio disponible.
        </p>
      )}

      {studio.error && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-3 text-sm text-stop-500">
          <span className="flex-1">{studio.error}</span>
          <button type="button" onClick={studio.clearError} aria-label="Cerrar aviso">
            <X size={16} />
          </button>
        </div>
      )}

      {hovering && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-info-500/10 text-xl font-semibold text-info-400 ring-4 ring-inset ring-info-500">
          Suelta los archivos o la carpeta de la canción
        </div>
      )}

      {engine?.state === "loading" && (
        <Panel title="Cargando canción" icon={<Music size={18} />} tone="pending" statusLabel={`${Math.round(engine.progress * 100)} %`}>
          <div className="h-2 overflow-hidden rounded bg-ink-800">
            <div className="h-full bg-info-500 transition-[width]" style={{ width: `${engine.progress * 100}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Decodificando y preparando las pistas en memoria (la reproducción no leerá del disco).
          </p>
        </Panel>
      )}

      {engine?.state === "error" && (
        <p role="alert" className="mb-4 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-3 text-sm text-stop-500">
          No se pudo cargar la canción: {engine.error}
        </p>
      )}

      {!song && engine?.state !== "loading" && (
        <button
          type="button"
          onClick={open}
          disabled={!studio.native}
          className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-ink-700 py-20 text-ink-300 hover:border-info-500 hover:text-info-400"
        >
          <FolderOpen size={40} />
          <span className="text-lg font-semibold">Arrastra aquí la carpeta de la canción o haz clic para elegir las pistas</span>
          <span className="text-sm text-ink-400">WAV, MP3, AIFF, FLAC u OGG · todas las pistas suenan sincronizadas</span>
        </button>
      )}

      {song && loaded && (
        <div className="grid gap-4">
          <section className="rounded-xl border border-ink-800 bg-ink-900 px-5 py-4">
            <TransportBar
              transport={transport}
              disabled={!loaded}
              onPlay={studio.play}
              onPause={studio.pause}
              onStop={studio.stop}
              onRestart={() => studio.seek(0)}
              onGain={studio.setGain}
            />
            <div className="mt-4 border-t border-ink-800 pt-4">
              <TempoControl
                song={song}
                detected={engine?.analysis?.tempo}
                analysing={analysing}
                ratio={studio.ratio}
                transport={transport}
                onTargetBpm={studio.setTargetBpm}
                onOriginalBpm={studio.setOriginalBpm}
              />
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-ink-800 bg-ink-900 py-2">
            <Timeline
              durationSec={durationSec}
              peaks={peaks?.loadId === engine?.loadId ? peaks : null}
              trackNames={loaded.tracks.map((t) => t.name)}
              sections={sections}
              bpm={bpm}
              downbeatSec={song.downbeatOffsetSec}
              transport={transport}
              transportAt={studio.transportAt}
              editing={editing}
              selected={current}
              onSeek={studio.seek}
              onSectionClick={(i) => studio.playFrom(sections[i]?.startSec ?? 0)}
              onSectionMove={moveSection}
            />
          </section>

          <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
            <Panel title="Partes de la canción" icon={<ListMusic size={18} />}>
              <SectionsPanel
                sections={sections}
                current={current}
                editing={editing}
                analysing={analysing}
                redetecting={studio.redetecting}
                barSec={barSec}
                onEditing={setEditing}
                onPlayFrom={(i) => studio.playFrom(sections[i]?.startSec ?? 0)}
                onChange={studio.saveSections}
                onAddAtCursor={addAtCursor}
                onRedetect={studio.redetectSections}
              />
              <p className="mt-3 text-xs text-ink-400">
                Atajos: Espacio reproducir/pausa · Esc detener · Inicio volver al principio · 1–9 tocar desde la sección.
                {editing && " Arrastra el borde izquierdo de una sección para moverla (se ajusta al compás; Alt = libre)."}
              </p>
            </Panel>

            <Panel
              title="Motor de audio"
              icon={<Activity size={18} />}
              tone={transport && transport.underruns > 0 ? "warn" : "ok"}
              statusLabel={transport && transport.underruns > 0 ? `${transport.underruns} cortes` : "Sin cortes"}
            >
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-ink-400">Salida</dt>
                <dd className="truncate text-right text-ink-100" title={studio.output?.deviceName}>{studio.output?.deviceName ?? "—"}</dd>
                <dt className="text-ink-400">Formato</dt>
                <dd className="text-right font-mono text-ink-100">
                  {studio.output?.sampleRate ? `${studio.output.sampleRate / 1000} kHz · ${studio.output.bufferSize} muestras` : "—"}
                </dd>
                <dt className="text-ink-400">Latencia de salida</dt>
                <dd className="text-right font-mono text-ink-100">{studio.output?.outputLatencyMs ? `${studio.output.outputLatencyMs.toFixed(1)} ms` : "—"}</dd>
                <dt className="text-ink-400">Carga del audio</dt>
                <dd className="text-right font-mono text-ink-100">{transport ? pct(transport.audioLoad) : "—"}</dd>
                <dt className="text-ink-400">Carga de render</dt>
                <dd className="text-right font-mono text-ink-100">{transport ? pct(transport.renderLoad) : "—"}</dd>
                <dt className="text-ink-400">Cortes del render</dt>
                <dd className="text-right font-mono text-ink-100">{transport?.underruns ?? 0}</dd>
                <dt className="text-ink-400">Fallos del driver</dt>
                <dd className="text-right font-mono text-ink-100">{transport?.deviceXruns ?? "n/d"}</dd>
                <dt className="text-ink-400">Memoria de audio</dt>
                <dd className="text-right font-mono text-ink-100">{Math.round(loaded.memoryMB)} MB</dd>
              </dl>
              <ul className="mt-3 grid gap-1 border-t border-ink-800 pt-3 text-xs">
                {loaded.tracks.map((t) => (
                  <li key={t.path} className="flex justify-between gap-2" title={t.path}>
                    <span className="truncate text-ink-200">{t.name}</span>
                    <span className="shrink-0 font-mono text-ink-400">
                      {t.format} · {t.sourceSampleRate / 1000} kHz{t.resampled ? " → convertido" : ""} · {t.channels === 1 ? "mono" : "estéreo"}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
