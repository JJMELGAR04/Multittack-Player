//! Phase 6: performance settings (economy mode, decoded-audio cache), the
//! error log and the library's automatic backups.

use std::path::{Path, PathBuf};

use liveplayer_db::Database;
use liveplayer_engine::Engine;
use serde::Serialize;
use tauri::State;

use crate::applog;
use crate::commands::database::DbState;
use crate::commands::studio::lock;
use crate::error::{CommandError, CommandResult};

const ECONOMY_KEY: &str = "audio.economy";
const CACHE_MB_KEY: &str = "audio.cacheMb";
pub const DEFAULT_CACHE_MB: i64 = 4096;
const BACKUPS_KEPT: usize = 7;

pub fn cache_dir(data: &Path) -> PathBuf {
    data.join("cache")
}

fn cache_mb(db: &Database) -> i64 {
    db.get_setting(CACHE_MB_KEY).ok().flatten().and_then(|v| v.parse().ok()).filter(|m| (256..=65_536).contains(m)).unwrap_or(DEFAULT_CACHE_MB)
}

fn economy(db: &Database) -> bool {
    db.get_setting(ECONOMY_KEY).ok().flatten().is_some_and(|v| v == "true")
}

/// Start-up: cache folder and limit, economy mode.
pub(crate) fn apply_saved(engine: &Engine, db: &Database, data: &Path) {
    let _ = engine.set_cache(Some(&cache_dir(data)), cache_mb(db));
    let _ = engine.set_economy(economy(db));
}

fn cache_usage(dir: &Path) -> (u64, u32) {
    let mut bytes = 0u64;
    let mut files = 0u32;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if e.path().extension().is_some_and(|x| x == "lpc") {
                bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                files += 1;
            }
        }
    }
    (bytes, files)
}

// ---- Database: daily backups and recovery ----------------------------------------

pub fn backups_dir(data: &Path) -> PathBuf {
    data.join("backups")
}

fn backup_files(data: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(backups_dir(data))
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "sqlite3")).collect())
        .unwrap_or_default();
    v.sort(); // names carry the date: oldest first
    v
}

/// One copy of the library per day (the last 7 are kept).
pub(crate) fn daily_backup(db: &Database, data: &Path) {
    let dir = backups_dir(data);
    let _ = std::fs::create_dir_all(&dir);
    let target = dir.join(format!("liveplayer-{}.sqlite3", applog::date_of(applog::now_secs())));
    if !target.exists() {
        match db.backup_into(&target) {
            Ok(()) => applog::write("INFO", &format!("copia diaria de la biblioteca: {}", target.display())),
            Err(e) => applog::write("ERROR", &format!("no se pudo hacer la copia diaria: {e}")),
        }
    }
    let files = backup_files(data);
    for old in files.iter().take(files.len().saturating_sub(BACKUPS_KEPT)) {
        let _ = std::fs::remove_file(old);
    }
}

/// Opens the library; if the file is damaged it is set aside and the most
/// recent daily copy is restored (or a new library is created).
pub(crate) fn open_with_recovery(path: &Path, data: &Path) -> Result<Database, liveplayer_db::DbError> {
    match Database::open(path) {
        Ok(db) if db.quick_check().unwrap_or(false) => return Ok(db),
        Ok(db) => {
            drop(db);
            applog::write("ERROR", "la biblioteca está dañada: se restaura la última copia");
        }
        Err(e) => applog::write("ERROR", &format!("no se pudo abrir la biblioteca ({e}): se restaura la última copia")),
    }
    let stamp = applog::now_secs();
    for ext in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{ext}", path.display()));
        if from.exists() {
            let _ = std::fs::rename(&from, PathBuf::from(format!("{}.danada-{stamp}{ext}", path.display())));
        }
    }
    if let Some(latest) = backup_files(data).pop() {
        if std::fs::copy(&latest, path).is_ok() {
            applog::write("INFO", &format!("biblioteca restaurada desde {}", latest.display()));
        }
    }
    Database::open(path)
}

