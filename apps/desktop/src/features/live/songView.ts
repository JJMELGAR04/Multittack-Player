import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { TransportState } from "@/lib/ipc/types";
import { beatsPerBar, moveItem, sectionAt, withEnds } from "@/features/studio/model";
import type { MixerTrack } from "@/features/studio/Mixer";
import type { Studio } from "@/features/studio/useStudio";
import { actionFor, isTypingTarget, keyName, type ShortcutAction, type Shortcuts, withDefaults } from "./model";

/** What the Live and Song Editor pages read from the studio hook. */
export function useSongView(studio: Studio) {
  const { song, status, transport } = studio;
  const engine = status?.engine;
  const loaded = engine?.state === "ready" && engine.song && song && status?.songId === song.id ? engine.song : null;
  const durationSec = loaded?.durationSec ?? 0;
  const sections = useMemo(() => withEnds(song?.sections ?? [], durationSec), [song?.sections, durationSec]);
  const bpm = song?.originalBpm ?? null;
  const beats = song ? beatsPerBar(song.timeSignature) : 4;
  const downbeat = song?.downbeatOffsetSec ?? 0;

  const tracks: (MixerTrack & { order: number; mixerOrder: number })[] = loaded
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
  const mixerTracks = [...tracks].sort((a, b) => a.mixerOrder - b.mixerOrder || a.index - b.index);
  const reorderMixer = (from: number, to: number) => studio.reorderMixer(moveItem(mixerTracks, from, to).map((t) => t.index));

  const position = transport?.positionSec ?? 0;
  const current = sectionAt(sections, position);
  return { loaded, durationSec, sections, bpm, beats, downbeat, tracks, mixerTracks, reorderMixer, position, current };
}

/** Playhead position between transport polls (smooth at 60 fps). */
export function livePosition(t: TransportState | null, at: number): number {
  if (!t) return 0;
  if (t.playState !== "playing") return t.positionSec;
  const elapsed = (performance.now() - at) / 1000;
  return Math.min(t.durationSec, t.positionSec + Math.min(elapsed, 0.25) * t.tempoRatio);
}

/** The user's keyboard shortcuts (General Settings), with defaults. */
export function useShortcutSettings() {
  const native = isNativeAvailable();
  const [shortcuts, setShortcuts] = useState<Shortcuts>(withDefaults(null));
  useEffect(() => {
    if (native) backend.uiSetting<Partial<Shortcuts>>("shortcuts").then((s) => setShortcuts(withDefaults(s)), () => {});
  }, [native]);
  const save = useCallback(
    async (next: Shortcuts) => {
      setShortcuts(next);
      if (native) await backend.setUiSetting("shortcuts", next);
    },
    [native],
  );
  return { shortcuts, save };
}

/** Runs `handlers[action]` for the configured keys (never while typing in a field). */
export function useShortcutKeys(shortcuts: Shortcuts, handlers: Partial<Record<ShortcutAction, () => void>>, extra?: (e: KeyboardEvent) => boolean) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const extraRef = useRef(extra);
  extraRef.current = extra;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.repeat) return;
      if (extraRef.current?.(e)) return;
      const action = actionFor(shortcuts, keyName(e));
      const run = action ? ref.current[action] : undefined;
      if (run) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);
}
