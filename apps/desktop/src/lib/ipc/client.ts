import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AudioDiagnostics,
  DeviceCapabilities,
  DeviceChoice,
  OutputChannels,
  BackupReport,
  SetlistInput,
  SetlistRecord,
  SetlistSummary,
  SongDetails,
  DatabaseStatus,
  EngineInfo,
  EnginePing,
  IpcError,
  ImportCommit,
  ImportDraft,
  ImportTrack,
  Meters,
  LibrarySong,
  TrackMix,
  OutputInfo,
  OutputSettings,
  TrackRole,
  TimeSignature,
  SectionRecord,
  SongRecord,
  SongSummary,
  SongTempo,
  StudioStatus,
  TransportState,
} from "./types";

/**
 * Thrown when the UI is opened outside the Tauri shell (e.g. plain `vite` in a
 * browser). We never fake backend data: the UI shows "no native connection".
 */
export class NativeUnavailableError extends Error {
  constructor() {
    super("El backend nativo no está disponible (la UI se ejecuta fuera de Tauri).");
    this.name = "NativeUnavailableError";
  }
}

export class BackendError extends Error {
  readonly code: string;
  constructor(err: IpcError) {
    super(err.message);
    this.name = "BackendError";
    this.code = err.code;
  }
}

function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new NativeUnavailableError();
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    if (isIpcError(e)) throw new BackendError(e);
    throw new BackendError({ code: "unknown", message: String(e) });
  }
}

/** Typed wrappers for every backend command. Single entry point for IPC. */
export const backend = {
  appInfo: () => call<AppInfo>("app_info"),
  engineInfo: () => call<EngineInfo>("engine_info"),
  enginePing: (value: number) => call<EnginePing>("engine_ping", { value }),
  audioDiagnostics: () => call<AudioDiagnostics>("audio_diagnostics"),
  audioDescribeDevice: (typeName: string, deviceName: string) =>
    call<DeviceCapabilities>("audio_describe_device", { typeName, deviceName }),
  audioSetDevice: (choice: DeviceChoice) => call<OutputInfo>("audio_set_device", { choice }),
  audioSetChannels: (channels: OutputChannels) => call<OutputInfo>("audio_set_channels", { channels }),
  audioTestTone: (channel: number) => call<void>("audio_test_tone", { channel }),
  audioShowPanel: () => call<void>("audio_show_panel"),
  databaseStatus: () => call<DatabaseStatus>("database_status"),

  // Multitrack Studio
  studioOpenFiles: (paths: string[]) => call<SongRecord>("studio_open_files", { paths }),
  studioOpenSong: (songId: number) => call<SongRecord>("studio_open_song", { songId }),
  studioRecentSongs: () => call<SongSummary[]>("studio_recent_songs"),
  studioGetSong: (songId: number) => call<SongRecord | null>("studio_get_song", { songId }),
  studioStatus: () => call<StudioStatus>("studio_status"),
  /** Waveform overview, LP_PEAKS_PER_SECOND (100) bytes per second, 0..255. */
  studioPeaks: async (track: number) => new Uint8Array(await call<ArrayBuffer>("studio_peaks", { track })),
  studioDetectSections: (bpm: number, downbeatOffsetSec: number, beatsPerBar: number) =>
    call<void>("studio_detect_sections", { bpm, downbeatOffsetSec, beatsPerBar }),
  studioUpdateTrack: (songId: number, position: number, name: string, role: TrackRole) =>
    call<SongRecord>("studio_update_track", { songId, position, name, role }),
  studioSetSongInfo: (songId: number, title: string, timeSignature: TimeSignature) =>
    call<void>("studio_set_song_info", { songId, title, timeSignature }),
  studioReorderTracks: (songId: number, positions: number[]) => call<void>("studio_reorder_tracks", { songId, positions }),
  studioReorderMixer: (songId: number, positions: number[]) => call<void>("studio_reorder_mixer", { songId, positions }),
  studioSetTrackMix: (songId: number, position: number, mix: TrackMix) => call<void>("studio_set_track_mix", { songId, position, mix }),

  // Song library
  librarySongs: () => call<LibrarySong[]>("library_songs"),
  libraryRename: (songId: number, title: string) => call<void>("library_rename", { songId, title }),
  /** Returns how many audio files were deleted (only files inside LIVEPLAYER's library folder). */
  libraryDelete: (songId: number) => call<number>("library_delete", { songId }),
  studioSetTrackGain: (track: number, gain: number) => call<void>("studio_set_track_gain", { track, gain }),
  studioOutputSettings: () => call<OutputSettings>("studio_output_settings"),
  studioSetOutput: (settings: OutputSettings) => call<void>("studio_set_output", { settings }),

  // Import (zip / folder / files)
  importInspect: (paths: string[]) => call<ImportDraft>("studio_import_inspect", { paths }),
  importPreview: (tracks: ImportTrack[]) => call<void>("studio_import_preview", { tracks }),
  importCommit: (commit: ImportCommit) => call<SongRecord>("studio_import_commit", { commit }),
  importCancel: (extractedDir: string | null) => call<void>("studio_import_cancel", { extractedDir }),
  studioSaveSections: (songId: number, sections: SectionRecord[]) =>
    call<void>("studio_save_sections", { songId, sections }),
  studioSaveTempo: (songId: number, tempo: SongTempo) => call<void>("studio_save_tempo", { songId, tempo }),
  outputInfo: () => call<OutputInfo>("output_info"),

  // Transport
  play: () => call<void>("transport_play"),
  pause: () => call<void>("transport_pause"),
  stop: () => call<void>("transport_stop"),
  seek: (positionSec: number) => call<void>("transport_seek", { positionSec }),
  setMasterGain: (gain: number) => call<void>("transport_set_master_gain", { gain }),
  setTempoRatio: (ratio: number) => call<void>("transport_set_tempo_ratio", { ratio }),
  transportState: () => call<TransportState>("transport_state"),
  scheduleJump: (atSec: number, targetSec: number) => call<void>("transport_schedule_jump", { atSec, targetSec }),
  cancelJump: () => call<void>("transport_cancel_jump"),
  setLoop: (startSec: number, endSec: number) => call<void>("transport_set_loop", { startSec, endSec }),
  preloadSong: (songId: number | null) => call<void>("studio_preload_song", { songId }),

  // Song Editor
  setSongDetails: (songId: number, details: SongDetails) => call<void>("studio_set_song_details", { songId, details }),

  // Setlists
  setlists: () => call<SetlistSummary[]>("setlist_list"),
  setlist: (id: number) => call<SetlistRecord>("setlist_get", { id }),
  createSetlist: (input: SetlistInput) => call<number>("setlist_create", { input }),
  saveSetlist: (id: number, input: SetlistInput) => call<void>("setlist_save", { id, input }),
  deleteSetlist: (id: number) => call<void>("setlist_delete", { id }),
  duplicateSetlist: (id: number) => call<number>("setlist_duplicate", { id }),

  // Preferences and backup
  uiSetting: <T>(key: "shortcuts" | "live.lastSetlist") => call<T | null>("ui_setting_get", { key }),
  setUiSetting: (key: "shortcuts" | "live.lastSetlist", value: unknown) => call<void>("ui_setting_set", { key, value }),
  backupExport: (path: string) => call<BackupReport>("backup_export", { path }),
  backupImport: (path: string) => call<BackupReport>("backup_import", { path }),
  studioMeters: () => call<Meters>("studio_meters"),
};

export const isNativeAvailable = (): boolean => isTauri();
