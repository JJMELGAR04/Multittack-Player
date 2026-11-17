//! Setlists (phase 5): ordered lists of library songs for a service or show.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{Database, DbError};

/// One row of the setlist list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetlistSummary {
    pub id: i64,
    pub name: String,
    pub event_date: String,
    pub place: String,
    pub song_count: u32,
    /// Sum of the known song durations (seconds).
    pub total_sec: f64,
    pub updated_at: String,
}

/// A song inside a setlist, with what the stage view needs to show.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetlistItem {
    pub song_id: i64,
    pub notes: String,
    /// Key for this setlist only (None = the song's own `song_transpose`).
    pub transpose: Option<i32>,
    pub song_transpose: i32,
    pub title: String,
    pub artist: String,
    pub song_key: String,
    pub original_bpm: Option<f64>,
    pub target_bpm: Option<f64>,
    pub time_signature: String,
    pub duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetlistRecord {
    pub id: i64,
    pub name: String,
    pub event_date: String,
    pub place: String,
    pub notes: String,
    pub items: Vec<SetlistItem>,
}

/// What the editor saves: the whole setlist at once.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetlistInput {
    pub name: String,
    #[serde(default)]
    pub event_date: String,
    #[serde(default)]
    pub place: String,
    #[serde(default)]
    pub notes: String,
    pub items: Vec<SetlistItemInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetlistItemInput {
    pub song_id: i64,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub transpose: Option<i32>,
}

const MAX_ITEMS: usize = 200;

fn invalid(msg: impl Into<String>) -> DbError {
    DbError::Invalid(msg.into())
}

fn valid_date(d: &str) -> bool {
    d.is_empty()
        || (d.len() == 10
            && d.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }))
}

fn check(input: &SetlistInput) -> Result<(), DbError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(invalid("el nombre del setlist debe tener entre 1 y 200 caracteres"));
    }
    if !valid_date(&input.event_date) {
        return Err(invalid("fecha inválida (AAAA-MM-DD)"));
    }
    if input.place.chars().count() > 200 || input.notes.chars().count() > 4000 {
        return Err(invalid("lugar o notas demasiado largos"));
    }
    if input.items.len() > MAX_ITEMS {
        return Err(invalid(format!("un setlist admite hasta {MAX_ITEMS} canciones")));
    }
    if input.items.iter().any(|i| i.notes.chars().count() > 1000) {
        return Err(invalid("las notas de una canción admiten hasta 1000 caracteres"));
    }
    if input.items.iter().any(|i| i.transpose.is_some_and(|t| !(-12..=12).contains(&t))) {
        return Err(invalid("el cambio de tono va de -12 a +12 semitonos"));
    }
    Ok(())
}

