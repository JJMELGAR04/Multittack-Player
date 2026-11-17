import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Lock, LockOpen, Pause, Play, Radio, Repeat, RotateCcw, Save, SkipBack, Square, X } from "lucide-react";
import { backend, isNativeAvailable } from "@/lib/ipc/client";
import type { SetlistRecord, SetlistSummary } from "@/lib/ipc/types";
import { Mixer } from "@/features/studio/Mixer";
import { barBeat, dbToGain, formatBpm, formatTime, gainToDb, SECTION_COLORS } from "@/features/studio/model";
import { useStudio } from "@/features/studio/useStudio";
import { formatDuration, formatEventDate, JUMP_MODES, jumpTime, keyLabel, type JumpMode } from "./model";
import { livePosition, useShortcutKeys, useShortcutSettings, useSongView } from "./songView";

/** Big stage clock that moves smoothly between transport polls. */
function Clock({ studio, bpm, downbeat, beats }: { studio: ReturnType<typeof useStudio>; bpm: number | null; downbeat: number; beats: number }) {
  const timeRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const t = useRef(studio.transport);
  const at = useRef(studio.transportAt);
  t.current = studio.transport;
  at.current = studio.transportAt;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const pos = livePosition(t.current, at.current);
      if (timeRef.current) timeRef.current.textContent = formatTime(pos, 1);
      const bb = barBeat(pos, bpm, downbeat, beats);
      if (barRef.current) barRef.current.textContent = bb ? `Compás ${bb.bar} · ${bb.beat}` : "";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bpm, downbeat, beats]);
  return (
    <div className="text-right">
      <span ref={timeRef} className="block font-mono text-5xl font-bold tabular-nums text-go-400" data-live-clock>
        0:00.0
      </span>
      <span ref={barRef} className="block font-mono text-sm text-ink-300" />
    </div>
  );
}

