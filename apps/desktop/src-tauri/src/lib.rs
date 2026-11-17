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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::engine::engine_info,
            commands::engine::engine_ping,
            commands::engine::audio_diagnostics,
            commands::database::database_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LIVEPLAYER");
}
