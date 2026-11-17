import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronUp, FolderOpen, Gauge, ListMusic, SlidersHorizontal, Tags, X } from "lucide-react";
import type { OutputMode, SectionRecord } from "@/lib/ipc/types";
import { Arrange } from "./Arrange";
import { ImportDialog } from "./ImportDialog";
import { Mixer } from "./Mixer";
import { beatsPerBar, dbToGain, gainToDb, kindLabel, moveItem, sectionAt, snapToBar, withEnds } from "./model";
import { OutputPanel, TracksPanel } from "./OutputPanel";
import { SectionsPanel } from "./SectionsPanel";
import { TempoControl } from "./TempoControl";
import { Toolbar } from "./Toolbar";
import { useStudio, type Studio } from "./useStudio";

type DockTab = "mixer" | "sections" | "tempo" | "outputs" | "tracks" | "engine";
const DOCK_TABS: { id: DockTab; label: string; icon: typeof Activity }[] = [
  { id: "mixer", label: "Mezclador", icon: SlidersHorizontal },
  { id: "sections", label: "Partes", icon: ListMusic },
  { id: "tempo", label: "Tempo", icon: Gauge },
  { id: "outputs", label: "Salidas", icon: SlidersHorizontal },
  { id: "tracks", label: "Pistas", icon: Tags },
  { id: "engine", label: "Motor", icon: Activity },
];

const AUDIO_EXTENSIONS = ["wav", "wave", "mp3", "aif", "aiff", "flac", "ogg"];
const IMPORT_EXTENSIONS = ["zip", ...AUDIO_EXTENSIONS];

