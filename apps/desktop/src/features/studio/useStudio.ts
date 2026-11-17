import { useCallback, useEffect, useRef, useState } from "react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type {
  OutputInfo,
  SectionRecord,
  SongRecord,
  SongSummary,
  SongTempo,
  StudioStatus,
  TransportState,
} from "@/lib/ipc/types";
import { clampRatio, fromDetected, renumber, roundBpm } from "./model";

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
  const [output, setOutput] = useState<OutputInfo | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [recent, setRecent] = useState<SongSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);

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

  // A song finished loading: fetch its record, waveforms and apply its tempo.
  useEffect(() => {
    const eng = status?.engine;
    if (!eng || eng.state !== "ready" || !eng.song || status.songId == null) return;
    if (handledLoad.current === eng.loadId) return;
    handledLoad.current = eng.loadId;
    handledRevision.current = -1;
    const loadId = eng.loadId;
    const trackCount = eng.song.tracks.length;

    (async () => {
      const record = await backend.studioGetSong(status.songId!);
      setSong(record);
      if (record) await backend.setTempoRatio(ratioOf(record));
      backend.outputInfo().then(setOutput, () => {});
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
    if (!analysis || analysis.state !== "done" || !current) return;
    if (handledLoad.current !== status?.engine.loadId || handledRevision.current === analysis.revision) return;
    handledRevision.current = analysis.revision;

    (async () => {
      let next = current;
      if (current.bpmSource === "none" && analysis.tempo) {
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
    run(
      backend
        .studioDetectSections(current.originalBpm ?? 0, current.downbeatOffsetSec)
        .then(() => backend.studioStatus().then(setStatus)),
    );
  }, [run]);

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
  };
}