// ---- Commands ----------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceInfo {
    economy: bool,
    cache_limit_mb: i64,
    cache_used_mb: f64,
    cache_files: u32,
    cache_dir: String,
    log_path: String,
    backups: Vec<String>,
    backups_dir: String,
}

#[tauri::command]
pub fn performance_info(app: tauri::AppHandle, db: State<'_, DbState>) -> CommandResult<PerformanceInfo> {
    let data = crate::data_dir(&app).map_err(|e| CommandError::state(e.to_string()))?;
    let db = lock(&db)?;
    let dir = cache_dir(&data);
    let (bytes, files) = cache_usage(&dir);
    Ok(PerformanceInfo {
        economy: economy(&db),
        cache_limit_mb: cache_mb(&db),
        cache_used_mb: bytes as f64 / 1_048_576.0,
        cache_files: files,
        cache_dir: dir.display().to_string(),
        log_path: applog::path().map(|p| p.display().to_string()).unwrap_or_default(),
        backups: backup_files(&data).iter().rev().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect(),
        backups_dir: backups_dir(&data).display().to_string(),
    })
}

#[tauri::command]
pub fn performance_set_economy(engine: State<'_, Engine>, db: State<'_, DbState>, on: bool) -> CommandResult<()> {
    engine.set_economy(on)?;
    Ok(lock(&db)?.set_setting(ECONOMY_KEY, if on { "true" } else { "false" })?)
}

#[tauri::command]
pub fn performance_set_cache_limit(app: tauri::AppHandle, engine: State<'_, Engine>, db: State<'_, DbState>, mb: i64) -> CommandResult<()> {
    if !(256..=65_536).contains(&mb) {
        return Err(CommandError::invalid("el límite de la caché va de 256 MB a 64 GB"));
    }
    let data = crate::data_dir(&app).map_err(|e| CommandError::state(e.to_string()))?;
    engine.set_cache(Some(&cache_dir(&data)), mb)?;
    Ok(lock(&db)?.set_setting(CACHE_MB_KEY, &mb.to_string())?)
}

/// Empties the decoded-audio cache (songs will decode again the next time).
#[tauri::command]
pub fn performance_clear_cache(app: tauri::AppHandle) -> CommandResult<u32> {
    let data = crate::data_dir(&app).map_err(|e| CommandError::state(e.to_string()))?;
    let mut removed = 0;
    if let Ok(entries) = std::fs::read_dir(cache_dir(&data)) {
        for e in entries.flatten() {
            if e.path().extension().is_some_and(|x| x == "lpc" || x == "tmp") && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Errors seen by the interface (unexpected exceptions) go to the log too.
#[tauri::command]
pub fn log_ui_error(message: String) -> CommandResult<()> {
    applog::write("UI", &message);
    Ok(())
}

#[tauri::command]
pub fn log_recent(lines: Option<usize>) -> CommandResult<String> {
    Ok(applog::tail(lines.unwrap_or(60).min(500)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damaged_library_is_restored_from_the_daily_copy() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let path = data.join("liveplayer.sqlite3");
        {
            let db = Database::open(&path).unwrap();
            db.set_setting("theme", "\"dark\"").unwrap();
            daily_backup(&db, data);
        }
        assert_eq!(backup_files(data).len(), 1);
        // Damage the library file.
        let _ = std::fs::remove_file(PathBuf::from(format!("{}-wal", path.display())));
        let _ = std::fs::remove_file(PathBuf::from(format!("{}-shm", path.display())));
        std::fs::write(&path, b"this is not a database at all, just garbage").unwrap();
        let db = open_with_recovery(&path, data).unwrap();
        assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("\"dark\""), "the library came back from the copy");
        assert!(std::fs::read_dir(data).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".danada-")));
    }
}