async function pickFiles(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "Selecciona el zip de la canción o sus pistas",
    filters: [
      { name: "Canción (zip o audio)", extensions: IMPORT_EXTENSIONS },
      { name: "Zip", extensions: ["zip"] },
      { name: "Audio", extensions: AUDIO_EXTENSIONS },
    ],
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
  const loaded = engine?.state === "ready" && engine.song && song && status?.songId === song.id ? engine.song : null;
  const previewReady = engine?.state === "ready" && !!engine.song && status?.songId == null;
  const analysing = engine?.analysis?.state === "running";
  const [editing, setEditing] = useState(false);
  const [dock, setDock] = useState<DockTab>("mixer");
  const [dockOpen, setDockOpen] = useState(true);

  const durationSec = loaded?.durationSec ?? 0;
  const sections = useMemo(() => withEnds(song?.sections ?? [], durationSec), [song?.sections, durationSec]);
  const sectionStarts = useMemo(() => sections.map((s) => s.startSec), [sections]);
  const current = sectionAt(sections, transport?.positionSec ?? 0);
  const bpm = song?.originalBpm ?? null;
  const beats = song ? beatsPerBar(song.timeSignature) : 4;
  const barSec = bpm ? (beats * 60) / bpm : null;

  useShortcuts(studio, sectionStarts);

  // Debug builds only: lets the E2E test open the import dialog as if a file
  // had been dropped (the native picker / drag & drop cannot be scripted).
  useEffect(() => {
    const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
    if (!env.TAURI_ENV_DEBUG) return;
    (window as unknown as { __LIVEPLAYER_TEST__?: unknown }).__LIVEPLAYER_TEST__ = { startImport: studio.startImport };
  }, [studio.startImport]);
  const hovering = useFileDrop(studio.startImport, studio.native && !studio.importDraft);

  const open = async () => {
    try {
      const paths = await pickFiles();
      if (paths) await studio.startImport(paths);
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
    const at = snapToBar(transport?.positionSec ?? 0, bpm, song?.downbeatOffsetSec ?? 0, beats);
    if (sections.some((s) => Math.abs(s.startSec - at) < 0.5)) return;
    const base: SectionRecord[] = sections.map(({ startSec, kind, label, source }) => ({ startSec, kind, label, source }));
    studio.saveSections([...base, { startSec: at, kind: "section", label: kindLabel("section"), source: "user" }]);
  };

  // Tracks in the order the user arranged them (click and cues first by default).
  const tracks = loaded
    ? loaded.tracks
        .map((t, i) => {
          const rec = song?.tracks.find((r) => r.position === i);
          return {
            index: i,
            name: rec?.name ?? t.name,
            role: rec?.role ?? "other",
            bus: rec?.bus ?? t.bus,
            order: rec?.displayOrder ?? i,
            mixerOrder: rec?.mixerOrder ?? rec?.displayOrder ?? i,
          };
        })
        .sort((a, b) => a.order - b.order || a.index - b.index)
    : [];
  // The mixer strips have their own order: moving one never moves the tracks.
  const mixerTracks = [...tracks].sort((a, b) => a.mixerOrder - b.mixerOrder || a.index - b.index);
  const reorder = (from: number, to: number) => studio.reorderTracks(moveItem(tracks, from, to).map((t) => t.index));
  const reorderMixer = (from: number, to: number) => studio.reorderMixer(moveItem(mixerTracks, from, to).map((t) => t.index));
  const outputMode: OutputMode = studio.outputSettings?.mode ?? transport?.outputMode ?? "stereo";
  const monitorGain = studio.outputSettings?.monitorGain ?? 1;
  const setOutputMode = (mode: OutputMode) => studio.setOutput({ mode, monitorGain });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Toolbar
        native={studio.native}
        song={loaded ? song : null}
        recent={studio.recent}
        transport={transport}
        output={studio.output}
        outputMode={outputMode}
        ratio={studio.ratio}
        beatsPerBar={beats}
        ready={!!loaded}
        onOpen={open}
        onOpenRecent={(id) => void studio.openSong(id)}
        onMeter={(ts) => song && studio.setSongInfo(song.title, ts)}
        onPlay={studio.play}
        onPause={studio.pause}
        onStop={studio.stop}
        onRestart={() => studio.seek(0)}
        onTargetBpm={studio.setTargetBpm}
        onOutputMode={setOutputMode}
      />

      {!studio.native && (
        <p className="m-4 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: no hay motor de audio disponible.
        </p>
      )}

      {studio.error && (
        <div role="alert" className="mx-4 mt-3 flex items-start gap-3 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-2 text-sm text-stop-500">
          <span className="flex-1">{studio.error}</span>
          <button type="button" onClick={studio.clearError} aria-label="Cerrar aviso">
            <X size={16} />
          </button>
        </div>
      )}

      {hovering && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-info-500/10 text-xl font-semibold text-info-400 ring-4 ring-inset ring-info-500">
          Suelta el zip, la carpeta o los archivos de la canción
        </div>
      )}

      {studio.importDraft && (
        <ImportDialog
          draft={studio.importDraft}
          peaks={previewReady && peaks?.loadId === engine?.loadId ? peaks.tracks : null}
          previewReady={previewReady}
          previewProgress={engine?.state === "loading" ? engine.progress : previewReady ? 1 : 0}
          soloTrack={studio.soloTrack}
          onSolo={studio.previewSolo}
          onCommit={studio.commitImport}
          onCancel={studio.cancelImport}
        />
      )}

      {engine?.state === "loading" && !studio.importDraft && (
        <div className="m-4 rounded-xl border border-ink-800 bg-ink-900 px-5 py-4">
          <p className="mb-2 text-sm text-ink-200">Cargando canción… {Math.round(engine.progress * 100)} %</p>
          <div className="h-2 overflow-hidden rounded bg-ink-800">
            <div className="h-full bg-info-500 transition-[width]" style={{ width: `${engine.progress * 100}%` }} />
          </div>
        </div>
      )}

      {engine?.state === "error" && (
        <p role="alert" className="m-4 rounded-lg border border-stop-500/50 bg-stop-500/10 px-4 py-3 text-sm text-stop-500">
          No se pudo cargar la canción: {engine.error}
        </p>
      )}

      {!loaded && !studio.importDraft && engine?.state !== "loading" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <button
            type="button"
            onClick={open}
            disabled={!studio.native}
            className="flex w-full max-w-3xl flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-ink-700 py-20 text-ink-300 hover:border-info-500 hover:text-info-400 disabled:opacity-50"
          >
            <FolderOpen size={40} />
            <span className="text-lg font-semibold">Arrastra aquí el zip o la carpeta de la canción, o haz clic para elegir</span>
            <span className="text-sm text-ink-400">ZIP, WAV, MP3, AIFF, FLAC u OGG · te preguntaré título, BPM, compás y qué es cada pista</span>
          </button>
        </div>
      )}

      {song && loaded && (
        <>
          <div className="min-h-0 flex-1">
            <Arrange
              durationSec={durationSec}
              tracks={tracks}
              peaks={peaks?.loadId === engine?.loadId ? (peaks?.tracks ?? null) : null}
              sections={sections}
              bpm={bpm}
              beatsPerBar={beats}
              downbeatSec={song.downbeatOffsetSec}
              transport={transport}
              transportAt={studio.transportAt}
              meters={studio.meters}
              mute={studio.mixer.mute}
              solo={studio.mixer.solo}
              editing={editing}
              selected={current}
              onSeek={studio.seek}
              onSectionClick={(i) => studio.playFrom(sections[i]?.startSec ?? 0)}
              onSectionMove={moveSection}
              onMute={studio.toggleMute}
              onSolo={studio.toggleSolo}
              onReorder={reorder}
            />
          </div>

          {/* Bottom dock */}
          <div className="flex shrink-0 flex-col border-t-2 border-ink-700 bg-ink-900" style={{ height: dockOpen ? 318 : 34 }}>
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-ink-800 px-2" role="tablist" aria-label="Paneles del Studio">
              {DOCK_TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={dock === t.id}
                    onClick={() => {
                      setDock(t.id);
                      setDockOpen(true);
                    }}
                    className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold uppercase tracking-wider ${
                      dock === t.id && dockOpen ? "bg-ink-800 text-info-400" : "text-ink-400 hover:text-ink-100"
                    }`}
                  >
                    <Icon size={13} /> {t.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setDockOpen(!dockOpen)}
                aria-label={dockOpen ? "Ocultar panel" : "Mostrar panel"}
                className="ml-auto rounded p-1 text-ink-400 hover:text-ink-100"
              >
                {dockOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              </button>
            </div>

            {dockOpen && (
              <div className="min-h-0 flex-1 overflow-hidden" role="tabpanel">
                {dock === "mixer" && (
                  <Mixer
                    tracks={mixerTracks}
                    volumesDb={studio.mixer.volumesDb}
                    mute={studio.mixer.mute}
                    solo={studio.mixer.solo}
                    meters={studio.meters}
                    masterDb={gainToDb(transport?.masterGain ?? 1)}
                    monitorDb={gainToDb(monitorGain)}
                    limiting={{ main: (transport?.mainLimiterGain ?? 1) < 0.999, monitor: (transport?.monitorLimiterGain ?? 1) < 0.999 }}
                    onVolume={studio.setTrackVolume}
                    onMute={studio.toggleMute}
                    onSolo={studio.toggleSolo}
                    onMaster={(db) => studio.setGain(dbToGain(db))}
                    onMonitor={(db) => studio.setOutput({ mode: outputMode, monitorGain: dbToGain(db) })}
                    onReorder={reorderMixer}
                  />
                )}
                {dock === "sections" && (
                  <div className="h-full overflow-y-auto p-4">
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
                      Atajos: Espacio reproducir/pausa · Esc detener · Inicio volver al principio · 1–9 tocar desde la parte.
                      {editing && " Arrastra el borde izquierdo de una parte (arriba, en el carril de partes) para moverla; se ajusta al compás (Alt = libre)."}
                    </p>
                  </div>
                )}
                {dock === "tempo" && (
                  <div className="h-full overflow-y-auto p-4">
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
                )}
                {dock === "outputs" && (
                  <div className="h-full overflow-y-auto p-4">
                    <OutputPanel settings={studio.outputSettings} transport={transport} song={loaded} onChange={studio.setOutput} />
                  </div>
                )}
                {dock === "tracks" && (
                  <div className="h-full overflow-y-auto p-4">
                    <TracksPanel song={song} onUpdate={studio.updateTrack} />
                  </div>
                )}
                {dock === "engine" && (
                  <div className="grid h-full grid-cols-2 gap-6 overflow-y-auto p-4 text-xs">
                    <dl className="grid grid-cols-2 content-start gap-x-3 gap-y-1">
                      <dt className="text-ink-400">Salida</dt>
                      <dd className="truncate text-right text-ink-100" title={studio.output?.deviceName}>{studio.output?.deviceName ?? "—"}</dd>
                      <dt className="text-ink-400">Formato</dt>
                      <dd className="text-right font-mono text-ink-100">
                        {studio.output?.sampleRate ? `${studio.output.sampleRate / 1000} kHz · ${studio.output.bufferSize} muestras · ${studio.output.outputChannels ?? 2} canales` : "—"}
                      </dd>
                      <dt className="text-ink-400">Latencia de salida</dt>
                      <dd className="text-right font-mono text-ink-100">{studio.output?.outputLatencyMs ? `${studio.output.outputLatencyMs.toFixed(1)} ms` : "—"}</dd>
                      <dt className="text-ink-400">Carga del audio / render</dt>
                      <dd className="text-right font-mono text-ink-100">{transport ? `${pct(transport.audioLoad)} / ${pct(transport.renderLoad)}` : "—"}</dd>
                      <dt className="text-ink-400">Cortes del render</dt>
                      <dd className="text-right font-mono text-ink-100">{transport?.underruns ?? 0}</dd>
                      <dt className="text-ink-400">Memoria de audio</dt>
                      <dd className="text-right font-mono text-ink-100">{Math.round(loaded.memoryMB)} MB</dd>
                    </dl>
                    <ul className="grid content-start gap-1">
                      {loaded.tracks.map((t) => (
                        <li key={t.path} className="flex justify-between gap-2" title={t.path}>
                          <span className="truncate text-ink-200">{t.name}</span>
                          <span className="shrink-0 font-mono text-ink-400">
                            {t.format} · {t.sourceSampleRate / 1000} kHz{t.resampled ? " → convertido" : ""} · {t.channels === 1 ? "mono" : "estéreo"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
