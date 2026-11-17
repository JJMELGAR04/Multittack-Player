import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AudioDiagnostics,
  DatabaseStatus,
  EngineInfo,
  EnginePing,
  IpcError,
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
  databaseStatus: () => call<DatabaseStatus>("database_status"),
};

export const isNativeAvailable = (): boolean => isTauri();
