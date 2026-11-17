//! Phase 5: Song Editor details, setlists, Live Mode (bar-synchronous jumps,
//! loops, preloading the next song) and general preferences.

use liveplayer_db::{SetlistInput, SetlistRecord, SetlistSummary, SongDetails};
use liveplayer_engine::Engine;
use tauri::State;

use crate::commands::database::DbState;
use crate::commands::studio::{lock, track_requests};
use crate::error::{CommandError, CommandResult};

// ---- Transport: musical jumps and loops ---------------------------------------

/// Seamless jump at song second `at_sec` to `target_sec` (the UI picks the next bar line).
#[tauri::command]
pub fn transport_schedule_jump(engine: State<'_, Engine>, at_sec: f64, target_sec: f64) -> CommandResult<()> {
    Ok(engine.schedule_jump(at_sec, target_sec)?)
}

#[tauri::command]
pub fn transport_cancel_jump(engine: State<'_, Engine>) -> CommandResult<()> {
    Ok(engine.cancel_jump()?)
}

/// Loops [start, end) without gaps; `end <= start` turns the loop off.
#[tauri::command]
pub fn transport_set_loop(engine: State<'_, Engine>, start_sec: f64, end_sec: f64) -> CommandResult<()> {
    Ok(engine.set_loop(start_sec, end_sec)?)
}

/// Decodes a library song in the background so that opening it is instant
/// (the next song of a setlist). `None` forgets the preloaded song.
#[tauri::command]
pub fn studio_preload_song(engine: State<'_, Engine>, db: State<'_, DbState>, song_id: Option<i64>) -> CommandResult<()> {
    let Some(id) = song_id else {
        return Ok(engine.preload_song(&[])?);
    };
    let song = lock(&db)?.get_song(id)?.ok_or_else(|| CommandError::invalid(format!("no existe la canción {id}")))?;
    if song.tracks.iter().any(|t| !std::path::Path::new(&t.file_path).is_file()) {
        return Ok(()); // missing files: it will report the error when opened
    }
    Ok(engine.preload_song(&track_requests(&song))?)
}

// ---- Song Editor -------------------------------------------------------------

#[tauri::command]
pub fn studio_set_song_details(db: State<'_, DbState>, song_id: i64, details: SongDetails) -> CommandResult<()> {
    Ok(lock(&db)?.set_song_details(song_id, &details)?)
}

// ---- Setlists ----------------------------------------------------------------

#[tauri::command]
pub fn setlist_list(db: State<'_, DbState>) -> CommandResult<Vec<SetlistSummary>> {
    Ok(lock(&db)?.setlists()?)
}

#[tauri::command]
pub fn setlist_get(db: State<'_, DbState>, id: i64) -> CommandResult<SetlistRecord> {
    lock(&db)?.get_setlist(id)?.ok_or_else(|| CommandError::invalid(format!("no existe el setlist {id}")))
}

#[tauri::command]
pub fn setlist_create(db: State<'_, DbState>, input: SetlistInput) -> CommandResult<i64> {
    Ok(lock(&db)?.create_setlist(&input)?)
}

#[tauri::command]
pub fn setlist_save(db: State<'_, DbState>, id: i64, input: SetlistInput) -> CommandResult<()> {
    Ok(lock(&db)?.save_setlist(id, &input)?)
}

#[tauri::command]
pub fn setlist_delete(db: State<'_, DbState>, id: i64) -> CommandResult<()> {
    Ok(lock(&db)?.delete_setlist(id)?)
}

#[tauri::command]
pub fn setlist_duplicate(db: State<'_, DbState>, id: i64) -> CommandResult<i64> {
    Ok(lock(&db)?.duplicate_setlist(id)?)
}

// ---- Preferences -------------------------------------------------------------

/// Preferences the UI may read and write (JSON values). Anything else is refused.
const UI_SETTINGS: &[&str] = &["shortcuts", "live.lastSetlist"];

#[tauri::command]
pub fn ui_setting_get(db: State<'_, DbState>, key: String) -> CommandResult<Option<serde_json::Value>> {
    if !UI_SETTINGS.contains(&key.as_str()) {
        return Err(CommandError::invalid(format!("preferencia desconocida: {key}")));
    }
    Ok(lock(&db)?.get_setting(&key)?.and_then(|v| serde_json::from_str(&v).ok()))
}

#[tauri::command]
pub fn ui_setting_set(db: State<'_, DbState>, key: String, value: serde_json::Value) -> CommandResult<()> {
    if !UI_SETTINGS.contains(&key.as_str()) {
        return Err(CommandError::invalid(format!("preferencia desconocida: {key}")));
    }
    let json = value.to_string();
    if json.len() > 16_384 {
        return Err(CommandError::invalid("preferencia demasiado grande"));
    }
    Ok(lock(&db)?.set_setting(&key, &json)?)
}
