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
  /** Built with the Steinberg ASIO SDK (Windows). */
  asioSupported?: boolean;
}

// ---- Phase 4: audio devices ----------------------------------------------------

/** A device chosen by the user (sampleRate / bufferSize 0 = device default). */
export interface DeviceChoice {
  typeName: string;
  deviceName: string;
  sampleRate: number;
  bufferSize: number;
}

export interface DeviceCapabilities {
  typeName: string;
  deviceName: string;
  available: boolean;
  sampleRates: number[];
  bufferSizes: number[];
  defaultBufferSize: number | null;
  outputChannelNames: string[];
  hasControlPanel: boolean;
}

/** First physical output (0-based) of each bus. */
export interface OutputChannels {
  main: number;
  monitor: number;
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
  // Phase 4
  outputChannelNames?: string[];
  sampleRates?: number[];
  bufferSizes?: number[];
  hasControlPanel?: boolean;
  /** Dropouts reported by the driver (-1 = it does not report them). */
  xruns?: number | null;
  cpuLoad?: number;
  /** Dropouts of the engine (render fell behind). */
  underruns?: number;
  mainChannel?: number;
  monitorChannel?: number;
  outputMode?: number;
  asioSupported?: boolean;
  /** The song is being converted to a new sample rate. */
  reloading?: boolean;
  deviceEvents?: number;
  lastDeviceEvent?: string;
  preferred?: DeviceChoice | null;
  usingPreferred?: boolean | null;
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
  /** Next song decoded ahead of time (setlists). */
  preload?: { state: "idle" | "loading" | "ready" | "skipped" | "error"; tracks: number; memoryMb?: number | null } | null;
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
  /** Where the track is shown (0 = top); the user can drag tracks. */
  displayOrder: number;
  /** Where its strip is in the mixer (0 = left); independent of displayOrder. */
  mixerOrder: number;
  /** Saved mixer settings. */
  volumeDb: number;
  muted: boolean;
  soloed: boolean;
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
  artist: string;
  songKey: string;
  notes: string;
  /** Semitones the song is played in (0 = recorded key). */
  transpose: number;
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
  /** Scheduled seamless jump (song seconds). */
  pendingJump: { atSec: number; targetSec: number } | null;
  /** Active loop [start, end) in song seconds. */
  loopRange: [number, number] | null;
  /** How far ahead a jump must be scheduled right now. */
  minJumpLeadSec: number;
  jumpsDone: number;
  /** Key change of the music tracks (semitones). */
  transpose: number;
}

// ---- Phase 5: Song Editor, setlists, backup -----------------------------------

export interface SongDetails {
  title: string;
  artist: string;
  songKey: string;
  notes: string;
  timeSignature: TimeSignature;
}

export interface SetlistSummary {
  id: number;
  name: string;
  eventDate: string;
  place: string;
  songCount: number;
  totalSec: number;
  updatedAt: string;
}

export interface SetlistItem {
  songId: number;
  notes: string;
  /** Key for this setlist only (null = the song's own). */
  transpose: number | null;
  songTranspose: number;
  title: string;
  artist: string;
  songKey: string;
  originalBpm: number | null;
  targetBpm: number | null;
  timeSignature: TimeSignature;
  durationSec: number | null;
}

export interface SetlistRecord {
  id: number;
  name: string;
  eventDate: string;
  place: string;
  notes: string;
  items: SetlistItem[];
}

export interface SetlistInput {
  name: string;
  eventDate: string;
  place: string;
  notes: string;
  items: { songId: number; notes: string; transpose: number | null }[];
}

export interface BackupReport {
  songs: number;
  setlists: number;
  skippedSongs: number;
  missingFiles: string[];
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
  /** PA (instruments) master volume, linear. */
  mainGain: number;
}

export interface TrackMix {
  volumeDb: number;
  muted: boolean;
  soloed: boolean;
}

/** One row of the song library. */
export interface LibrarySong {
  id: number;
  title: string;
  artist: string;
  songKey: string;
  transpose: number;
  originalBpm: number | null;
  targetBpm: number | null;
  timeSignature: TimeSignature;
  durationSec: number | null;
  trackCount: number;
  sectionCount: number;
  sourceArchive: string | null;
  createdAt: string;
  lastOpenedAt: string;
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
  /** Key of the recording (optional). */
  songKey?: string | null;
  bpm: number | null;
  timeSignature: TimeSignature;
  sourceArchive: string | null;
  tracks: ImportTrack[];
}