impl Database {
    pub fn setlists(&self) -> Result<Vec<SetlistSummary>, DbError> {
        Ok(self
            .conn
            .prepare(
                "SELECT l.id, l.name, l.event_date, l.place,
                        (SELECT COUNT(*) FROM setlist_items i WHERE i.setlist_id = l.id),
                        (SELECT COALESCE(SUM(s.duration_sec), 0) FROM setlist_items i JOIN songs s ON s.id = i.song_id WHERE i.setlist_id = l.id),
                        l.updated_at
                 FROM setlists l
                 ORDER BY CASE WHEN l.event_date = '' THEN 1 ELSE 0 END, l.event_date DESC, l.updated_at DESC, l.id DESC",
            )?
            .query_map([], |r| {
                Ok(SetlistSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    event_date: r.get(2)?,
                    place: r.get(3)?,
                    song_count: r.get(4)?,
                    total_sec: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn get_setlist(&self, id: i64) -> Result<Option<SetlistRecord>, DbError> {
        let head = self
            .conn
            .query_row("SELECT id, name, event_date, place, notes FROM setlists WHERE id = ?1", [id], |r| {
                Ok(SetlistRecord {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    event_date: r.get(2)?,
                    place: r.get(3)?,
                    notes: r.get(4)?,
                    items: Vec::new(),
                })
            })
            .optional()?;
        let Some(mut list) = head else { return Ok(None) };
        list.items = self
            .conn
            .prepare(
                "SELECT i.song_id, i.notes, s.title, s.artist, s.song_key, s.original_bpm, s.target_bpm, s.time_signature, s.duration_sec,
                        i.transpose, s.transpose
                 FROM setlist_items i JOIN songs s ON s.id = i.song_id
                 WHERE i.setlist_id = ?1 ORDER BY i.position",
            )?
            .query_map([id], |r| {
                Ok(SetlistItem {
                    song_id: r.get(0)?,
                    notes: r.get(1)?,
                    title: r.get(2)?,
                    artist: r.get(3)?,
                    song_key: r.get(4)?,
                    original_bpm: r.get(5)?,
                    target_bpm: r.get(6)?,
                    time_signature: r.get(7)?,
                    duration_sec: r.get(8)?,
                    transpose: r.get(9)?,
                    song_transpose: r.get(10)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(Some(list))
    }

    pub fn create_setlist(&mut self, input: &SetlistInput) -> Result<i64, DbError> {
        check(input)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO setlists (name, event_date, place, notes) VALUES (?1, ?2, ?3, ?4)",
            params![input.name.trim(), input.event_date, input.place.trim(), input.notes],
        )?;
        let id = tx.last_insert_rowid();
        insert_items(&tx, id, &input.items)?;
        tx.commit()?;
        Ok(id)
    }

    /// Replaces the whole setlist (name, details and songs in order).
    pub fn save_setlist(&mut self, id: i64, input: &SetlistInput) -> Result<(), DbError> {
        check(input)?;
        let tx = self.conn.transaction()?;
        let n = tx.execute(
            "UPDATE setlists SET name = ?2, event_date = ?3, place = ?4, notes = ?5,
                                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1",
            params![id, input.name.trim(), input.event_date, input.place.trim(), input.notes],
        )?;
        if n == 0 {
            return Err(DbError::NotFound(format!("setlist {id}")));
        }
        tx.execute("DELETE FROM setlist_items WHERE setlist_id = ?1", [id])?;
        insert_items(&tx, id, &input.items)?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_setlist(&self, id: i64) -> Result<(), DbError> {
        let n = self.conn.execute("DELETE FROM setlists WHERE id = ?1", [id])?;
        if n == 0 { Err(DbError::NotFound(format!("setlist {id}"))) } else { Ok(()) }
    }

    /// Copy of a setlist ("<name> (copia)"), e.g. to reuse last Sunday's.
    pub fn duplicate_setlist(&mut self, id: i64) -> Result<i64, DbError> {
        let src = self.get_setlist(id)?.ok_or_else(|| DbError::NotFound(format!("setlist {id}")))?;
        let mut name = format!("{} (copia)", src.name);
        if name.chars().count() > 200 {
            name = name.chars().take(200).collect();
        }
        self.create_setlist(&SetlistInput {
            name,
            event_date: String::new(),
            place: src.place,
            notes: src.notes,
            items: src
                .items
                .into_iter()
                .map(|i| SetlistItemInput { song_id: i.song_id, notes: i.notes, transpose: i.transpose })
                .collect(),
        })
    }
}

fn insert_items(tx: &rusqlite::Transaction<'_>, setlist_id: i64, items: &[SetlistItemInput]) -> Result<(), DbError> {
    let mut stmt =
        tx.prepare("INSERT INTO setlist_items (setlist_id, song_id, position, notes, transpose) VALUES (?1, ?2, ?3, ?4, ?5)")?;
    for (pos, item) in items.iter().enumerate() {
        let exists: Option<i64> =
            tx.query_row("SELECT id FROM songs WHERE id = ?1", [item.song_id], |r| r.get(0)).optional()?;
        if exists.is_none() {
            return Err(DbError::NotFound(format!("canción {}", item.song_id)));
        }
        stmt.execute(params![setlist_id, item.song_id, pos as i64, item.notes, item.transpose])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::songs::{NewSongMeta, NewTrack};

    fn song(db: &mut Database, title: &str, secs: f64) -> i64 {
        let id = db
            .create_song(
                title,
                &[NewTrack { name: "Click".into(), file_path: format!("C:/{title}/click.wav"), role: "click".into() }],
                &NewSongMeta { original_bpm: Some(90.0), time_signature: "4/4".into(), source_archive: None },
            )
            .unwrap();
        db.set_song_duration(id, secs).unwrap();
        id
    }

    #[test]
    fn song_details_round_trip() {
        use crate::songs::SongDetails;
        let mut db = Database::open_in_memory().unwrap();
        let id = song(&mut db, "Ancient", 200.0);
        let d = SongDetails {
            title: "Ancient of Days".into(),
            artist: "  Autor  ".into(),
            song_key: "D".into(),
            notes: "Entrada solo pads".into(),
            time_signature: "6/8".into(),
        };
        db.set_song_details(id, &d).unwrap();
        let s = db.get_song(id).unwrap().unwrap();
        assert_eq!((s.title.as_str(), s.artist.as_str(), s.song_key.as_str(), s.notes.as_str(), s.time_signature.as_str()),
                   ("Ancient of Days", "Autor", "D", "Entrada solo pads", "6/8"));
        assert_eq!(db.library().unwrap()[0].song_key, "D");
        let mut bad = d.clone();
        bad.time_signature = "7/8".into();
        assert!(db.set_song_details(id, &bad).is_err());
        bad = d.clone();
        bad.song_key = "x".repeat(21);
        assert!(db.set_song_details(id, &bad).is_err());
    }

    #[test]
    fn setlist_lifecycle() {
        let mut db = Database::open_in_memory().unwrap();
        let a = song(&mut db, "Ancient", 200.0);
        let b = song(&mut db, "Way Maker", 300.0);
        let input = SetlistInput {
            name: "Domingo 23".into(),
            event_date: "2026-11-23".into(),
            place: "Templo".into(),
            notes: String::new(),
            items: vec![
                SetlistItemInput { song_id: b, notes: "coro x2".into(), transpose: Some(-2) },
                SetlistItemInput { song_id: a, notes: String::new(), transpose: None },
            ],
        };
        let id = db.create_setlist(&input).unwrap();
        let list = db.get_setlist(id).unwrap().unwrap();
        assert_eq!(list.items.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), ["Way Maker", "Ancient"]);
        assert_eq!(list.items[0].notes, "coro x2");
        assert_eq!((list.items[0].transpose, list.items[1].transpose), (Some(-2), None));
        db.set_song_transpose(a, 3).unwrap();
        assert_eq!(db.get_setlist(id).unwrap().unwrap().items[1].song_transpose, 3);
        assert!(db.set_song_transpose(a, 13).is_err());
        let sum = db.setlists().unwrap();
        assert_eq!(sum[0].song_count, 2);
        assert_eq!(sum[0].total_sec, 500.0);

        // Reorder + repeat a song.
        let mut changed = input.clone();
        changed.items = vec![
            SetlistItemInput { song_id: a, notes: String::new(), transpose: None },
            SetlistItemInput { song_id: b, notes: String::new(), transpose: None },
            SetlistItemInput { song_id: a, notes: "final".into(), transpose: Some(1) },
        ];
        db.save_setlist(id, &changed).unwrap();
        assert_eq!(db.get_setlist(id).unwrap().unwrap().items.len(), 3);

        // Validation.
        let mut bad = changed.clone();
        bad.event_date = "23/11/2026".into();
        assert!(db.save_setlist(id, &bad).is_err());
        bad = changed.clone();
        bad.items.push(SetlistItemInput { song_id: 999, notes: String::new(), transpose: None });
        assert!(db.save_setlist(id, &bad).is_err());
        assert_eq!(db.get_setlist(id).unwrap().unwrap().items.len(), 3, "a failed save changes nothing");

        // Duplicate, delete a song from the library (leaves every setlist), delete the setlist.
        let copy = db.duplicate_setlist(id).unwrap();
        assert_eq!(db.get_setlist(copy).unwrap().unwrap().name, "Domingo 23 (copia)");
        db.delete_song(a).unwrap();
        assert_eq!(db.get_setlist(id).unwrap().unwrap().items.len(), 1);
        db.delete_setlist(id).unwrap();
        assert!(db.get_setlist(id).unwrap().is_none());
        assert_eq!(db.setlists().unwrap().len(), 1);
    }
}
