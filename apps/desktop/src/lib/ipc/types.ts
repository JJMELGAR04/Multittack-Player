/**
 * IPC contract between the React frontend and the Tauri (Rust) backend.
 *
 * These types MUST stay in sync with the serde structs in
 * `src-tauri/src/commands/*.rs`. Field names are camelCase on both sides
 * (`#[serde(rename_all = "camelCase")]`).
 */

export interface AppInfo {
  appName: string;
  appVersion: string;
  /** Operating system reported by Rust (`windows`, `macos`, `linux`, `android`, `ios`). */
  os: string;
  arch: string;
}

export interface EngineInfo {
  /** Version of the LIVEPLAYER native engine (C++). */
  engineVersion: string;
  /** Version of the C ABI exposed by the engine. Bumped on breaking changes. */
  abiVersion: number;
  /** JUCE framework version the engine was compiled against. */
  juceVersion: string;
  /** `Debug` or `Release`. */
  buildType: string;
}

export interface EnginePing {
  /** Value sent to the engine. */
  sent: number;
  /** Value returned by the engine (must be `sent + 1`). */
  received: number;
  /** Round-trip time measured in Rust around the native call, in microseconds. */
  nativeMicros: number;
}

export interface AudioDeviceType {
  /** Driver/backend name as reported by JUCE (e.g. `Windows Audio`, `ASIO`, `CoreAudio`). */
  name: string;
  outputDevices: string[];
}

export interface AudioDiagnostics {
  deviceTypes: AudioDeviceType[];
}

export interface DatabaseStatus {
  path: string;
  schemaVersion: number;
  tables: string[];
  sqliteVersion: string;
}

/** Error shape returned by every backend command (see `src-tauri/src/error.rs`). */
export interface IpcError {
  code: string;
  message: string;
}

// ---- Phase 2: output device, songs, transport ------------------------------

export interface OutputInfo {
  open: boolean;
  typeName?: string;
  deviceName?: string;
  sampleRate?: number;
  bufferSize?: number;
  outputChannels?: number;
  outputLatencyMs?: number;
}

export interface LoadedTrack {
  name: string;
  path: string;
  format: string;
  sourceSampleRate: number;
  channels: number;
  durationSec: number;
  /** Converted to the device sample rate (r8brain, high quality). */
  resampled: boolean;
  role: "music" | "click" | "guide";
  bus: Bus;
}

/** `main` = instruments (PA), `monitor` = click and cues (band in-ears only). */
export type Bus = "main" | "monitor";

export type TrackRole =
  | "drums"
  | "percussion"
  | "bass"
  | "electric_guitar"
  | "acoustic_guitar"
  | "piano"
  | "keys"
  | "pads"
  | "synth"
  | "strings"
  | "brass"
  | "lead_vocal"
  | "backing_vocals"
  | "loops"
  | "backing_track"
  | "click"
  | "cues"
  | "other";

export type TimeSignature = "2/4" | "3/4" | "4/4" | "5/4" | "6/8" | "12/8";

export interface LoadedSong {
  sampleRate: number;
  durationSec: number;
  memoryMB: number;
  beatsPerBar: number;
  /** Automatic level trim (dB, <= 0) so the summed stems never clip. */
  mainTrimDb: number;
  monitorTrimDb: number;
  tracks: LoadedTrack[];
}

export interface DetectedTempo {
  bpm: number;
  confidence: number;
  beatOffsetSec: number;
  downbeatOffsetSec: number;
  /** `click` (from the click track), `mix` (from the music) or `user`. */
  source: string;
}

export type SectionKind =
  | "intro"
  | "verse"
  | "prechorus"
  | "chorus"
  | "bridge"
  | "interlude"
  | "outro"
  | "section";

export interface DetectedSection {
  startSec: number;
  endSec: number;
  kind: SectionKind;
  label: string;
  confidence: number;
}

export interface SongAnalysis {
  state: "pending" | "running" | "done" | "error";
  /** Increments every time an analysis finishes. */
  revision: number;
  tempo?: DetectedTempo | null;
  sections: DetectedSection[];
}

export interface EngineSongStatus {
  state: "idle" | "loading" | "ready" | "error";
  progress: number;
  error: string;
  loadId: number;
  song?: LoadedSong | null;
  analysis?: SongAnalysis | null;
}

export interface StudioStatus {
  songId: number | null;
  engine: EngineSongStatus;
}

export interface TrackRecord {
  position: number;
  name: string;
  filePath: string;
  role: TrackRole;
  bus: Bus;
}

export interface SectionRecord {
  startSec: number;
  kind: SectionKind;
  label: string;
  source: "auto" | "user";
}

export interface SongTempo {
  originalBpm: number | null;
  bpmSource: "none" | "detected" | "user";
  downbeatOffsetSec: number;
  targetBpm: number | null;
}

export interface SongRecord extends SongTempo {
  id: number;
  title: string;
  sectionsInitialized: boolean;
  timeSignature: TimeSignature;
  sourceArchive: string | null;
  lastOpenedAt: string;
  tracks: TrackRecord[];
  sections: SectionRecord[];
}

export interface SongSummary {
  id: number;
  title: string;
  trackCount: number;
  lastOpenedAt: string;
}

export interface TransportState {
  playState: "stopped" | "playing" | "paused";
  ended: boolean;
  stretching: boolean;
  deviceXruns: number | null;
  positionSec: number;
  durationSec: number;
  tempoRatio: number;
  masterGain: number;
  audioLoad: number;
  renderLoad: number;
  underruns: number;
  outputMode: OutputMode;
  outputChannels: number;
  monitorGain: number;
  /** Safety limiter gain per bus (1 = idle). */
  mainLimiterGain: number;
  monitorLimiterGain: number;
}

/** Peak levels (linear) since the previous read. */
export interface Meters {
  tracks: number[];
  main: [number, number];
  monitor: [number, number];
}

/** stereo: everything on 1/2 · split: instruments out 1, click+cues out 2 · quad: 1/2 + 3/4. */
export type OutputMode = "stereo" | "split" | "quad";

export interface OutputSettings {
  mode: OutputMode;
  monitorGain: number;
}

// ---- Import ------------------------------------------------------------------

export interface ImportFile {
  filePath: string;
  fileName: string;
  suggestedName: string;
  suggestedRole: TrackRole;
  /** false: the file name did not say what it is. */
  recognized: boolean;
  sizeBytes: number;
}

export interface ImportDraft {
  sourceKind: "zip" | "folder" | "files";
  sourcePath: string | null;
  extractedDir: string | null;
  suggestedTitle: string;
  suggestedBpm: number | null;
  suggestedTimeSignature: TimeSignature;
  files: ImportFile[];
  existingSongId: number | null;
}

export interface ImportTrack {
  filePath: string;
  name: string;
  role: TrackRole;
}

export interface ImportCommit {
  title: string;
  bpm: number | null;
  timeSignature: TimeSignature;
  sourceArchive: string | null;
  tracks: ImportTrack[];
}
