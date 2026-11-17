//! LIVEPLAYER desktop shell: wires the UI (IPC) to the native engine and the
//! database. Business logic lives in `crates/`, not here.

mod commands;
mod error;

use std::sync::Mutex;

use liveplayer_db::Database;
use liveplayer_engine::Engine;
use tauri::Manager;

const DB_FILE_NAME: &str = "liveplayer.sqlite3";

/// Where the database and the imported songs live. `LIVEPLAYER_DATA_DIR`
/// overrides it (used by the automated tests so they never touch the user's
/// library).
pub(crate) fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, tauri::Error> {
    match std::env::var_os("LIVEPLAYER_DATA_DIR") {
        Some(dir) if !dir.is_empty() => Ok(std::path::PathBuf::from(dir)),
        _ => app.path().app_data_dir(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // `setup` runs on the main thread: the engine's control thread.
            let engine = Engine::new()?;
            app.manage(engine);

            let data_dir = data_dir(app.handle())?;
            let db = Database::open(data_dir.join(DB_FILE_NAME))?;
            // The saved audio interface (or the default output) opens now, so
            // Audio Settings and the test tone work before any song is loaded.
            if let Some(engine) = app.try_state::<Engine>() {
                commands::audio::apply_saved_device(&engine, &db);
                commands::studio::apply_output_settings(&engine, &db);
            }
            app.manage(Mutex::new(db));
            app.manage(commands::studio::CurrentSong::default());
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::engine::engine_info,
            commands::engine::engine_ping,
            commands::engine::audio_diagnostics,
            commands::audio::audio_describe_device,
            commands::audio::audio_set_device,
            commands::audio::audio_set_channels,
            commands::audio::audio_test_tone,
            commands::audio::audio_show_panel,
            commands::database::database_status,
            commands::studio::studio_open_files,
            commands::studio::studio_open_song,
            commands::studio::studio_recent_songs,
            commands::studio::studio_get_song,
            commands::studio::studio_status,
            commands::studio::studio_peaks,
            commands::studio::studio_detect_sections,
            commands::studio::studio_save_sections,
            commands::studio::studio_save_tempo,
            commands::studio::output_info,
            commands::studio::transport_play,
            commands::studio::transport_pause,
            commands::studio::transport_stop,
            commands::studio::transport_seek,
            commands::studio::transport_set_master_gain,
            commands::studio::transport_set_tempo_ratio,
            commands::studio::transport_state,
            commands::studio::studio_meters,
            commands::studio::studio_output_settings,
            commands::studio::studio_set_output,
            commands::studio::studio_set_track_gain,
            commands::studio::studio_update_track,
            commands::studio::studio_set_song_info,
            commands::studio::studio_reorder_tracks,
            commands::studio::studio_reorder_mixer,
            commands::studio::studio_set_track_mix,
            commands::studio::library_songs,
            commands::studio::library_rename,
            commands::studio::library_delete,
            commands::import::studio_import_inspect,
            commands::import::studio_import_preview,
            commands::import::studio_import_commit,
            commands::import::studio_import_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LIVEPLAYER");
}