export function LivePage() {
  const native = isNativeAvailable();
  const studio = useStudio({ persistMix: false });
  const view = useSongView(studio);
  const { shortcuts } = useShortcutSettings();
  const { transport, song } = studio;

  const [lists, setLists] = useState<SetlistSummary[] | null>(null);
  const [setlist, setSetlist] = useState<SetlistRecord | null>(null);
  const [cued, setCued] = useState(0); // highlighted row (keyboard)
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [mode, setMode] = useState<JumpMode>("bar");
  const [confirmSwitch, setConfirmSwitch] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  // Setlists, and the one used last time.
  useEffect(() => {
    if (!native) return;
    backend.setlists().then(async (l) => {
      setLists(l);
      const last = await backend.uiSetting<number>("live.lastSetlist").catch(() => null);
      const pick = l.find((s) => s.id === last) ?? l[0];
      if (pick) setSetlist(await backend.setlist(pick.id));
    }, fail);
  }, [native]);

  const chooseSetlist = async (id: number) => {
    setSetlist(await backend.setlist(id));
    setCued(0);
    setPlayingIndex(null);
    void backend.setUiSetting("live.lastSetlist", id);
  };

  const items = setlist?.items ?? [];
  const playing = transport?.playState === "playing";

  const loadIndex = useCallback(
    (i: number) => {
      const item = items[i];
      if (!item) return;
      setConfirmSwitch(null);
      setCued(i);
      setPlayingIndex(i);
      void studio.openSong(item.songId);
    },
    [items, studio],
  );

  /** Choosing another song while one is playing asks first. */
  const requestSong = (i: number) => {
    if (locked || i === playingIndex) return;
    if (playing) setConfirmSwitch(i);
    else loadIndex(i);
  };

  // Once the song is ready, decode the next one of the setlist in the background.
  const loadedId = view.loaded ? song?.id : undefined;
  useEffect(() => {
    if (!native || loadedId === undefined || playingIndex === null) return;
    const next = items[playingIndex + 1];
    void backend.preloadSong(next ? next.songId : null).catch(() => {});
  }, [native, loadedId, playingIndex, items]);

  // ---- Parts: jump at the next bar / end of part, loop ----
  const sections = view.sections;
  const currentPart = view.current >= 0 ? sections[view.current] : undefined;
  const nextPart = view.current + 1 < sections.length ? sections[view.current + 1] : undefined;
  const pending = transport?.pendingJump ?? null;
  const loop = transport?.loopRange ?? null;
  const loopingCurrent = !!loop && !!currentPart && Math.abs(loop[0] - currentPart.startSec) < 0.01;

  const jumpTo = async (target: number) => {
    const t = transport;
    if (!t || t.playState !== "playing") {
      studio.seek(target);
      return;
    }
    if (pending && Math.abs(pending.targetSec - target) < 0.01) {
      await backend.cancelJump(); // same part again = cancel
      return;
    }
    const pos = livePosition(t, studio.transportAt);
    const at = jumpTime(mode, pos, t.minJumpLeadSec + 0.08, view.bpm, view.downbeat, view.beats, currentPart?.endSec ?? null, view.durationSec);
    if (at === null) {
      studio.seek(target);
      return;
    }
    await backend.scheduleJump(at, target).catch(() => studio.seek(target));
  };

  const toggleLoop = async () => {
    if (!currentPart) return;
    try {
      if (loopingCurrent) await backend.setLoop(0, 0);
      else await backend.setLoop(currentPart.startSec, currentPart.endSec);
    } catch (e) {
      fail(e);
    }
  };

  const cancel = async () => {
    await backend.cancelJump().catch(() => {});
    if (loop) await backend.setLoop(0, 0).catch(() => {});
  };

  const stop = () => {
    if (playing && !confirmStop) {
      setConfirmStop(true);
      return;
    }
    setConfirmStop(false);
    void backend.setLoop(0, 0).catch(() => {});
    studio.stop();
  };

  useShortcutKeys(
    shortcuts,
    {
      playPause: () => view.loaded && studio.togglePlay(),
      stop: () => !locked && stop(),
      prevPart: () => {
        if (view.current > 0) void jumpTo(sections[view.current - 1]!.startSec);
        else if (currentPart) void jumpTo(currentPart.startSec);
      },
      nextPart: () => nextPart && void jumpTo(nextPart.startSec),
      loopPart: () => void toggleLoop(),
      cancelJump: () => {
        setConfirmSwitch(null);
        setConfirmStop(false);
        void cancel();
      },
      prevSong: () => setCued((c) => Math.max(0, c - 1)),
      nextSong: () => setCued((c) => Math.min(items.length - 1, c + 1)),
    },
    (e) => {
      if (e.key === "Enter" && confirmSwitch !== null) {
        loadIndex(confirmSwitch);
        return true;
      }
      if (e.key === "Enter" && !locked) {
        requestSong(cued);
        return true;
      }
      return false;
    },
  );

  const monitorGain = studio.outputSettings?.monitorGain ?? 1;
  const mainGain = studio.outputSettings?.mainGain ?? 1;
  const outputMode = studio.outputSettings?.mode ?? "stereo";
  const totalSec = useMemo(() => items.reduce((s, i) => s + (i.durationSec ?? 0), 0), [items]);
  const loadingSong = studio.status?.engine.state === "loading";
  const preload = studio.status?.engine.preload?.state;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-black">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-800 bg-ink-950 px-4 py-2">
        <Radio className="text-live-400" size={20} />
        <h1 className="text-lg font-bold tracking-wide">Live Mode</h1>
        <select
          aria-label="Setlist"
          value={setlist?.id ?? ""}
          disabled={locked || !lists?.length}
          onChange={(e) => void chooseSetlist(Number(e.target.value))}
          className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-ink-100"
        >
          {(lists ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.eventDate ? ` · ${formatEventDate(l.eventDate)}` : ""}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-ink-300">
          Saltos
          <select aria-label="Cuándo saltar" value={mode} onChange={(e) => setMode(e.target.value as JumpMode)} className="rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100">
            {JUMP_MODES.map((m) => (
              <option key={m.mode} value={m.mode} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-ink-400" data-preload={preload ?? "idle"}>
          {preload === "loading" ? "Preparando la siguiente…" : preload === "ready" ? "Siguiente lista ✓" : preload === "skipped" ? "Sin memoria para preparar la siguiente" : ""}
        </span>
        <button
          type="button"
          aria-pressed={locked}
          aria-label={locked ? "Desbloquear" : "Bloquear"}
          onClick={() => setLocked((l) => !l)}
          className={`ml-auto flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold ${locked ? "bg-live-500 text-black" : "border border-ink-700 text-ink-200 hover:border-ink-500"}`}
          title="Bloqueado: no se puede cambiar de canción, detener ni tocar el mezclador por accidente"
        >
          {locked ? <Lock size={15} /> : <LockOpen size={15} />} {locked ? "Bloqueado" : "Bloquear"}
        </button>
      </div>

      {error && (
        <p role="alert" className="flex items-center gap-2 border-b border-stop-500/40 bg-stop-500/10 px-4 py-2 text-sm text-stop-500">
          {error}
          <button type="button" className="ml-auto" aria-label="Cerrar" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </p>
      )}

      {!native ? (
        <p className="m-6 rounded-lg border border-live-500/40 bg-live-500/10 px-4 py-3 text-sm text-live-400">
          La interfaz se está ejecutando fuera de la aplicación de escritorio: Live Mode no está disponible.
        </p>
      ) : lists && lists.length === 0 ? (
        <div className="m-auto max-w-md text-center text-ink-300">
          <p className="text-lg font-semibold">Todavía no tienes setlists.</p>
          <p className="mt-2 text-sm">Crea uno en <Link to="/setlists" className="text-info-400 underline">Setlists</Link> con las canciones del servicio o concierto.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Setlist column */}
          <aside className="flex w-80 shrink-0 flex-col border-r border-ink-800 bg-ink-950">
            <div className="border-b border-ink-800 px-4 py-2 text-xs text-ink-400">
              {items.length} canciones · {formatDuration(totalSec)}
              {setlist?.place ? ` · ${setlist.place}` : ""}
            </div>
            <ol className="min-h-0 flex-1 overflow-y-auto" aria-label="Canciones del setlist">
              {items.map((it, i) => {
                const isPlaying = i === playingIndex;
                return (
                  <li key={`${it.songId}-${i}`}>
                    <button
                      type="button"
                      disabled={locked && !isPlaying}
                      onClick={() => requestSong(i)}
                      data-live-song={it.title}
                      className={`flex w-full items-start gap-3 border-b border-ink-900 px-4 py-3 text-left disabled:opacity-50 ${
                        isPlaying ? "bg-go-500/15" : i === cued ? "bg-ink-850" : "hover:bg-ink-900"
                      }`}
                    >
                      <span className={`mt-0.5 w-6 shrink-0 text-right font-mono text-sm ${isPlaying ? "text-go-400" : "text-ink-400"}`}>{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-base font-semibold ${isPlaying ? "text-go-400" : "text-ink-100"}`}>{it.title}</span>
                        <span className="block text-xs text-ink-400">
                          {[it.songKey, it.targetBpm ?? it.originalBpm ? `${formatBpm((it.targetBpm ?? it.originalBpm)!)} BPM` : "", it.durationSec ? formatTime(it.durationSec, 0) : ""].filter(Boolean).join(" · ")}
                        </span>
                        {it.notes && <span className="mt-1 block text-xs text-live-400">{it.notes}</span>}
                      </span>
                      {isPlaying && <span className="text-[10px] font-bold uppercase text-go-400">{playing ? "▶ sonando" : loadingSong ? "cargando" : "lista"}</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-400">
              {keyLabel(shortcuts.prevSong)} / {keyLabel(shortcuts.nextSong)} para moverte · Intro para abrirla. Nunca pasa sola a la siguiente.
            </p>
          </aside>

          {/* Now playing */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-start gap-4 px-6 pt-4">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-3xl font-bold" data-live-title>
                  {song && view.loaded ? song.title : loadingSong ? "Cargando…" : "Elige una canción del setlist"}
                </h2>
                {song && view.loaded && (
                  <p className="mt-1 text-sm text-ink-300">
                    {[song.artist, song.songKey ? `Tono ${song.songKey}` : "", view.bpm ? `${formatBpm(song.targetBpm ?? view.bpm)} BPM` : "", song.timeSignature].filter(Boolean).join(" · ")}
                  </p>
                )}
                {song?.notes && view.loaded && <p className="mt-2 text-sm text-live-400">{song.notes}</p>}
              </div>
              <Clock studio={studio} bpm={view.bpm} downbeat={view.downbeat} beats={view.beats} />
            </div>

            {/* Current and next part */}
            <div className="grid grid-cols-2 gap-4 px-6 pt-3">
              <div className="rounded-xl border border-ink-800 bg-ink-950 px-5 py-2" style={{ borderLeft: `6px solid ${currentPart ? SECTION_COLORS[currentPart.kind] : "#333"}` }}>
                <span className="text-xs uppercase tracking-wider text-ink-400">Ahora</span>
                <span className="block truncate text-2xl font-bold" data-live-part>
                  {currentPart?.label ?? "—"}
                </span>
              </div>
              <div className="rounded-xl border border-ink-800 bg-ink-950 px-5 py-2">
                <span className="text-xs uppercase tracking-wider text-ink-400">{pending ? "Salto programado" : "Después"}</span>
                <span className={`block truncate text-2xl font-bold ${pending ? "animate-pulse text-live-400" : "text-ink-300"}`} data-live-next>
                  {pending ? `→ ${sections.find((s) => Math.abs(s.startSec - pending.targetSec) < 0.01)?.label ?? formatTime(pending.targetSec, 0)}` : nextPart?.label ?? "Final"}
                </span>
              </div>
            </div>

            {/* Parts: click = jump (bar-synchronous by default) */}
            <div className="flex gap-2 overflow-x-auto px-6 pb-1 pt-3" aria-label="Partes de la canción">
              {sections.map((s, i) => {
                const isCurrent = i === view.current;
                const isTarget = !!pending && Math.abs(pending.targetSec - s.startSec) < 0.01;
                return (
                  <button
                    key={`${s.startSec}-${i}`}
                    type="button"
                    data-live-jump={s.label}
                    onClick={() => void jumpTo(s.startSec)}
                    className={`min-w-[104px] shrink-0 rounded-lg border-2 px-4 py-2 text-left text-base font-bold transition-colors ${
                      isTarget ? "animate-pulse border-live-400 bg-live-500/20" : isCurrent ? "border-white bg-white/10" : "border-transparent bg-ink-900 hover:bg-ink-850"
                    }`}
                    style={{ borderBottom: `4px solid ${SECTION_COLORS[s.kind]}` }}
                  >
                    {s.label}
                    <span className="block font-mono text-[10px] font-normal text-ink-400">{formatTime(s.startSec, 0)}</span>
                  </button>
                );
              })}
            </div>

            {/* Transport */}
            <div className="flex items-center gap-3 px-6 py-3">
              <button type="button" aria-label="Al principio" onClick={() => studio.seek(0)} disabled={!view.loaded} className="rounded-xl bg-ink-900 p-4 text-ink-100 hover:bg-ink-850 disabled:opacity-40">
                <SkipBack size={26} />
              </button>
              <button
                type="button"
                aria-label={playing ? "Pausar" : "Reproducir"}
                onClick={() => studio.togglePlay()}
                disabled={!view.loaded}
                className={`rounded-2xl px-10 py-4 text-white disabled:opacity-40 ${playing ? "bg-info-500 hover:bg-info-400" : "bg-go-500 hover:bg-go-400"}`}
              >
                {playing ? <Pause size={34} /> : <Play size={34} />}
              </button>
              <button
                type="button"
                aria-label="Detener"
                onClick={stop}
                disabled={!view.loaded || locked}
                className={`rounded-xl p-4 disabled:opacity-40 ${confirmStop ? "bg-stop-500 text-white" : "bg-ink-900 text-ink-100 hover:bg-ink-850"}`}
              >
                <Square size={26} />
              </button>
              {confirmStop && <span className="text-sm text-stop-500">Pulsa otra vez para detener · Esc cancela</span>}
              <button
                type="button"
                aria-pressed={loopingCurrent}
                aria-label="Repetir la parte"
                onClick={() => void toggleLoop()}
                disabled={!currentPart}
                className={`ml-4 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold disabled:opacity-40 ${loopingCurrent ? "bg-live-500 text-black" : "bg-ink-900 text-ink-100 hover:bg-ink-850"}`}
              >
                <Repeat size={18} /> {loopingCurrent ? `Repitiendo ${currentPart?.label}` : "Repetir parte"}
              </button>
              {(pending || loop) && (
                <button type="button" onClick={() => void cancel()} className="rounded-xl border border-ink-700 px-3 py-3 text-sm text-ink-200 hover:border-ink-500">
                  Cancelar {pending ? "salto" : "bucle"} ({keyLabel(shortcuts.cancelJump)})
                </button>
              )}
              <span className="ml-auto text-[11px] text-ink-400">
                {keyLabel(shortcuts.playPause)} reproducir · {keyLabel(shortcuts.prevPart)} {keyLabel(shortcuts.nextPart)} partes · {keyLabel(shortcuts.loopPart)} bucle
              </span>
            </div>

            {/* Mixer: changes are for this moment unless saved */}
            <div className={`mt-auto flex min-h-0 flex-col border-t border-ink-800 ${locked ? "pointer-events-none opacity-60" : ""}`} style={{ height: 346 }} aria-disabled={locked}>
              <div className="flex h-7 shrink-0 items-center justify-end gap-2 bg-ink-950 px-3">
                {studio.mixDirty && <span className="text-xs text-live-400">Mezcla cambiada solo para ahora</span>}
                <button
                  type="button"
                  disabled={!studio.mixDirty}
                  onClick={() => studio.restoreMix()}
                  className="flex items-center gap-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 hover:border-ink-500 disabled:opacity-40"
                >
                  <RotateCcw size={12} /> Volver a la guardada
                </button>
                <button
                  type="button"
                  disabled={!studio.mixDirty}
                  onClick={() => void studio.saveMix().catch(fail)}
                  className="flex items-center gap-1 rounded-md bg-info-500 px-2 py-1 text-xs font-semibold text-white hover:bg-info-400 disabled:opacity-40"
                >
                  <Save size={12} /> Guardar mezcla
                </button>
              </div>
              <div className="min-h-0 flex-1">
              {view.loaded ? (
                <Mixer
                  tracks={view.mixerTracks}
                  volumesDb={studio.mixer.volumesDb}
                  mute={studio.mixer.mute}
                  solo={studio.mixer.solo}
                  meters={studio.meters}
                  masterDb={gainToDb(mainGain)}
                  monitorDb={gainToDb(monitorGain)}
                  limiting={{ main: (transport?.mainLimiterGain ?? 1) < 0.999, monitor: (transport?.monitorLimiterGain ?? 1) < 0.999 }}
                  onVolume={studio.setTrackVolume}
                  onMute={studio.toggleMute}
                  onSolo={studio.toggleSolo}
                  onMaster={(db) => studio.setOutput({ mode: outputMode, monitorGain, mainGain: dbToGain(db) })}
                  onMonitor={(db) => studio.setOutput({ mode: outputMode, monitorGain: dbToGain(db), mainGain })}
                  onReorder={view.reorderMixer}
                />
              ) : (
                <p className="p-6 text-sm text-ink-400">El mezclador aparece al abrir una canción.</p>
              )}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* Confirm switching songs while one plays */}
      {confirmSwitch !== null && items[confirmSwitch] && (
        <div role="dialog" aria-label="Cambiar de canción" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[420px] rounded-2xl border border-ink-700 bg-ink-900 p-6 text-center">
            <p className="text-lg font-semibold">¿Cambiar a «{items[confirmSwitch].title}»?</p>
            <p className="mt-1 text-sm text-ink-300">La canción que suena se detendrá.</p>
            <div className="mt-5 flex justify-center gap-3">
              <button type="button" onClick={() => setConfirmSwitch(null)} className="rounded-lg border border-ink-600 px-4 py-2 text-sm">
                Seguir con esta (Esc)
              </button>
              <button type="button" onClick={() => loadIndex(confirmSwitch)} className="rounded-lg bg-info-500 px-4 py-2 text-sm font-semibold text-white">
                Cambiar (Intro)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
