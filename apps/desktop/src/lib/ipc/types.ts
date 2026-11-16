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
