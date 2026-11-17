//! Songs, their tracks (audio files) and their sections (markers).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Database, DbError};

pub const SECTION_KINDS: &[&str] = &["intro", "verse", "prechorus", "chorus", "bridge", "interlude", "outro", "section"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewTrack {
    pub name: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackRecord {
    pub position: u32,
    pub name: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionRecord {
    pub start_sec: f64,
    pub kind: String,
    pub label: String,
    /// `auto` (detected) or `user` (created/edited by the user).
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongRecord {
    pub id: i64,
    pub title: String,
    pub original_bpm: Option<f64>,
    pub bpm_source: String,
    pub downbeat_offset_sec: f64,
    pub target_bpm: Option<f64>,
    pub sections_initialized: bool,
    pub last_opened_at: String,
    pub tracks: Vec<TrackRecord>,
    pub sections: Vec<SectionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongSummary {
    pub id: i64,
    pub title: String,
    pub track_count: u32,
    pub last_opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongTempo {
    pub original_bpm: Option<f64>,
    /// `none`, `detected` or `user`.
    pub bpm_source: String,
    pub downbeat_offset_sec: f64,
    pub target_bpm: Option<f64>,
}

fn invalid(msg: impl Into<String>) -> DbError {
    DbError::Invalid(msg.into())
}

fn validate_sections(sections: &[SectionRecord]) -> Result<(), DbError> {
    for s in sections {
        if !s.start_sec.is_finite() || s.start_sec < 0.0 {
            return Err(invalid(format!("inicio de sección no válido: {}", s.start_sec)));
        }
        if !SECTION_KINDS.contains(&s.kind.as_str()) {
            return Err(invalid(format!("tipo de sección desconocido: {}", s.kind)));
        }
        let len = s.label.trim().chars().count();
        if len == 0 || len > 60 {
            return Err(invalid("el nombre de la sección debe tener entre 1 y 60 caracteres"));
        }
        if s.source != "auto" && s.source != "user" {
            return Err(invalid(format!("origen de sección no válido: {}", s.source)));
        }
    }
    Ok(())
}

impl Database {
    /// Creates a song with its tracks (in order) and returns its id.
    pub fn create_song(&mut self, title: &str, tracks: &[NewTrack]) -> Result<i64, DbError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("el título debe tener entre 1 y 200 caracteres"));
        }
        if tracks.is_empty() {
            return Err(invalid("una canción necesita al menos una pista"));
        }
        let tx = self.conn.transaction()?;
        tx.execute("INSERT INTO songs (title) VALUES (?1)", [title])?;
        let id = tx.last_insert_rowid();
        {
            let mut stmt = tx.prepare("INSERT INTO song_tracks (song_id, position, name, file_path) VALUES (?1, ?2, ?3, ?4)")?;
            for (i, t) in tracks.iter().enumerate() {
                stmt.execute(params![id, i as i64, t.name, t.file_path])?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    /// Finds a song made of exactly these files (same order), to reopen it
    /// instead of creating a duplicate.
    pub fn find_song_by_files(&self, file_paths: &[String]) -> Result<Option<i64>, DbError> {
        let Some(first) = file_paths.first() else { return Ok(None) };
        let mut stmt = self.conn.prepare("SELECT song_id FROM song_tracks WHERE position = 0 AND file_path = ?1")?;
        let candidates = stmt.query_map([first], |r| r.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
        for id in candidates {
            let paths: Vec<String> = self
                .conn
                .prepare("SELECT file_path FROM song_tracks WHERE song_id = ?1 ORDER BY position")?
                .query_map([id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            if paths == file_paths {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    pub fn get_song(&self, id: i64) -> Result<Option<SongRecord>, DbError> {
        let song = self
            .conn
            .query_row(
                "SELECT id, title, original_bpm, bpm_source, downbeat_offset_sec, target_bpm, sections_initialized, last_opened_at
                 FROM songs WHERE id = ?1",
                [id],
                |r| {
                    Ok(SongRecord {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        original_bpm: r.get(2)?,
                        bpm_source: r.get(3)?,
                        downbeat_offset_sec: r.get(4)?,
                        target_bpm: r.get(5)?,
                        sections_initialized: r.get::<_, i64>(6)? != 0,
                        last_opened_at: r.get(7)?,
                        tracks: Vec::new(),
                        sections: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut song) = song else { return Ok(None) };

        song.tracks = self
            .conn
            .prepare("SELECT position, name, file_path FROM song_tracks WHERE song_id = ?1 ORDER BY position")?
            .query_map([id], |r| Ok(TrackRecord { position: r.get(0)?, name: r.get(1)?, file_path: r.get(2)? }))?
            .collect::<Result<_, _>>()?;
        song.sections = self.sections(id)?;
        Ok(Some(song))
    }

    pub fn sections(&self, song_id: i64) -> Result<Vec<SectionRecord>, DbError> {
        Ok(self
            .conn
            .prepare("SELECT start_sec, kind, label, source FROM song_sections WHERE song_id = ?1 ORDER BY start_sec, id")?
            .query_map([song_id], |r| {
                Ok(SectionRecord { start_sec: r.get(0)?, kind: r.get(1)?, label: r.get(2)?, source: r.get(3)? })
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn recent_songs(&self, limit: u32) -> Result<Vec<SongSummary>, DbError> {
        Ok(self
            .conn
            .prepare(
                "SELECT s.id, s.title, (SELECT COUNT(*) FROM song_tracks t WHERE t.song_id = s.id), s.last_opened_at
                 FROM songs s ORDER BY s.last_opened_at DESC, s.id DESC LIMIT ?1",
            )?
            .query_map([limit], |r| {
                Ok(SongSummary { id: r.get(0)?, title: r.get(1)?, track_count: r.get(2)?, last_opened_at: r.get(3)? })
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn touch_song(&self, id: i64) -> Result<(), DbError> {
        let n = self.conn.execute(
            "UPDATE songs SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
            [id],
        )?;
        if n == 0 { Err(DbError::NotFound(format!("canción {id}"))) } else { Ok(()) }
    }

    pub fn set_song_tempo(&self, id: i64, tempo: &SongTempo) -> Result<(), DbError> {
        if let Some(bpm) = tempo.original_bpm
            && !(20.0..=400.0).contains(&bpm)
        {
            return Err(invalid(format!("BPM original fuera de rango: {bpm}")));
        }
        if !["none", "detected", "user"].contains(&tempo.bpm_source.as_str()) {
            return Err(invalid(format!("origen de BPM no válido: {}", tempo.bpm_source)));
        }
        if let (Some(target), Some(orig)) = (tempo.target_bpm, tempo.original_bpm) {
            let ratio = target / orig;
            if !(0.5..=2.0).contains(&ratio) {
                return Err(invalid("el tempo de reproducción debe estar entre el 50 % y el 200 % del original"));
            }
        }
        if !tempo.downbeat_offset_sec.is_finite() || tempo.downbeat_offset_sec < 0.0 {
            return Err(invalid("inicio de compás no válido"));
        }
        let n = self.conn.execute(
            "UPDATE songs SET original_bpm = ?2, bpm_source = ?3, downbeat_offset_sec = ?4, target_bpm = ?5 WHERE id = ?1",
            params![id, tempo.original_bpm, tempo.bpm_source, tempo.downbeat_offset_sec, tempo.target_bpm],
        )?;
        if n == 0 { Err(DbError::NotFound(format!("canción {id}"))) } else { Ok(()) }
    }

    /// Replaces all sections of a song atomically.
    pub fn replace_sections(&mut self, song_id: i64, sections: &[SectionRecord]) -> Result<(), DbError> {
        validate_sections(sections)?;
        let tx = self.conn.transaction()?;
        let n = tx.execute("UPDATE songs SET sections_initialized = 1 WHERE id = ?1", [song_id])?;
        if n == 0 {
            return Err(DbError::NotFound(format!("canción {song_id}")));
        }
        tx.execute("DELETE FROM song_sections WHERE song_id = ?1", [song_id])?;
        {
            let mut stmt =
                tx.prepare("INSERT INTO song_sections (song_id, start_sec, kind, label, source) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for s in sections {
                stmt.execute(params![song_id, s.start_sec, s.kind, s.label.trim(), s.source])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracks() -> Vec<NewTrack> {
        vec![
            NewTrack { name: "Click".into(), file_path: "C:\\songs\\a\\Click.wav".into() },
            NewTrack { name: "Drums".into(), file_path: "C:\\songs\\a\\Drums.mp3".into() },
        ]
    }

    fn section(start: f64, kind: &str, label: &str) -> SectionRecord {
        SectionRecord { start_sec: start, kind: kind.into(), label: label.into(), source: "auto".into() }
    }

    #[test]
    fn create_find_and_get_song() {
        let mut db = Database::open_in_memory().unwrap();
        let id = db.create_song("Cuán grande es Él", &tracks()).unwrap();
        let paths: Vec<String> = tracks().into_iter().map(|t| t.file_path).collect();
        assert_eq!(db.find_song_by_files(&paths).unwrap(), Some(id));
        assert_eq!(db.find_song_by_files(&paths[..1]).unwrap(), None);

        let song = db.get_song(id).unwrap().unwrap();
        assert_eq!(song.title, "Cuán grande es Él");
        assert_eq!(song.tracks.len(), 2);
        assert_eq!(song.tracks[1].name, "Drums");
        assert!(!song.sections_initialized);
        assert_eq!(song.original_bpm, None);
        assert!(db.get_song(id + 100).unwrap().is_none());
    }

    #[test]
    fn rejects_invalid_songs() {
        let mut db = Database::open_in_memory().unwrap();
        assert!(matches!(db.create_song("  ", &tracks()), Err(DbError::Invalid(_))));
        assert!(matches!(db.create_song("x", &[]), Err(DbError::Invalid(_))));
    }

    #[test]
    fn tempo_round_trip_and_validation() {
        let mut db = Database::open_in_memory().unwrap();
        let id = db.create_song("s", &tracks()).unwrap();
        let tempo = SongTempo { original_bpm: Some(72.0), bpm_source: "user".into(), downbeat_offset_sec: 0.41, target_bpm: Some(68.0) };
        db.set_song_tempo(id, &tempo).unwrap();
        let song = db.get_song(id).unwrap().unwrap();
        assert_eq!(song.original_bpm, Some(72.0));
        assert_eq!(song.target_bpm, Some(68.0));
        assert_eq!(song.bpm_source, "user");

        let too_fast = SongTempo { target_bpm: Some(200.0), ..tempo.clone() };
        assert!(matches!(db.set_song_tempo(id, &too_fast), Err(DbError::Invalid(_))));
        let bad_source = SongTempo { bpm_source: "guess".into(), ..tempo.clone() };
        assert!(db.set_song_tempo(id, &bad_source).is_err());
        assert!(matches!(db.set_song_tempo(999, &tempo), Err(DbError::NotFound(_))));
    }

    #[test]
    fn sections_replace_atomically_and_validate() {
        let mut db = Database::open_in_memory().unwrap();
        let id = db.create_song("s", &tracks()).unwrap();
        db.replace_sections(id, &[section(30.0, "chorus", "Coro 1"), section(0.0, "intro", "Intro")]).unwrap();
        let s = db.sections(id).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].label, "Intro"); // ordered by start
        assert!(db.get_song(id).unwrap().unwrap().sections_initialized);

        // An invalid list must leave the previous one untouched.
        let bad = [section(10.0, "verse", "Estrofa"), section(-1.0, "chorus", "Coro")];
        assert!(matches!(db.replace_sections(id, &bad), Err(DbError::Invalid(_))));
        assert!(db.replace_sections(id, &[section(1.0, "solo", "Solo")]).is_err());
        assert!(db.replace_sections(id, &[section(1.0, "verse", "")]).is_err());
        assert_eq!(db.sections(id).unwrap().len(), 2);

        // Empty list is valid (user removed everything) and stays initialised.
        db.replace_sections(id, &[]).unwrap();
        assert!(db.sections(id).unwrap().is_empty());
        assert!(db.get_song(id).unwrap().unwrap().sections_initialized);
    }

    #[test]
    fn recent_songs_order_and_cascade() {
        let mut db = Database::open_in_memory().unwrap();
        let a = db.create_song("A", &tracks()).unwrap();
        let b = db.create_song("B", &tracks()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.touch_song(a).unwrap();
        let recent = db.recent_songs(10).unwrap();
        assert_eq!(recent.iter().map(|s| s.id).collect::<Vec<_>>(), vec![a, b]);
        assert_eq!(recent[0].track_count, 2);

        db.replace_sections(a, &[section(0.0, "intro", "Intro")]).unwrap();
        db.conn.execute("DELETE FROM songs WHERE id = ?1", [a]).unwrap();
        let orphans: i64 = db.conn.query_row("SELECT COUNT(*) FROM song_sections", [], |r| r.get(0)).unwrap();
        assert_eq!(orphans, 0); // ON DELETE CASCADE (foreign_keys = ON)
    }
}
