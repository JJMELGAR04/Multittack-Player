use std::sync::Mutex;

use liveplayer_db::{Database, DatabaseStatus};
use tauri::State;

use crate::error::{CommandError, CommandResult};

pub type DbState = Mutex<Database>;

#[tauri::command]
pub fn database_status(db: State<'_, DbState>) -> CommandResult<DatabaseStatus> {
    let db = db.lock().map_err(|_| CommandError::state("la base de datos quedó bloqueada por un error previo"))?;
    Ok(db.status()?)
}
