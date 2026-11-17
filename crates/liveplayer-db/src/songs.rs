//! Songs, their tracks (audio files) and their sections (markers).

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Database, DbError};

pub const SECTION_KINDS: &[&str] = &["intro", "verse", "prechorus", "chorus", "bridge", "interlude", "outro", "section"];

/// What a file is (instrument family). `click` and `cues` go to the band's monitors.
pub const TRACK_ROLES: &[&str] = &[
    "drums", "percussion", "bass", "electric_guitar", "acoustic_guitar", "piano", "keys", "pads", "synth", "strings",
    "brass", "lead_vocal", "backing_vocals", "loops", "backing_track", "click", "cues", "other",
];

pub const TIME_SIGNATURES: &[&str] = &["2/4", "3/4", "4/4", "5/4", "6/8", "12/8"];

/// Fader range saved per track.
pub const MIN_TRACK_DB: f64 = -60.0;
pub const MAX_TRACK_DB: f64 = 8.0;

/// Output bus of a role: click and cues are heard only by the band.
pub fn bus_for_role(role: &str) -> &'static str {
    if role == "click" || role == "cues" { "monitor" } else { "main" }
}

/// Beats per bar used for the bar grid. In 6/8 and 12/8 the BPM counts dotted
/// quarter notes (2 and 4 pulses per bar), as charts usually do.
pub fn beats_per_bar(time_signature: &str) -> i32 {
    match time_signature {
        "2/4" | "6/8" => 2,
        "3/4" => 3,
        "5/4" => 5,
        _ => 4,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewTrack {
    pub name: String,
    pub file_path: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewSongMeta {
    /// Tempo given by the user on import (None = detect it).
    pub original_bpm: Option<f64>,
    pub time_signature: String,
    pub source_archive: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackRecord {
    pub position: u32,
    pub name: String,
    pub file_path: String,
    pub role: String,
    pub bus: String,
    /// Where the track is shown (0 = top). The user can drag tracks.
    pub display_order: u32,
    /// Where its strip is in the mixer (0 = left). Independent of `display_order`.
    pub mixer_order: u32,
    /// Saved mixer settings of the track.
    pub volume_db: f64,
    pub muted: bool,
    pub soloed: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    pub volume_db: f64,
    pub muted: bool,
    pub soloed: bool,
}

/// One row of the song library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySong {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub song_key: String,
    pub original_bpm: Option<f64>,
    pub target_bpm: Option<f64>,
    pub time_signature: String,
    pub duration_sec: Option<f64>,
    pub track_count: u32,
    pub section_count: u32,
    pub source_archive: Option<String>,
    pub created_at: String,
    pub last_opened_at: String,
}

/** Which arrangement to change. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackOrder {
    /// The track list (top to bottom).
    Tracks,
    /// The mixer strips (left to right).
    Mixer,
}

/// Default display order: click first, cues second, then the band in load order.
pub fn default_display_order(roles: &[&str]) -> Vec<u32> {
    let rank = |r: &str| match r {
        "click" => 0,
        "cues" => 1,
        _ => 2,
    };
    let mut idx: Vec<usize> = (0..roles.len()).collect();
    idx.sort_by_key(|&i| (rank(roles[i]), i));
    let mut order = vec![0u32; roles.len()];
    for (shown, &i) in idx.iter().enumerate() {
        order[i] = shown as u32;
    }
    order
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
    pub artist: String,
    pub song_key: String,
    pub notes: String,
    pub original_bpm: Option<f64>,
    pub bpm_source: String,
    pub downbeat_offset_sec: f64,
    pub target_bpm: Option<f64>,
    pub sections_initialized: bool,
    pub time_signature: String,
    pub source_archive: Option<String>,
    pub last_opened_at: String,
    pub tracks: Vec<TrackRecord>,
    pub sections: Vec<SectionRecord>,
}

/// What the Song Editor saves about a song.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongDetails {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub song_key: String,
    #[serde(default)]
    pub notes: String,
    pub time_signature: String,
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

fn validate_track(name: &str, role: &str) -> Result<(), DbError> {
    let len = name.trim().chars().count();
    if len == 0 || len > 80 {
        return Err(invalid("el nombre de la pista debe tener entre 1 y 80 caracteres"));
    }
    if !TRACK_ROLES.contains(&role) {
        return Err(invalid(format!("tipo de pista desconocido: {role}")));
    }
    Ok(())
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
    pub fn create_song(&mut self, title: &str, tracks: &[NewTrack], meta: &NewSongMeta) -> Result<i64, DbError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("el título debe tener entre 1 y 200 caracteres"));
        }
        if tracks.is_empty() {
            return Err(invalid("una canción necesita al menos una pista"));
        }
        let ts = if meta.time_signature.is_empty() { "4/4" } else { meta.time_signature.as_str() };
        if !TIME_SIGNATURES.contains(&ts) {
            return Err(invalid(format!("compás no soportado: {ts}")));
        }
        if let Some(bpm) = meta.original_bpm
            && !(20.0..=400.0).contains(&bpm)
        {
            return Err(invalid(format!("BPM fuera de rango: {bpm}")));
        }
        for t in tracks {
            validate_track(&t.name, &t.role)?;
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO songs (title, time_signature, source_archive, original_bpm, bpm_source) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![title, ts, meta.source_archive, meta.original_bpm, if meta.original_bpm.is_some() { "user" } else { "none" }],
        )?;
        let id = tx.last_insert_rowid();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO song_tracks (song_id, position, name, file_path, role, bus, display_order, mixer_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            )?;
            let roles: Vec<&str> = tracks.iter().map(|t| t.role.as_str()).collect();
            let order = default_display_order(&roles);
            for (i, t) in tracks.iter().enumerate() {
                stmt.execute(params![id, i as i64, t.name.trim(), t.file_path, t.role, bus_for_role(&t.role), order[i]])?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    /// Song previously imported from this zip file whose files are still on disk.
    pub fn find_song_by_archive(&self, archive: &str) -> Result<Option<i64>, DbError> {
        Ok(self
            .conn
            .query_row("SELECT id FROM songs WHERE source_archive = ?1 ORDER BY id DESC LIMIT 1", [archive], |r| r.get(0))
            .optional()?)
    }

    /// Renames a track and/or changes what it is (its output bus follows the role).
    pub fn update_track(&self, song_id: i64, position: u32, name: &str, role: &str) -> Result<(), DbError> {
        validate_track(name, role)?;
        let n = self.conn.execute(
            "UPDATE song_tracks SET name = ?3, role = ?4, bus = ?5 WHERE song_id = ?1 AND position = ?2",
            params![song_id, position, name.trim(), role, bus_for_role(role)],
        )?;
        if n == 0 { Err(DbError::NotFound(format!("pista {position} de la canción {song_id}"))) } else { Ok(()) }
    }

    /// Saves an arrangement: `positions` lists every track position (load
    /// order) from top to bottom (tracks) or left to right (mixer). Changing
    /// one arrangement never touches the other.
    pub fn set_track_order(&mut self, song_id: i64, which: TrackOrder, positions: &[u32]) -> Result<(), DbError> {
        let count: u32 =
            self.conn.query_row("SELECT COUNT(*) FROM song_tracks WHERE song_id = ?1", [song_id], |r| r.get(0))?;
        if count == 0 {
            return Err(DbError::NotFound(format!("canción {song_id}")));
        }
        let mut sorted = positions.to_vec();
        sorted.sort_unstable();
        if sorted != (0..count).collect::<Vec<u32>>() {
            return Err(invalid("el orden debe incluir cada pista una sola vez"));
        }
        let tx = self.conn.transaction()?;
        {
            let sql = match which {
                TrackOrder::Tracks => "UPDATE song_tracks SET display_order = ?3 WHERE song_id = ?1 AND position = ?2",
                TrackOrder::Mixer => "UPDATE song_tracks SET mixer_order = ?3 WHERE song_id = ?1 AND position = ?2",
            };
            let mut stmt = tx.prepare(sql)?;
            for (shown, pos) in positions.iter().enumerate() {
                stmt.execute(params![song_id, pos, shown as u32])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Saves the fader, mute and solo of one track.
    pub fn set_track_mix(&self, song_id: i64, position: u32, mix: &TrackMix) -> Result<(), DbError> {
        if !mix.volume_db.is_finite() || !(MIN_TRACK_DB..=MAX_TRACK_DB).contains(&mix.volume_db) {
            return Err(invalid(format!("volumen fuera de rango ({MIN_TRACK_DB} a +{MAX_TRACK_DB} dB): {}", mix.volume_db)));
        }
        let n = self.conn.execute(
            "UPDATE song_tracks SET volume_db = ?3, muted = ?4, soloed = ?5 WHERE song_id = ?1 AND position = ?2",
            params![song_id, position, mix.volume_db, mix.muted as i64, mix.soloed as i64],
        )?;
        if n == 0 { Err(DbError::NotFound(format!("pista {position} de la canción {song_id}"))) } else { Ok(()) }
    }

    /// Stores the length of the song the first time it is loaded (or if it changed).
    pub fn set_song_duration(&self, id: i64, seconds: f64) -> Result<(), DbError> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(invalid("duración no válida"));
        }
        self.conn.execute(
            "UPDATE songs SET duration_sec = ?2 WHERE id = ?1 AND (duration_sec IS NULL OR abs(duration_sec - ?2) > 0.01)",
            params![id, seconds],
        )?;
        Ok(())
    }

    /// Every song with the data shown in the library.
    pub fn library(&self) -> Result<Vec<LibrarySong>, DbError> {
        Ok(self
            .conn
            .prepare(
                "SELECT s.id, s.title, s.original_bpm, s.target_bpm, s.time_signature, s.duration_sec,
                        (SELECT COUNT(*) FROM song_tracks t WHERE t.song_id = s.id),
                        (SELECT COUNT(*) FROM song_sections x WHERE x.song_id = s.id),
                        s.source_archive, s.created_at, s.last_opened_at, s.artist, s.song_key
                 FROM songs s ORDER BY s.title COLLATE NOCASE, s.id",
            )?
            .query_map([], |r| {
                Ok(LibrarySong {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    original_bpm: r.get(2)?,
                    target_bpm: r.get(3)?,
                    time_signature: r.get(4)?,
                    duration_sec: r.get(5)?,
                    track_count: r.get(6)?,
                    section_count: r.get(7)?,
                    source_archive: r.get(8)?,
                    created_at: r.get(9)?,
                    last_opened_at: r.get(10)?,
                    artist: r.get(11)?,
                    song_key: r.get(12)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn rename_song(&self, id: i64, title: &str) -> Result<(), DbError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("el título debe tener entre 1 y 200 caracteres"));
        }
        let n = self.conn.execute("UPDATE songs SET title = ?2 WHERE id = ?1", params![id, title])?;
        if n == 0 { Err(DbError::NotFound(format!("canción {id}"))) } else { Ok(()) }
    }

    /// Removes a song (tracks and sections go with it). Returns its file paths
    /// so the caller can decide what to do with files it owns.
    pub fn delete_song(&mut self, id: i64) -> Result<Vec<String>, DbError> {
        let tx = self.conn.transaction()?;
        let files: Vec<String> = tx
            .prepare("SELECT file_path FROM song_tracks WHERE song_id = ?1 ORDER BY position")?
            .query_map([id], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let n = tx.execute("DELETE FROM songs WHERE id = ?1", [id])?;
        if n == 0 {
            return Err(DbError::NotFound(format!("canción {id}")));
        }
        tx.commit()?;
        Ok(files)
    }

    /// True if another song still uses this file (do not delete it).
    pub fn file_in_use(&self, path: &str) -> Result<bool, DbError> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM song_tracks WHERE file_path = ?1", [path], |r| r.get(0))?;
        Ok(n > 0)
    }

    pub fn set_song_info(&self, id: i64, title: &str, time_signature: &str) -> Result<(), DbError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("el título debe tener entre 1 y 200 caracteres"));
        }
        if !TIME_SIGNATURES.contains(&time_signature) {
            return Err(invalid(format!("compás no soportado: {time_signature}")));
        }
        let n = self.conn.execute(
            "UPDATE songs SET title = ?2, time_signature = ?3 WHERE id = ?1",
            params![id, title, time_signature],
        )?;
        if n == 0 { Err(DbError::NotFound(format!("canción {id}"))) } else { Ok(()) }
    }

    /// Title, artist, key, notes and time signature (Song Editor).
    pub fn set_song_details(&self, id: i64, d: &SongDetails) -> Result<(), DbError> {
        let title = d.title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(invalid("el título debe tener entre 1 y 200 caracteres"));
        }
        if !TIME_SIGNATURES.contains(&d.time_signature.as_str()) {
            return Err(invalid(format!("compás no soportado: {}", d.time_signature)));
        }
        if d.artist.chars().count() > 200 || d.song_key.chars().count() > 20 || d.notes.chars().count() > 4000 {
            return Err(invalid("artista, tonalidad o notas demasiado largos"));
        }
        let n = self.conn.execute(
            "UPDATE songs SET title = ?2, artist = ?3, song_key = ?4, notes = ?5, time_signature = ?6 WHERE id = ?1",
            params![id, title, d.artist.trim(), d.song_key.trim(), d.notes, d.time_signature],
        )?;
        if n == 0 { Err(DbError::NotFound(format!("canción {id}"))) } else { Ok(()) }
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
                "SELECT id, title, original_bpm, bpm_source, downbeat_offset_sec, target_bpm, sections_initialized, last_opened_at,
                        time_signature, source_archive, artist, song_key, notes
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
                        time_signature: r.get(8)?,
                        source_archive: r.get(9)?,
                        artist: r.get(10)?,
                        song_key: r.get(11)?,
                        notes: r.get(12)?,
                        tracks: Vec::new(),
                        sections: Vec::new(),
                    })
                },
            )
            .optional()?;
        let Some(mut song) = song else { return Ok(None) };

        song.tracks = self
            .conn
            .prepare(
                "SELECT position, name, file_path, role, bus, display_order, mixer_order, volume_db, muted, soloed
                 FROM song_tracks WHERE song_id = ?1 ORDER BY position",
            )?
            .query_map([id], |r| {
                Ok(TrackRecord {
                    position: r.get(0)?,
                    name: r.get(1)?,
                    file_path: r.get(2)?,
                    role: r.get(3)?,
                    bus: r.get(4)?,
                    display_order: r.get(5)?,
                    mixer_order: r.get(6)?,
                    volume_db: r.get(7)?,
                    muted: r.get::<_, i64>(8)? != 0,
                    soloed: r.get::<_, i64>(9)? != 0,
                })
            })?
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
            NewTrack { name: "Click".into(), file_path: "C:\\songs\\a\\Click.wav".into(), role: "click".into() },
            NewTrack { name: "Drums".into(), file_path: "C:\\songs\\a\\Drums.mp3".into(), role: "drums".into() },
        ]
    }

    fn meta() -> NewSongMeta {
        NewSongMeta { original_bpm: None, time_signature: "4/4".into(), source_archive: None }
    }

    #[test]
    fn click_and_cues_come_first_and_order_can_change() {
        let mut db = Database::open_in_memory().unwrap();
        let t = |name: &str, role: &str| NewTrack { name: name.into(), file_path: format!("C:\\x\\{name}.wav"), role: role.into() };
        let id = db
            .create_song("s", &[t("Bass", "bass"), t("Drums", "drums"), t("Guia", "cues"), t("Click", "click")], &meta())
            .unwrap();
        let shown = |db: &Database| {
            let mut tr = db.get_song(id).unwrap().unwrap().tracks;
            tr.sort_by_key(|x| x.display_order);
            tr.into_iter().map(|x| x.name).collect::<Vec<_>>()
        };
        assert_eq!(shown(&db), vec!["Click", "Guia", "Bass", "Drums"]);

        // User drags Drums to the top.
        db.set_track_order(id, TrackOrder::Tracks, &[1, 3, 2, 0]).unwrap();
        assert_eq!(shown(&db), vec!["Drums", "Click", "Guia", "Bass"]);
        assert!(db.set_track_order(id, TrackOrder::Tracks, &[0, 0, 1, 2]).is_err());
        assert!(db.set_track_order(id, TrackOrder::Tracks, &[0, 1, 2]).is_err());
        assert!(matches!(db.set_track_order(999, TrackOrder::Tracks, &[0]), Err(DbError::NotFound(_))));

        // The mixer has its own order: moving a strip does not move the tracks.
        let mixer = |db: &Database| {
            let mut tr = db.get_song(id).unwrap().unwrap().tracks;
            tr.sort_by_key(|x| x.mixer_order);
            tr.into_iter().map(|x| x.name).collect::<Vec<_>>()
        };
        assert_eq!(mixer(&db), vec!["Click", "Guia", "Bass", "Drums"]); // starts like the import order
        db.set_track_order(id, TrackOrder::Mixer, &[0, 1, 3, 2]).unwrap();
        assert_eq!(mixer(&db), vec!["Bass", "Drums", "Click", "Guia"]);
        assert_eq!(shown(&db), vec!["Drums", "Click", "Guia", "Bass"]); // tracks unchanged
        assert_eq!(default_display_order(&["bass", "click"]), vec![1, 0]);
    }

    #[test]
    fn mixer_settings_are_saved_per_track() {
        let mut db = Database::open_in_memory().unwrap();
        let id = db.create_song("s", &tracks(), &meta()).unwrap();
        let fresh = db.get_song(id).unwrap().unwrap();
        assert!(fresh.tracks.iter().all(|t| t.volume_db == 0.0 && !t.muted && !t.soloed));

        db.set_track_mix(id, 1, &TrackMix { volume_db: -6.5, muted: true, soloed: false }).unwrap();
        db.set_track_mix(id, 0, &TrackMix { volume_db: 8.0, muted: false, soloed: true }).unwrap();
        let s = db.get_song(id).unwrap().unwrap();
        assert_eq!((s.tracks[1].volume_db, s.tracks[1].muted, s.tracks[1].soloed), (-6.5, true, false));
        assert_eq!((s.tracks[0].volume_db, s.tracks[0].soloed), (8.0, true));

        assert!(db.set_track_mix(id, 0, &TrackMix { volume_db: 8.1, muted: false, soloed: false }).is_err());
        assert!(db.set_track_mix(id, 0, &TrackMix { volume_db: -61.0, muted: false, soloed: false }).is_err());
        assert!(matches!(db.set_track_mix(id, 9, &TrackMix { volume_db: 0.0, muted: false, soloed: false }), Err(DbError::NotFound(_))));
    }

    #[test]
    fn library_rename_and_delete() {
        let mut db = Database::open_in_memory().unwrap();
        let a = db.create_song("Zeta", &tracks(), &meta()).unwrap();
        let b = db.create_song("alfa", &[NewTrack { name: "Bass".into(), file_path: "C:\\b\\Bass.wav".into(), role: "bass".into() }], &meta()).unwrap();
        db.set_song_duration(a, 250.0).unwrap();
        db.replace_sections(a, &[section(0.0, "intro", "Intro")]).unwrap();

        let lib = db.library().unwrap();
        assert_eq!(lib.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), vec!["alfa", "Zeta"]); // case-insensitive
        let z = lib.iter().find(|s| s.id == a).unwrap();
        assert_eq!((z.duration_sec, z.track_count, z.section_count), (Some(250.0), 2, 1));

        db.rename_song(b, "Alfa y Omega").unwrap();
        assert!(db.rename_song(b, " ").is_err());
        assert_eq!(db.get_song(b).unwrap().unwrap().title, "Alfa y Omega");

        assert!(db.file_in_use("C:\\songs\\a\\Click.wav").unwrap());
        let files = db.delete_song(a).unwrap();
        assert_eq!(files.len(), 2);
        assert!(!db.file_in_use("C:\\songs\\a\\Click.wav").unwrap());
        assert!(db.get_song(a).unwrap().is_none());
        assert!(matches!(db.delete_song(a), Err(DbError::NotFound(_))));
        assert_eq!(db.library().unwrap().len(), 1);
    }

    #[test]
    fn import_metadata_roles_and_archive() {
        let mut db = Database::open_in_memory().unwrap();
        let m = NewSongMeta { original_bpm: Some(72.0), time_signature: "6/8".into(), source_archive: Some("C:\\x\\Song.zip".into()) };
        let id = db.create_song("Song", &tracks(), &m).unwrap();
        let s = db.get_song(id).unwrap().unwrap();
        assert_eq!(s.original_bpm, Some(72.0));
        assert_eq!(s.bpm_source, "user");
        assert_eq!(s.time_signature, "6/8");
        assert_eq!(db.find_song_by_archive("C:\\x\\Song.zip").unwrap(), Some(id));
        assert_eq!(db.find_song_by_archive("C:\\other.zip").unwrap(), None);

        // "llmmD" was really the drums: rename + role; the bus follows the role.
        db.update_track(id, 0, "Batería", "drums").unwrap();
        let s = db.get_song(id).unwrap().unwrap();
        assert_eq!((s.tracks[0].name.as_str(), s.tracks[0].role.as_str(), s.tracks[0].bus.as_str()), ("Batería", "drums", "main"));
        db.update_track(id, 1, "Cues", "cues").unwrap();
        assert_eq!(db.get_song(id).unwrap().unwrap().tracks[1].bus, "monitor");
        assert!(db.update_track(id, 0, "x", "kazoo").is_err());
        assert!(matches!(db.update_track(id, 9, "x", "drums"), Err(DbError::NotFound(_))));

        db.set_song_info(id, "Nuevo título", "3/4").unwrap();
        assert_eq!(db.get_song(id).unwrap().unwrap().time_signature, "3/4");
        assert!(db.set_song_info(id, "t", "7/8").is_err());
        let bad = NewSongMeta { time_signature: "7/8".into(), ..meta() };
        assert!(db.create_song("x", &tracks(), &bad).is_err());
        assert_eq!(beats_per_bar("6/8"), 2);
        assert_eq!(beats_per_bar("3/4"), 3);
    }

    fn section(start: f64, kind: &str, label: &str) -> SectionRecord {
        SectionRecord { start_sec: start, kind: kind.into(), label: label.into(), source: "auto".into() }
    }

    #[test]
    fn create_find_and_get_song() {
        let mut db = Database::open_in_memory().unwrap();
        let id = db.create_song("Cuán grande es Él", &tracks(), &meta()).unwrap();
        let paths: Vec<String> = tracks().into_iter().map(|t| t.file_path).collect();
        assert_eq!(db.find_song_by_files(&paths).unwrap(), Some(id));
        assert_eq!(db.find_song_by_files(&paths[..1]).unwrap(), None);

        let song = db.get_song(id).unwrap().unwrap();
        assert_eq!(song.title, "Cuán grande es Él");
        assert_eq!(song.tracks.len(), 2);
        assert_eq!(song.tracks[1].name, "Drums");
        assert_eq!(song.tracks[0].bus, "monitor"); // click -> band only
        assert_eq!(song.tracks[1].bus, "main");
        assert_eq!(song.time_signature, "4/4");
        assert!(!song.sections_initialized);
        assert_eq!(song.original_bpm, None);
        assert!(db.get_song(id + 100).unwrap().is_none());
    }

    #[test]
    fn rejects_invalid_songs() {
        let mut db = Database::open_in_memory().unwrap();
        assert!(matches!(db.create_song("  ", &tracks(), &meta()), Err(DbError::Invalid(_))));
        assert!(matches!(db.create_song("x", &[], &meta()), Err(DbError::Invalid(_))));
    }

    #[test]
    fn tempo_round_trip_and_validation() {
        let mut db = Database::open_in_memory().unwrap();
        let id = db.create_song("s", &tracks(), &meta()).unwrap();
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
        let id = db.create_song("s", &tracks(), &meta()).unwrap();
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
        let a = db.create_song("A", &tracks(), &meta()).unwrap();
        let b = db.create_song("B", &tracks(), &meta()).unwrap();
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
