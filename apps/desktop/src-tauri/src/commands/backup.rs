//! Library backup (phase 5): one .zip with every song (audio, mix, parts,
//! tempo, details) and every setlist, to restore it on another computer.
//!
//! Layout: `liveplayer-backup.json` (manifest) + `audio/<song>/<track>-<file>`.
//! Audio is stored uncompressed (WAV/MP3 barely compress; storing is fast).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use liveplayer_db::{
    Database, NewSongMeta, NewTrack, SectionRecord, SetlistInput, SetlistItemInput, SongDetails, SongTempo, TrackMix,
    TrackOrder,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::database::DbState;
use crate::commands::studio::lock;
use crate::error::{CommandError, CommandResult};

const MANIFEST: &str = "liveplayer-backup.json";
const FORMAT: &str = "liveplayer-backup";
const VERSION: u32 = 1;
/// Refuse absurd archives (zip bombs): 64 GB of audio, 20 000 entries.
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
    songs: Vec<SongExport>,
    setlists: Vec<SetlistExport>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SongExport {
    title: String,
    artist: String,
    song_key: String,
    notes: String,
    time_signature: String,
    tempo: SongTempo,
    duration_sec: Option<f64>,
    #[serde(default)]
    transpose: i32,
    sections: Vec<SectionRecord>,
    tracks: Vec<TrackExport>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackExport {
    name: String,
    role: String,
    display_order: u32,
    mixer_order: u32,
    volume_db: f64,
    muted: bool,
    soloed: bool,
    /// Path inside the zip.
    file: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetlistExport {
    name: String,
    event_date: String,
    place: String,
    notes: String,
    /// (index into `songs`, notes, key for this setlist)
    items: Vec<(usize, String, Option<i32>)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    pub songs: u32,
    pub setlists: u32,
    /// Songs already in the library (not imported twice).
    pub skipped_songs: u32,
    /// Audio files that could not be found when exporting.
    pub missing_files: Vec<String>,
}

fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() { "pista".into() } else { trimmed.chars().take(80).collect() }
}

fn io(e: impl std::fmt::Display) -> CommandError {
    CommandError::invalid(e.to_string())
}

/// Writes the whole library to `path` (.zip).
#[tauri::command]
pub fn backup_export(db: State<'_, DbState>, path: String) -> CommandResult<BackupReport> {
    let db = lock(&db)?;
    export_to(&db, Path::new(&path))
}

pub(crate) fn export_to(db: &Database, path: &Path) -> CommandResult<BackupReport> {
    let library = db.library()?;
    let mut manifest = Manifest { format: FORMAT.into(), version: VERSION, songs: Vec::new(), setlists: Vec::new() };
    let mut index_of: HashMap<i64, usize> = HashMap::new();
    let mut files: Vec<(String, String)> = Vec::new(); // (zip path, disk path)
    let mut missing = Vec::new();

    for (i, row) in library.iter().enumerate() {
        let Some(song) = db.get_song(row.id)? else { continue };
        index_of.insert(song.id, i);
        let folder = format!("audio/{:04}-{}", i + 1, safe_name(&song.title));
        let mut tracks = Vec::new();
        for t in &song.tracks {
            let file_name = Path::new(&t.file_path).file_name().and_then(|n| n.to_str()).unwrap_or("audio");
            let zip_path = format!("{folder}/{:02}-{}", t.position + 1, safe_name(file_name));
            if Path::new(&t.file_path).is_file() {
                files.push((zip_path.clone(), t.file_path.clone()));
            } else {
                missing.push(t.file_path.clone());
            }
            tracks.push(TrackExport {
                name: t.name.clone(),
                role: t.role.clone(),
                display_order: t.display_order,
                mixer_order: t.mixer_order,
                volume_db: t.volume_db,
                muted: t.muted,
                soloed: t.soloed,
                file: zip_path,
            });
        }
        manifest.songs.push(SongExport {
            title: song.title.clone(),
            artist: song.artist.clone(),
            song_key: song.song_key.clone(),
            notes: song.notes.clone(),
            time_signature: song.time_signature.clone(),
            tempo: SongTempo {
                original_bpm: song.original_bpm,
                bpm_source: song.bpm_source.clone(),
                downbeat_offset_sec: song.downbeat_offset_sec,
                target_bpm: song.target_bpm,
            },
            duration_sec: row.duration_sec,
            transpose: song.transpose,
            sections: song.sections.clone(),
            tracks,
        });
    }
    for s in db.setlists()? {
        let Some(list) = db.get_setlist(s.id)? else { continue };
        manifest.setlists.push(SetlistExport {
            name: list.name,
            event_date: list.event_date,
            place: list.place,
            notes: list.notes,
            items: list
                .items
                .iter()
                .filter_map(|it| index_of.get(&it.song_id).map(|&i| (i, it.notes.clone(), it.transpose)))
                .collect(),
        });
    }

    // Write to a temporary file first: a failed export never leaves half a zip.
    let tmp = path.with_extension("zip.partial");
    let result = (|| -> CommandResult<()> {
        let mut zip = zip::ZipWriter::new(File::create(&tmp).map_err(io)?);
        let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);
        zip.start_file(MANIFEST, deflated).map_err(io)?;
        zip.write_all(serde_json::to_string_pretty(&manifest).map_err(io)?.as_bytes()).map_err(io)?;
        for (zip_path, disk) in &files {
            zip.start_file(zip_path.as_str(), stored).map_err(io)?;
            let mut f = File::open(disk).map_err(io)?;
            std::io::copy(&mut f, &mut zip).map_err(io)?;
        }
        zip.finish().map_err(io)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).map_err(io)?;
    Ok(BackupReport {
        songs: manifest.songs.len() as u32,
        setlists: manifest.setlists.len() as u32,
        skipped_songs: 0,
        missing_files: missing,
    })
}

/// Restores a backup into the library (adds; never deletes anything). Songs
/// already present (same title and track names) are not duplicated.
#[tauri::command]
pub fn backup_import(app: tauri::AppHandle, db: State<'_, DbState>, path: String) -> CommandResult<BackupReport> {
    let dest = crate::data_dir(&app).map_err(io)?.join("library");
    let mut db = lock(&db)?;
    import_from(&mut db, Path::new(&path), &dest)
}

pub(crate) fn import_from(db: &mut Database, path: &Path, library: &Path) -> CommandResult<BackupReport> {
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(io)?)
        .map_err(|e| CommandError::invalid(format!("no es una copia de seguridad válida: {e}")))?;
    if archive.len() > MAX_ENTRIES {
        return Err(CommandError::invalid("la copia tiene demasiados archivos"));
    }
    let manifest: Manifest = {
        let mut entry = archive
            .by_name(MANIFEST)
            .map_err(|_| CommandError::invalid("no es una copia de seguridad de LIVEPLAYER (falta el índice)"))?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(io)?;
        serde_json::from_str(&text).map_err(|e| CommandError::invalid(format!("índice dañado: {e}")))?
    };
    if manifest.format != FORMAT || manifest.version > VERSION {
        return Err(CommandError::invalid("esta copia es de una versión más nueva de LIVEPLAYER"));
    }
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        total += archive.by_index(i).map_err(io)?.size();
    }
    if total > MAX_TOTAL_BYTES {
        return Err(CommandError::invalid("la copia es demasiado grande"));
    }

    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let root = library.join(format!("restaurado-{stamp}"));
    let existing = db.library()?;
    let mut ids: Vec<Option<i64>> = Vec::new();
    let mut imported = 0u32;
    let mut skipped = 0u32;

    for (i, s) in manifest.songs.iter().enumerate() {
        // Already in the library? (same title and the same track names)
        let names: Vec<&str> = s.tracks.iter().map(|t| t.name.as_str()).collect();
        let mut found = None;
        for e in existing.iter().filter(|e| e.title == s.title) {
            if let Some(rec) = db.get_song(e.id)?
                && rec.tracks.iter().map(|t| t.name.as_str()).collect::<Vec<_>>() == names
            {
                found = Some(e.id);
                break;
            }
        }
        if let Some(id) = found {
            ids.push(Some(id));
            skipped += 1;
            continue;
        }

        let folder = root.join(format!("{:04}-{}", i + 1, safe_name(&s.title)));
        std::fs::create_dir_all(&folder).map_err(io)?;
        let mut new_tracks = Vec::new();
        for t in &s.tracks {
            // Only the file name is used: paths in the zip can never escape the folder.
            let name = Path::new(&t.file).file_name().and_then(|n| n.to_str()).map(safe_name).unwrap_or_else(|| "pista".into());
            let target: PathBuf = folder.join(name);
            let mut entry = archive.by_name(&t.file).map_err(|_| CommandError::invalid(format!("falta el audio {}", t.file)))?;
            let mut out = File::create(&target).map_err(io)?;
            std::io::copy(&mut entry, &mut out).map_err(io)?;
            new_tracks.push(NewTrack { name: t.name.clone(), file_path: target.to_string_lossy().into_owned(), role: t.role.clone() });
        }
        let id = db.create_song(
            &s.title,
            &new_tracks,
            &NewSongMeta { original_bpm: s.tempo.original_bpm, time_signature: s.time_signature.clone(), source_archive: None },
        )?;
        db.set_song_tempo(id, &s.tempo)?;
        db.set_song_details(
            id,
            &SongDetails {
                title: s.title.clone(),
                artist: s.artist.clone(),
                song_key: s.song_key.clone(),
                notes: s.notes.clone(),
                time_signature: s.time_signature.clone(),
            },
        )?;
        if !s.sections.is_empty() {
            db.replace_sections(id, &s.sections)?;
        }
        if let Some(d) = s.duration_sec {
            db.set_song_duration(id, d)?;
        }
        if s.transpose != 0 {
            db.set_song_transpose(id, s.transpose)?;
        }
        let order = |key: fn(&TrackExport) -> u32| {
            let mut idx: Vec<u32> = (0..s.tracks.len() as u32).collect();
            idx.sort_by_key(|&p| key(&s.tracks[p as usize]));
            idx
        };
        let _ = db.set_track_order(id, TrackOrder::Tracks, &order(|t| t.display_order));
        let _ = db.set_track_order(id, TrackOrder::Mixer, &order(|t| t.mixer_order));
        for (p, t) in s.tracks.iter().enumerate() {
            let _ = db.set_track_mix(id, p as u32, &TrackMix { volume_db: t.volume_db, muted: t.muted, soloed: t.soloed });
        }
        ids.push(Some(id));
        imported += 1;
    }

    let mut setlists = 0u32;
    let existing_lists: Vec<(String, String)> = db.setlists()?.into_iter().map(|l| (l.name, l.event_date)).collect();
    for l in &manifest.setlists {
        if existing_lists.iter().any(|(n, d)| *n == l.name && *d == l.event_date) {
            continue; // already restored before
        }
        let items: Vec<SetlistItemInput> = l
            .items
            .iter()
            .filter_map(|(i, notes, transpose)| {
                ids.get(*i).copied().flatten().map(|song_id| SetlistItemInput { song_id, notes: notes.clone(), transpose: *transpose })
            })
            .collect();
        db.create_setlist(&SetlistInput {
            name: l.name.clone(),
            event_date: l.event_date.clone(),
            place: l.place.clone(),
            notes: l.notes.clone(),
            items,
        })?;
        setlists += 1;
    }
    Ok(BackupReport { songs: imported, setlists, skipped_songs: skipped, missing_files: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_then_import_on_another_library() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("Mi canción");
        std::fs::create_dir_all(&audio).unwrap();
        std::fs::write(audio.join("click.wav"), b"RIFF-click").unwrap();
        std::fs::write(audio.join("bass.wav"), b"RIFF-bass").unwrap();

        let mut a = Database::open_in_memory().unwrap();
        let id = a
            .create_song(
                "Mi canción",
                &[
                    NewTrack { name: "Click".into(), file_path: audio.join("click.wav").to_string_lossy().into(), role: "click".into() },
                    NewTrack { name: "Bajo".into(), file_path: audio.join("bass.wav").to_string_lossy().into(), role: "bass".into() },
                ],
                &NewSongMeta { original_bpm: Some(72.0), time_signature: "6/8".into(), source_archive: None },
            )
            .unwrap();
        a.set_song_details(id, &SongDetails { title: "Mi canción".into(), artist: "Yo".into(), song_key: "G".into(), notes: "n".into(), time_signature: "6/8".into() }).unwrap();
        a.replace_sections(id, &[SectionRecord { start_sec: 0.0, kind: "intro".into(), label: "Intro".into(), source: "user".into() }]).unwrap();
        a.set_track_mix(id, 1, &TrackMix { volume_db: -6.5, muted: true, soloed: false }).unwrap();
        a.create_setlist(&SetlistInput {
            name: "Domingo".into(),
            event_date: "2026-11-23".into(),
            place: String::new(),
            notes: String::new(),
            items: vec![SetlistItemInput { song_id: id, notes: "x2".into(), transpose: Some(-1) }],
        })
        .unwrap();

        let zip = dir.path().join("copia.zip");
        let rep = export_to(&a, &zip).unwrap();
        assert_eq!((rep.songs, rep.setlists, rep.missing_files.len()), (1, 1, 0));

        let mut b = Database::open_in_memory().unwrap();
        let lib = dir.path().join("otra-biblioteca");
        let rep = import_from(&mut b, &zip, &lib).unwrap();
        assert_eq!((rep.songs, rep.setlists, rep.skipped_songs), (1, 1, 0));
        let s = b.library().unwrap();
        let song = b.get_song(s[0].id).unwrap().unwrap();
        assert_eq!((song.artist.as_str(), song.song_key.as_str(), song.time_signature.as_str()), ("Yo", "G", "6/8"));
        assert_eq!(song.sections.len(), 1);
        assert_eq!(song.tracks[1].volume_db, -6.5);
        assert!(song.tracks[1].muted);
        assert_eq!(std::fs::read(&song.tracks[1].file_path).unwrap(), b"RIFF-bass");
        assert!(Path::new(&song.tracks[0].file_path).starts_with(&lib));
        let list = b.get_setlist(b.setlists().unwrap()[0].id).unwrap().unwrap();
        assert_eq!((list.items[0].notes.as_str(), list.items[0].transpose), ("x2", Some(-1)));

        // Importing again does not duplicate the song.
        let rep = import_from(&mut b, &zip, &lib).unwrap();
        assert_eq!((rep.songs, rep.skipped_songs, rep.setlists), (0, 1, 0));
        assert_eq!(b.setlists().unwrap().len(), 1);
        assert_eq!(b.library().unwrap().len(), 1);

        // Something that is not a backup is refused.
        std::fs::write(dir.path().join("x.zip"), b"nope").unwrap();
        assert!(import_from(&mut b, &dir.path().join("x.zip"), &lib).is_err());
    }
}
