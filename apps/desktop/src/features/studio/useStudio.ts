import { useCallback, useEffect, useRef, useState } from "react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type {
  ImportCommit,
  ImportDraft,
  ImportTrack,
  Meters,
  OutputInfo,
  OutputSettings,
  SectionRecord,
  SongRecord,
  SongSummary,
  SongTempo,
  StudioStatus,
  TimeSignature,
  TrackRole,
  TransportState,
} from "@/lib/ipc/types";
import { beatsPerBar, clampRatio, effectiveGains, fromDetected, renumber, roundBpm } from "./model";

/** Live meter values shared without React re-renders (read by the meters' rAF loops). */
export interface MeterStore {
  current: Meters;
}

export interface MixerState {
  volumesDb: number[];
  mute: boolean[];
  solo: boolean[];
}

export interface Peaks {
  loadId: number;
  mix: Uint8Array;
  tracks: Uint8Array[];
}

export interface Studio {
  native: boolean;
  status: StudioStatus | null;
  song: SongRecord | null;
  transport: TransportState | null;
  /** performance.now() when `transport` was received (for smooth playhead). */
  transportAt: number;
  output: OutputInfo | null;
  peaks: Peaks | null;
  recent: SongSummary[];
  error: string | null;
  redetecting: boolean;
  /** Ratio currently applied (target / original BPM). */
  ratio: number;

  openFiles: (paths: string[]) => Promise<void>;
  openSong: (id: number) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (sec: number) => void;
  playFrom: (sec: number) => void;
  setGain: (gain: number) => void;
  setTargetBpm: (bpm: number | null) => void;
  setOriginalBpm: (bpm: number) => void;
  saveSections: (sections: SectionRecord[]) => void;
  redetectSections: () => void;
  clearError: () => void;

  // Import (zip / folder / files) with a review step.
  importDraft: ImportDraft | null;
  /** Index of the track being auditioned alone, or null. */
  soloTrack: number | null;
  startImport: (paths: string[]) => Promise<void>;
  previewSolo: (index: number | null) => void;
  commitImport: (commit: ImportCommit) => Promise<void>;
  cancelImport: () => void;

  // Tracks and outputs.
  outputSettings: OutputSettings | null;
  setOutput: (settings: OutputSettings) => void;
  updateTrack: (position: number, name: string, role: TrackRole) => void;
  setSongInfo: (title: string, timeSignature: TimeSignature) => void;

  // Mixer (volume / mute / solo per track; persisted from phase 3 on).
  meters: MeterStore;
  mixer: MixerState;
  setTrackVolume: (track: number, db: number) => void;
  toggleMute: (track: number) => void;
  toggleSolo: (track: number) => void;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ratioOf(song: SongRecord | null): number {
  if (!song?.originalBpm || !song.targetBpm) return 1;
  return clampRatio(song.targetBpm / song.originalBpm);
}

export function useStudio(): Studio {
  const native = isNativeAvailable();
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [song, setSong] = useState<SongRecord | null>(null);
  const [transport, setTransport] = useState<TransportState | null>(null);
  const [transportAt, setTransportAt] = useState(0);
  const [output, setOutputInfo] = useState<OutputInfo | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [recent, setRecent] = useState<SongSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [soloTrack, setSoloTrack] = useState<number | null>(null);
  const [outputSettings, setOutputSettings] = useState<OutputSettings | null>(null);
  const meters = useRef<Meters>({ tracks: [], main: [0, 0], monitor: [0, 0] });
  const [mixer, setMixer] = useState<MixerState>({ volumesDb: [], mute: [], solo: [] });

  const songRef = useRef<SongRecord | null>(null);
  songRef.current = song;
  const handledLoad = useRef(0);
  const handledRevision = useRef(-1);
  const redetectRef = useRef(false);

  const fail = useCallback((e: unknown) => setError(message(e)), []);
  const run = useCallback((p: Promise<unknown>) => void p.catch(fail), [fail]);

  // Database writes triggered by sliders / typing are delayed and coalesced.
  const timers = useRef(new Map<string, number>());
  const later = useCallback(
    (key: string, fn: () => Promise<unknown>, ms = 400) => {
      const prev = timers.current.get(key);
      if (prev) window.clearTimeout(prev);
      timers.current.set(key, window.setTimeout(() => {
        timers.current.delete(key);
        run(fn());
      }, ms));
    },
    [run],
  );

  const refreshRecent = useCallback(() => {
    if (native) backend.studioRecentSongs().then(setRecent, fail);
  }, [native, fail]);

  // Initial state.
  useEffect(() => {
    if (!native) return;
    refreshRecent();
    backend.studioStatus().then(setStatus, fail);
    backend.studioOutputSettings().then(setOutputSettings, () => {});
    backend.transportState().then((t) => {
      setTransport(t);
      setTransportAt(performance.now());
    }, fail);
  }, [native, refreshRecent, fail]);

  // Load/analysis status: fast while something is happening.
  const busy = status?.engine.state === "loading" || status?.engine.analysis?.state === "running";
  useEffect(() => {
    if (!native) return;
    const id = window.setInterval(
      () => backend.studioStatus().then(setStatus, fail),
      busy ? 250 : 1500,
    );
    return () => window.clearInterval(id);
  }, [native, busy, fail]);

  // Transport: ~25 updates per second; the playhead interpolates in between.
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const id = window.setInterval(() => {
      backend.transportState().then((t) => {
        if (!alive) return;
        setTransport(t);
        setTransportAt(performance.now());
      }, () => {});
    }, 40);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [native]);

