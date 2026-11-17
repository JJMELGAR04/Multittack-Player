use std::time::Instant;

use liveplayer_engine::{AudioDiagnostics, Engine, EngineInfo};
use serde::Serialize;
use tauri::State;

use crate::error::CommandResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnginePing {
    sent: i64,
    received: i64,
    native_micros: u128,
}

#[tauri::command]
pub fn engine_info() -> CommandResult<EngineInfo> {
    Ok(liveplayer_engine::engine_info())
}

#[tauri::command]
pub fn engine_ping(engine: State<'_, Engine>, value: i64) -> CommandResult<EnginePing> {
    let started = Instant::now();
    let received = engine.ping(value)?;
    Ok(EnginePing { sent: value, received, native_micros: started.elapsed().as_micros() })
}

#[tauri::command]
pub fn audio_diagnostics(engine: State<'_, Engine>) -> CommandResult<AudioDiagnostics> {
    Ok(engine.audio_diagnostics()?)
}
