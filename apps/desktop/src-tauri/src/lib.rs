//! LIVEPLAYER desktop shell: wires the UI (IPC) to the native engine and the
//! database. Business logic lives in `crates/`, not here.

mod commands;
mod error;

use std::sync::Mutex;

use liveplayer_db::Database;
use liveplayer_engine::Engine;
use tauri::Manager;

const DB_FILE_NAME: &str = "liveplayer.sqlite3";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // `setup` runs on the main thread: the engine's control thread.
            let engine = Engine::new()?;
            app.manage(engine);

            let data_dir = app.path().app_data_dir()?;
            let db = Database::open(data_dir.join(DB_FILE_NAME))?;
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running LIVEPLAYER");
}