  // Level meters, ~25 reads per second (peaks since the previous read).
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const id = window.setInterval(() => {
      backend.studioMeters().then((m) => {
        if (alive) meters.current = m;
      }, () => {});
    }, 40);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [native]);

  // A song (or an import preview) finished loading: waveforms, record, tempo.
  useEffect(() => {
    const eng = status?.engine;
    if (!eng || eng.state !== "ready" || !eng.song) return;
    if (handledLoad.current === eng.loadId) return;
    handledLoad.current = eng.loadId;
    handledRevision.current = -1;
    const loadId = eng.loadId;
    const trackCount = eng.song.tracks.length;
    const songId = status.songId;
    setMixer({ volumesDb: Array(trackCount).fill(0), mute: Array(trackCount).fill(false), solo: Array(trackCount).fill(false) });

    (async () => {
      if (songId != null) {
        const record = await backend.studioGetSong(songId);
        setSong(record);
        if (record) await backend.setTempoRatio(ratioOf(record));
      }
      backend.outputInfo().then(setOutputInfo, () => {});
      const mix = await backend.studioPeaks(-1);
      const tracks: Uint8Array[] = [];
      for (let i = 0; i < trackCount; i++) tracks.push(await backend.studioPeaks(i));
      setPeaks({ loadId, mix, tracks });
    })().catch(fail);
  }, [status, fail]);

  // Analysis finished: store the detected tempo / sections the first time.
  useEffect(() => {
    const analysis = status?.engine.analysis;
    const current = songRef.current;
    if (!analysis || analysis.state !== "done" || !current || status?.songId !== current.id) return;
    if (handledLoad.current !== status?.engine.loadId || analysis.revision <= handledRevision.current) return;
    handledRevision.current = analysis.revision;

    (async () => {
      let next = current;
      if (current.bpmSource === "user" && analysis.tempo?.source === "user" && analysis.tempo.bpm === current.originalBpm) {
        // Tempo given by the user: keep it, store the bar grid found for it.
        if (Math.abs(analysis.tempo.downbeatOffsetSec - current.downbeatOffsetSec) > 1e-3) {
          const tempo: SongTempo = {
            originalBpm: current.originalBpm,
            bpmSource: "user",
            downbeatOffsetSec: analysis.tempo.downbeatOffsetSec,
            targetBpm: current.targetBpm,
          };
          await backend.studioSaveTempo(current.id, tempo);
          next = { ...next, ...tempo };
        }
      } else if (current.bpmSource === "none" && analysis.tempo) {
        const tempo: SongTempo = {
          originalBpm: roundBpm(analysis.tempo.bpm),
          bpmSource: "detected",
          downbeatOffsetSec: analysis.tempo.downbeatOffsetSec,
          targetBpm: null,
        };
        await backend.studioSaveTempo(current.id, tempo);
        next = { ...next, ...tempo };
      }
      if (redetectRef.current || !current.sectionsInitialized) {
        const sections = renumber(fromDetected(analysis.sections));
        await backend.studioSaveSections(current.id, sections);
        next = { ...next, sections, sectionsInitialized: true };
        redetectRef.current = false;
        setRedetecting(false);
      }
      if (next !== current) setSong(next);
    })().catch(fail);
  }, [status, fail]);

  const afterOpen = useCallback(
    (record: SongRecord) => {
      setSong(record);
      setPeaks(null);
      setError(null);
      setImportDraft(null);
      setSoloTrack(null);
      refreshRecent();
      backend.studioStatus().then(setStatus, fail);
    },
    [refreshRecent, fail],
  );

  const openFiles = useCallback(
    async (paths: string[]) => {
      try {
        afterOpen(await backend.studioOpenFiles(paths));
      } catch (e) {
        fail(e);
      }
    },
    [afterOpen, fail],
  );

  const openSong = useCallback(
    async (id: number) => {
      try {
        afterOpen(await backend.studioOpenSong(id));
      } catch (e) {
        fail(e);
      }
    },
    [afterOpen, fail],
  );

  const playing = transport?.playState === "playing";
  const play = useCallback(() => run(backend.play()), [run]);
  const pause = useCallback(() => run(backend.pause()), [run]);
  const togglePlay = useCallback(() => run(playing ? backend.pause() : backend.play()), [run, playing]);
  const stop = useCallback(() => run(backend.stop()), [run]);
  const seek = useCallback((sec: number) => run(backend.seek(sec)), [run]);
  const playFrom = useCallback((sec: number) => run(backend.seek(sec).then(() => backend.play())), [run]);
  const setGain = useCallback((gain: number) => run(backend.setMasterGain(gain)), [run]);

  const persistTempo = useCallback(
    (next: SongRecord) => {
      setSong(next);
      run(backend.setTempoRatio(ratioOf(next))); // the engine follows immediately
      later(`tempo-${next.id}`, () =>
        backend.studioSaveTempo(next.id, {
          originalBpm: next.originalBpm,
          bpmSource: next.bpmSource,
          downbeatOffsetSec: next.downbeatOffsetSec,
          targetBpm: next.targetBpm,
        }),
      );
    },
    [run, later],
  );

  const setTargetBpm = useCallback(
    (bpm: number | null) => {
      const current = songRef.current;
      if (!current?.originalBpm) return;
      const target = bpm == null ? null : roundBpm(clampRatio(bpm / current.originalBpm) * current.originalBpm);
      persistTempo({ ...current, targetBpm: target === current.originalBpm ? null : target });
    },
    [persistTempo],
  );

  const setOriginalBpm = useCallback(
    (bpm: number) => {
      const current = songRef.current;
      if (!current || !(bpm >= 20 && bpm <= 400)) return;
      // Keep the same relative speed when the reference tempo is corrected.
      const ratio = ratioOf(current);
      const original = roundBpm(bpm);
      persistTempo({
        ...current,
        originalBpm: original,
        bpmSource: "user",
        targetBpm: ratio === 1 ? null : roundBpm(original * ratio),
      });
    },
    [persistTempo],
  );

  const saveSections = useCallback(
    (sections: SectionRecord[]) => {
      const current = songRef.current;
      if (!current) return;
      const next = renumber(sections);
      setSong({ ...current, sections: next, sectionsInitialized: true });
      later(`sections-${current.id}`, () => backend.studioSaveSections(current.id, next));
    },
    [later],
  );

  const redetectSections = useCallback(() => {
    const current = songRef.current;
    if (!current) return;
    redetectRef.current = true;
    setRedetecting(true);
    // Known tempo: re-estimate the bar grid too (-1), with the song's meter.
    run(
      backend
        .studioDetectSections(current.originalBpm ?? 0, -1, beatsPerBar(current.timeSignature))
        .then(() => backend.studioStatus().then(setStatus)),
    );
  }, [run]);

  // ---- Import ------------------------------------------------------------

  const startImport = useCallback(
    async (paths: string[]) => {
      try {
        setError(null);
        const draft = await backend.importInspect(paths);
        if (draft.existingSongId != null) {
          afterOpen(await backend.studioOpenSong(draft.existingSongId));
          return;
        }
        setSong(null);
        setPeaks(null);
        setSoloTrack(null);
        setImportDraft(draft);
        const tracks: ImportTrack[] = draft.files.map((f) => ({ filePath: f.filePath, name: f.suggestedName, role: f.suggestedRole }));
        await backend.importPreview(tracks);
        backend.studioStatus().then(setStatus, fail);
      } catch (e) {
        fail(e);
      }
    },
    [afterOpen, fail],
  );

  const previewSolo = useCallback(
    (index: number | null) => {
      const count = status?.engine.song?.tracks.length ?? 0;
      const next = index === soloTrack ? null : index;
      setSoloTrack(next);
      run(
        (async () => {
          for (let i = 0; i < count; i++) await backend.studioSetTrackGain(i, next == null || i === next ? 1 : 0);
          if (next == null) {
            await backend.pause();
          } else if (transport?.playState !== "playing") {
            // Start where the arrangement is usually full (a quarter in).
            const dur = status?.engine.song?.durationSec ?? 0;
            if ((transport?.positionSec ?? 0) < 1) await backend.seek(Math.min(45, dur * 0.25));
            await backend.play();
          }
        })(),
      );
    },
    [run, status, soloTrack, transport],
  );

  const commitImport = useCallback(
    async (commit: ImportCommit) => {
      try {
        // Wait for the analysis that runs with the confirmed roles / tempo / meter.
        const revision = status?.engine.analysis?.revision ?? -1;
        await backend.pause();
        const record = await backend.importCommit(commit);
        handledRevision.current = revision;
        setSong(record);
        setImportDraft(null);
        setSoloTrack(null);
        refreshRecent();
        backend.studioStatus().then(setStatus, fail);
      } catch (e) {
        fail(e);
      }
    },
    [status, refreshRecent, fail],
  );

  const cancelImport = useCallback(() => {
    const draft = importDraft;
    setImportDraft(null);
    setSoloTrack(null);
    run(backend.importCancel(draft?.extractedDir ?? null));
  }, [importDraft, run]);

  // ---- Tracks and outputs ------------------------------------------------

  const setOutput = useCallback(
    (settings: OutputSettings) => {
      const previous = outputSettings;
      setOutputSettings(settings);
      backend.studioSetOutput(settings).catch((e) => {
        setOutputSettings(previous);
        fail(e);
      });
    },
    [outputSettings, fail],
  );

  const updateTrack = useCallback(
    (position: number, name: string, role: TrackRole) => {
      const current = songRef.current;
      if (!current) return;
      setSong({
        ...current,
        tracks: current.tracks.map((t) =>
          t.position === position ? { ...t, name, role, bus: role === "click" || role === "cues" ? "monitor" : "main" } : t,
        ),
      });
      later(`track-${current.id}-${position}`, () =>
        backend.studioUpdateTrack(current.id, position, name, role).then(() => backend.studioStatus().then(setStatus)),
      );
    },
    [later],
  );

  const applyMixer = useCallback(
    (next: MixerState) => {
      setMixer(next);
      const gains = effectiveGains(next.volumesDb, next.mute, next.solo);
      run(Promise.all(gains.map((g, i) => backend.studioSetTrackGain(i, Math.min(2, g)))));
    },
    [run],
  );

  const setTrackVolume = useCallback(
    (track: number, db: number) => {
      applyMixer({ ...mixer, volumesDb: mixer.volumesDb.map((v, i) => (i === track ? db : v)) });
    },
    [mixer, applyMixer],
  );
  const toggleMute = useCallback(
    (track: number) => applyMixer({ ...mixer, mute: mixer.mute.map((v, i) => (i === track ? !v : v)) }),
    [mixer, applyMixer],
  );
  const toggleSolo = useCallback(
    (track: number) => applyMixer({ ...mixer, solo: mixer.solo.map((v, i) => (i === track ? !v : v)) }),
    [mixer, applyMixer],
  );

  const setSongInfo = useCallback(
    (title: string, timeSignature: TimeSignature) => {
      const current = songRef.current;
      if (!current) return;
      setSong({ ...current, title, timeSignature });
      later(`info-${current.id}`, () => backend.studioSetSongInfo(current.id, title, timeSignature));
    },
    [later],
  );

  return {
    native,
    status,
    song,
    transport,
    transportAt,
    output,
    peaks,
    recent,
    error,
    redetecting,
    ratio: ratioOf(song),
    openFiles,
    openSong,
    play,
    pause,
    togglePlay,
    stop,
    seek,
    playFrom,
    setGain,
    setTargetBpm,
    setOriginalBpm,
    saveSections,
    redetectSections,
    clearError: () => setError(null),
    importDraft,
    soloTrack,
    startImport,
    previewSolo,
    commitImport,
    cancelImport,
    outputSettings,
    setOutput,
    updateTrack,
    setSongInfo,
    meters,
    mixer,
    setTrackVolume,
    toggleMute,
    toggleSolo,
  };
}
