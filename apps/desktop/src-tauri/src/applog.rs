//! Small error log (`<data>/logs/liveplayer.log`) to diagnose problems after
//! the fact: engine and database errors, crashes (panics) and errors in the
//! interface. Rotated at 1 MB (one previous file kept). Never blocks the app.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
const MAX_BYTES: u64 = 1024 * 1024;

/// "2026-11-17" (UTC) from a Unix time in seconds.
pub fn date_of(secs: u64) -> String {
    // Civil-from-days (H. Hinnant), valid for any date after 1970.
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn timestamp() -> String {
    let s = now_secs();
    format!("{}T{:02}:{:02}:{:02}Z", date_of(s), (s / 3600) % 24, (s / 60) % 60, s % 60)
}

/// Sets the log folder and records crashes (panics) there too.
pub fn init(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let _ = LOG_FILE.set(dir.join("liveplayer.log"));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("PANIC", &info.to_string());
        previous(info);
    }));
    write("INFO", &format!("LIVEPLAYER {} iniciado", env!("CARGO_PKG_VERSION")));
}

pub fn path() -> Option<&'static PathBuf> {
    LOG_FILE.get()
}

/// Appends one line ("2026-11-17T10:00:00Z [ERROR] message").
pub fn write(level: &str, message: &str) {
    let Some(file) = LOG_FILE.get() else { return };
    if std::fs::metadata(file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(file, file.with_extension("log.1"));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
        let line: String = message.chars().filter(|c| *c != '\r').take(4000).collect();
        let _ = writeln!(f, "{} [{level}] {}", timestamp(), line.replace('\n', " | "));
    }
}

/// The last `lines` lines of the log (most recent last).
pub fn tail(lines: usize) -> String {
    let Some(file) = LOG_FILE.get() else { return String::new() };
    let text = std::fs::read_to_string(file).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(test)]
mod tests {
    #[test]
    fn dates() {
        assert_eq!(super::date_of(0), "1970-01-01");
        assert_eq!(super::date_of(1_795_392_000), "2026-11-23");
        assert_eq!(super::date_of(951_782_400), "2000-02-29");
    }
}
