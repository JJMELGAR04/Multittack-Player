//! Audio device selection (phase 4): driver, device, sample rate, buffer and
//! which physical outputs carry the band and the click. Everything chosen here
//! is saved and reapplied when the app starts.

use liveplayer_db::Database;
use liveplayer_engine::{DeviceCapabilities, DeviceChoice, Engine, OutputInfo};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::database::DbState;
use crate::commands::studio::lock;
use crate::error::{CommandError, CommandResult};

const DEVICE_KEY: &str = "audio.device";
const CHANNELS_KEY: &str = "output.channels";

/// First physical output (0-based) of each bus.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputChannels {
    pub main: i32,
    pub monitor: i32,
}

fn saved_device(db: &Database) -> Option<DeviceChoice> {
    db.get_setting(DEVICE_KEY).ok().flatten().and_then(|v| serde_json::from_str(&v).ok())
}

pub(crate) fn saved_channels(db: &Database) -> Option<OutputChannels> {
    db.get_setting(CHANNELS_KEY).ok().flatten().and_then(|v| serde_json::from_str(&v).ok())
}

fn save_channels(db: &Database, info: &OutputInfo) {
    let ch = OutputChannels { main: info.main_channel as i32, monitor: info.monitor_channel as i32 };
    if let Ok(json) = serde_json::to_string(&ch) {
        let _ = db.set_setting(CHANNELS_KEY, &json);
    }
}

/// Opens the saved device (or the default output) at start-up. If the saved
/// interface is not connected the engine uses the default output and reopens
/// it by itself when it is plugged in.
pub(crate) fn apply_saved_device(engine: &Engine, db: &Database) {
    match saved_device(db) {
        Some(choice) => {
            if engine.set_audio_device(&choice).is_err() {
                let _ = engine.open_default_output();
            }
        }
        None => {
            let _ = engine.open_default_output();
        }
    }
}

/// Reapplies the saved bus outputs (after the output mode is set).
pub(crate) fn apply_saved_channels(engine: &Engine, db: &Database) {
    if let Some(ch) = saved_channels(db) {
        let _ = engine.set_output_channels(ch.main, ch.monitor);
    }
}

#[tauri::command]
pub fn audio_describe_device(engine: State<'_, Engine>, type_name: String, device_name: String) -> CommandResult<DeviceCapabilities> {
    Ok(engine.describe_device(&type_name, &device_name)?)
}

#[tauri::command]
pub fn audio_set_device(engine: State<'_, Engine>, db: State<'_, DbState>, choice: DeviceChoice) -> CommandResult<OutputInfo> {
    if choice.type_name.trim().is_empty() || choice.device_name.trim().is_empty() {
        return Err(CommandError::invalid("elige un controlador y un dispositivo"));
    }
    if !(0.0..=384_000.0).contains(&choice.sample_rate) || !(0..=16_384).contains(&choice.buffer_size) {
        return Err(CommandError::invalid("frecuencia o búfer fuera de rango"));
    }
    engine.set_audio_device(&choice)?;
    let db = lock(&db)?;
    db.set_setting(DEVICE_KEY, &serde_json::to_string(&choice).map_err(|e| CommandError::invalid(e.to_string()))?)?;
    // The new device may have fewer outputs: keep what the engine settled on.
    apply_saved_channels(&engine, &db);
    let info = engine.output_info()?;
    save_channels(&db, &info);
    Ok(info)
}

#[tauri::command]
pub fn audio_set_channels(engine: State<'_, Engine>, db: State<'_, DbState>, channels: OutputChannels) -> CommandResult<OutputInfo> {
    engine.open_default_output()?;
    engine.set_output_channels(channels.main, channels.monitor)?;
    let info = engine.output_info()?;
    save_channels(&*lock(&db)?, &info);
    Ok(info)
}

#[tauri::command]
pub fn audio_test_tone(engine: State<'_, Engine>, channel: i32) -> CommandResult<()> {
    Ok(engine.test_tone(channel)?)
}

#[tauri::command]
pub fn audio_show_panel(engine: State<'_, Engine>) -> CommandResult<()> {
    Ok(engine.show_device_panel()?)
}
