//! Song import: zip files, folders or loose files -> a review step where the
//! user confirms title, BPM, time signature and what every file is.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use liveplayer_db::{NewSongMeta, NewTrack, SongRecord, TIME_SIGNATURES, TRACK_ROLES, beats_per_bar, bus_for_role};
use liveplayer_engine::{Engine, TrackRequest, engine_role};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::database::DbState;
use crate::commands::studio::{AUDIO_EXTENSIONS, CurrentSong, apply_output_settings, lock, validate_files};
use crate::error::{CommandError, CommandResult};

const MAX_ZIP_ENTRIES: usize = 256;
const MAX_ZIP_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GB uncompressed

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub file_path: String,
    pub file_name: String,
    pub suggested_name: String,
    pub suggested_role: String,
    /// false = the name did not tell what the file is: ask the user.
    pub recognized: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportDraft {
    /// `zip`, `folder` or `files`.
    pub source_kind: String,
    pub source_path: Option<String>,
    /// Folder where a zip was extracted (inside the app's library).
    pub extracted_dir: Option<String>,
    pub suggested_title: String,
    pub suggested_bpm: Option<f64>,
    pub suggested_time_signature: String,
    pub files: Vec<ImportFile>,
    /// The same files/zip were already imported: open that song instead.
    pub existing_song_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportTrack {
    pub file_path: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommit {
    pub title: String,
    pub bpm: Option<f64>,
    pub time_signature: String,
    pub source_archive: Option<String>,
    pub tracks: Vec<ImportTrack>,
}

// ---- Recognising files -------------------------------------------------------

fn words(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_digit = false;
    for ch in lower.chars() {
        let is_digit = ch.is_ascii_digit();
        if ch.is_alphanumeric() {
            // "Gtr2" -> "gtr", "2"
            if !cur.is_empty() && is_digit != prev_digit {
                out.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
            prev_digit = is_digit;
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Guesses what a file is from its name (English and Spanish).
pub fn guess_role(file_stem: &str) -> Option<&'static str> {
    let w = words(file_stem);
    let has = |list: &[&str]| w.iter().any(|x| list.iter().any(|k| x == k || (k.len() >= 4 && x.starts_with(k))));
    let pair = |a: &[&str], b: &[&str]| has(a) && has(b);

    // Order matters: the most specific first.
    if has(&["click", "clic", "metronome", "metrónomo", "metronomo", "countin", "conteo"]) {
        return Some("click");
    }
    if has(&["cue", "cues", "guide", "guía", "guia", "guias", "guías", "vocal guide"]) {
        return Some("cues");
    }
    if pair(&["acoustic", "acustica", "acústica", "ac", "acgtr"], &["guitar", "gtr", "guitarra", "guit"]) || has(&["acgtr", "acoustic"]) {
        return Some("acoustic_guitar");
    }
    if has(&["guitar", "gtr", "guitarra", "guitarras", "egtr", "eg", "elec", "eléctrica"]) {
        return Some("electric_guitar");
    }
    if has(&["bass", "bajo", "sub", "808"]) {
        return Some("bass");
    }
    if has(&["drums", "drum", "batería", "bateria", "bat", "kit", "kick", "bombo", "snare", "caja", "toms", "overheads", "oh"]) {
        return Some("drums");
    }
    if has(&["perc", "percussion", "percusión", "percusion", "shaker", "tamb", "tambourine", "pandereta", "congas", "claps"]) {
        return Some("percussion");
    }
    if has(&["piano", "pno"]) {
        return Some("piano");
    }
    if has(&["pad", "pads", "ambient", "ambiente", "atmos", "swell"]) {
        return Some("pads");
    }
    if has(&["synth", "synths", "sintetizador", "sinte", "arp", "lead synth", "moog"]) {
        return Some("synth");
    }
    if has(&["keys", "key", "teclado", "teclados", "rhodes", "wurli", "organ", "órgano", "organo", "b3", "hammond"]) {
        return Some("keys");
    }
    if has(&["strings", "string", "cuerdas", "cuerda", "violin", "violín", "cello", "orchestra", "orquesta"]) {
        return Some("strings");
    }
    if has(&["brass", "horns", "horn", "vientos", "metales", "trumpet", "trompeta", "sax", "trombone"]) {
        return Some("brass");
    }
    if has(&["bgv", "bgvs", "coros", "coro", "choir", "backing", "harmony", "harmonies", "armonías", "armonias", "bvs"]) {
        // "Backing track" is a different thing.
        if has(&["track", "tracks"]) && !has(&["vocal", "vocals", "vox", "voces"]) {
            return Some("backing_track");
        }
        return Some("backing_vocals");
    }
    if has(&["vocal", "vocals", "vox", "voz", "voces", "lead", "leadvox", "singer"]) {
        return Some("lead_vocal");
    }
    if has(&["loop", "loops", "seq", "sequence", "secuencia", "fx", "efectos", "riser", "sweep"]) {
        return Some("loops");
    }
    if has(&["backtrack", "backingtrack", "track", "pista", "playback", "stem", "instrumental", "mix", "rest"]) {
        return Some("backing_track");
    }
    None
}

fn file_stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// "Ancient_96bpm_Multitracks" -> ("Ancient", Some(96)).
pub fn title_and_bpm(raw: &str) -> (String, Option<f64>) {
    let cleaned: String = raw.chars().map(|c| if c == '_' || c == '.' { ' ' } else { c }).collect();
    let mut bpm = None;
    let mut kept = Vec::new();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        let lower = t.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()).to_string();
        let number_bpm = lower.strip_suffix("bpm").and_then(|n| n.parse::<f64>().ok());
        if let Some(n) = number_bpm.filter(|n| (40.0..=240.0).contains(n)) {
            bpm = Some(n);
        } else if let (Ok(n), Some(next)) = (lower.parse::<f64>(), tokens.get(i + 1))
            && next.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()) == "bpm"
            && (40.0..=240.0).contains(&n)
        {
            bpm = Some(n);
            i += 1;
        } else if !["multitrack", "multitracks", "stems", "secuencia", "secuencias", "tracks", "bpm", "-", "–"]
            .contains(&lower.as_str())
        {
            kept.push(t);
        }
        i += 1;
    }
    let title = kept.join(" ").trim_matches(|c: char| c == '-' || c == '–' || c.is_whitespace()).to_string();
    (if title.is_empty() { raw.to_string() } else { title }, bpm)
}

fn describe(paths: &[String]) -> Vec<ImportFile> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let stem = file_stem(path);
            let role = guess_role(&stem);
            ImportFile {
                file_path: p.clone(),
                file_name: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
                suggested_name: stem,
                suggested_role: role.unwrap_or("other").to_string(),
                recognized: role.is_some(),
                size_bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            }
        })
        .collect()
}

// ---- Zip extraction ----------------------------------------------------------

fn library_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    let dir = crate::data_dir(app).map_err(|e| CommandError::state(e.to_string()))?.join("library");
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::state(format!("no se pudo crear la biblioteca: {e}")))?;
    Ok(dir)
}

fn safe_folder_name(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '(' || c == ')' { c } else { '_' })
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() { "cancion".to_string() } else { s.chars().take(80).collect() }
}

/// Extracts the audio files of a zip (flattened, no paths kept) into a new
/// folder inside `library`. Returns the folder and the extracted files.
pub fn extract_zip(zip_path: &Path, library: &Path, title: &str) -> CommandResult<(PathBuf, Vec<String>)> {
    let file = File::open(zip_path).map_err(|e| CommandError::invalid(format!("no se puede abrir el zip: {e}")))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| CommandError::invalid(format!("el archivo no es un zip válido: {e}")))?;
    if archive.len() > MAX_ZIP_ENTRIES * 4 {
        return Err(CommandError::invalid("el zip contiene demasiados archivos"));
    }

    // Pick the audio entries first (name, index).
    let mut entries = Vec::new();
    let mut declared: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| CommandError::invalid(format!("zip dañado: {e}")))?;
        if entry.is_dir() {
            continue;
        }
        let raw = match entry.name() {
            Ok(n) => n.replace('\\', "/"),
            Err(_) => continue, // undecodable name: skip
        };
        if raw.split('/').any(|part| part == "__MACOSX" || part.starts_with('.')) {
            continue;
        }
        let Some(name) = raw.rsplit('/').next().map(str::to_string) else { continue };
        let ext = Path::new(&name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        declared += entry.size();
        entries.push((name, i));
    }
    if entries.is_empty() {
        return Err(CommandError::invalid("el zip no contiene archivos de audio (WAV, MP3, AIFF, FLAC u OGG)"));
    }
    if entries.len() > MAX_ZIP_ENTRIES || declared > MAX_ZIP_BYTES {
        return Err(CommandError::invalid("el zip es demasiado grande para una canción"));
    }

    // New folder (never overwrite an earlier import).
    let base = safe_folder_name(title);
    let mut dir = library.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = library.join(format!("{base} ({n})"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::state(format!("no se pudo crear la carpeta: {e}")))?;

    let mut used = HashSet::new();
    let mut out = Vec::new();
    let result: CommandResult<()> = (|| {
        for (name, index) in &entries {
            // Same file name in two zip folders -> keep both.
            let mut target_name = name.clone();
            let mut k = 2;
            while !used.insert(target_name.to_lowercase()) {
                let p = Path::new(name);
                target_name = format!(
                    "{} ({k}).{}",
                    file_stem(p),
                    p.extension().and_then(|e| e.to_str()).unwrap_or("")
                );
                k += 1;
            }
            let target = dir.join(&target_name);
            let mut entry = archive.by_index(*index).map_err(|e| CommandError::invalid(format!("zip dañado: {e}")))?;
            let limit = entry.size() + 1024 * 1024; // guard against lying headers (zip bombs)
            let mut dst = File::create(&target).map_err(|e| CommandError::state(format!("no se pudo escribir {target_name}: {e}")))?;
            let mut buf = vec![0u8; 1 << 16];
            let mut written: u64 = 0;
            loop {
                let r = entry.read(&mut buf).map_err(|e| CommandError::invalid(format!("error al descomprimir {name}: {e}")))?;
                if r == 0 {
                    break;
                }
                written += r as u64;
                if written > limit {
                    return Err(CommandError::invalid("el zip está dañado o es malicioso (tamaño falso)"));
                }
                dst.write_all(&buf[..r]).map_err(|e| CommandError::state(format!("no se pudo escribir {target_name}: {e}")))?;
            }
            out.push(target.to_string_lossy().into_owned());
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    out.sort_by_key(|p| p.to_lowercase());
    Ok((dir, out))
}

// ---- Commands ----------------------------------------------------------------

#[tauri::command]
pub fn studio_import_inspect(app: AppHandle, db: State<'_, DbState>, paths: Vec<String>) -> CommandResult<ImportDraft> {
    if paths.is_empty() {
        return Err(CommandError::invalid("no se seleccionó nada"));
    }
    let zips: Vec<&String> = paths.iter().filter(|p| p.to_lowercase().ends_with(".zip")).collect();

    if let Some(zip) = zips.first() {
        if paths.len() > 1 {
            return Err(CommandError::invalid("importa un zip a la vez (un zip = una canción)"));
        }
        let zip_path = Path::new(zip.as_str());
        if !zip_path.is_file() {
            return Err(CommandError::invalid(format!("no se encuentra el archivo: {zip}")));
        }
        let (title, bpm) = title_and_bpm(&file_stem(zip_path));
        {
            let db = lock(&db)?;
            if let Some(id) = db.find_song_by_archive(zip)?
                && db.get_song(id)?.is_some_and(|s| s.tracks.iter().all(|t| Path::new(&t.file_path).is_file()))
            {
                return Ok(ImportDraft {
                    source_kind: "zip".into(),
                    source_path: Some((*zip).clone()),
                    extracted_dir: None,
                    suggested_title: title,
                    suggested_bpm: bpm,
                    suggested_time_signature: "4/4".into(),
                    files: Vec::new(),
                    existing_song_id: Some(id),
                });
            }
        }
        let (dir, files) = extract_zip(zip_path, &library_dir(&app)?, &title)?;
        return Ok(ImportDraft {
            source_kind: "zip".into(),
            source_path: Some((*zip).clone()),
            extracted_dir: Some(dir.to_string_lossy().into_owned()),
            suggested_title: title,
            suggested_bpm: bpm,
            suggested_time_signature: "4/4".into(),
            files: describe(&files),
            existing_song_id: None,
        });
    }

    let files = validate_files(&paths)?;
    let folder = paths.len() == 1 && Path::new(&paths[0]).is_dir();
    let source_name = if folder {
        Path::new(&paths[0]).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        Path::new(&files[0])
            .parent()
            .and_then(|d| d.file_name())
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_stem(Path::new(&files[0])))
    };
    let (title, bpm) = title_and_bpm(&source_name);
    let existing = lock(&db)?.find_song_by_files(&files)?;
    Ok(ImportDraft {
        source_kind: if folder { "folder".into() } else { "files".into() },
        source_path: folder.then(|| paths[0].clone()),
        extracted_dir: None,
        suggested_title: title,
        suggested_bpm: bpm,
        suggested_time_signature: "4/4".into(),
        files: describe(&files),
        existing_song_id: existing,
    })
}

/// Loads the files into the engine so each one can be auditioned on its own.
#[tauri::command]
pub fn studio_import_preview(
    engine: State<'_, Engine>,
    db: State<'_, DbState>,
    current: State<'_, CurrentSong>,
    tracks: Vec<ImportTrack>,
) -> CommandResult<()> {
    if tracks.is_empty() {
        return Err(CommandError::invalid("no hay pistas para escuchar"));
    }
    let requests: Vec<TrackRequest> = tracks
        .iter()
        .map(|t| TrackRequest {
            path: t.file_path.clone(),
            name: t.name.clone(),
            role: Some(engine_role(&t.role).to_string()),
            bus: Some(bus_for_role(&t.role).to_string()),
        })
        .collect();
    let _ = engine.stop();
    engine.load_song(&requests, None, 4)?;
    apply_output_settings(&engine, &*lock(&db)?);
    *lock(&current.0)? = None;
    Ok(())
}

#[tauri::command]
pub fn studio_import_commit(
    engine: State<'_, Engine>,
    db: State<'_, DbState>,
    current: State<'_, CurrentSong>,
    commit: ImportCommit,
) -> CommandResult<SongRecord> {
    if commit.tracks.is_empty() {
        return Err(CommandError::invalid("la canción necesita al menos una pista"));
    }
    if !TIME_SIGNATURES.contains(&commit.time_signature.as_str()) {
        return Err(CommandError::invalid(format!("compás no soportado: {}", commit.time_signature)));
    }
    for t in &commit.tracks {
        if !TRACK_ROLES.contains(&t.role.as_str()) {
            return Err(CommandError::invalid(format!("tipo de pista desconocido: {}", t.role)));
        }
        if !Path::new(&t.file_path).is_file() {
            return Err(CommandError::invalid(format!("no se encuentra el archivo: {}", t.file_path)));
        }
    }
    let bpm = commit.bpm.filter(|b| *b > 0.0);
    let mut db = lock(&db)?;
    let tracks: Vec<NewTrack> = commit
        .tracks
        .iter()
        .map(|t| NewTrack { name: t.name.clone(), file_path: t.file_path.clone(), role: t.role.clone() })
        .collect();
    let meta = NewSongMeta {
        original_bpm: bpm,
        time_signature: commit.time_signature.clone(),
        source_archive: commit.source_archive.clone(),
    };
    let id = db.create_song(&commit.title, &tracks, &meta)?;
    let song = db.get_song(id)?.ok_or_else(|| CommandError::state("la canción no se guardó"))?;

    // The preview already holds these files in RAM: apply the confirmed roles
    // and re-analyse with the confirmed tempo/meter instead of decoding again.
    let status = engine.song_status()?;
    let same_files = status.state == "ready"
        && status
            .song
            .as_ref()
            .is_some_and(|s| s.tracks.iter().map(|t| &t.path).eq(commit.tracks.iter().map(|t| &t.file_path)));
    if same_files {
        for t in &song.tracks {
            engine.set_track_route(t.position as i32, &t.bus, engine_role(&t.role))?;
            engine.set_track_gain(t.position as i32, 1.0)?;
        }
        engine.detect_sections(bpm.unwrap_or(0.0), -1.0, beats_per_bar(&song.time_signature))?;
    } else {
        crate::commands::studio::load_into_engine(&engine, &song)?;
        apply_output_settings(&engine, &db);
    }
    *lock(&current.0)? = Some(id);
    Ok(song)
}

/// Discards an import: removes the files extracted from a zip (only inside the library).
#[tauri::command]
pub fn studio_import_cancel(app: AppHandle, engine: State<'_, Engine>, extracted_dir: Option<String>) -> CommandResult<()> {
    let _ = engine.stop();
    if let Some(dir) = extracted_dir {
        let library = library_dir(&app)?;
        let dir = PathBuf::from(dir);
        let inside = dir.canonicalize().ok().zip(library.canonicalize().ok()).is_some_and(|(d, l)| d.starts_with(&l) && d != l);
        if inside {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_common_stem_names() {
        let cases = [
            ("Click", Some("click")),
            ("01 - Click Track", Some("click")),
            ("Guia", Some("cues")),
            ("Cues", Some("cues")),
            ("Drums", Some("drums")),
            ("Batería", Some("drums")),
            ("Kick", Some("drums")),
            ("Bass", Some("bass")),
            ("Bajo", Some("bass")),
            ("Guitar", Some("electric_guitar")),
            ("EGtr 2", Some("electric_guitar")),
            ("Acoustic Guitar", Some("acoustic_guitar")),
            ("Guitarra Acústica", Some("acoustic_guitar")),
            ("Piano", Some("piano")),
            ("Keys", Some("keys")),
            ("Pad", Some("pads")),
            ("Synth Lead", Some("synth")),
            ("Cuerdas", Some("strings")),
            ("BGV", Some("backing_vocals")),
            ("Coros", Some("backing_vocals")),
            ("Lead Vocal", Some("lead_vocal")),
            ("Loop intro", Some("loops")),
            ("Backtrack", Some("backing_track")),
            ("Backing Track", Some("backing_track")),
            ("llmmD", None),
            ("Track 07", Some("backing_track")),
        ];
        for (name, want) in cases {
            assert_eq!(guess_role(name), want, "{name}");
        }
    }

    #[test]
    fn titles_and_bpm_from_names() {
        assert_eq!(title_and_bpm("Ancient"), ("Ancient".to_string(), None));
        assert_eq!(title_and_bpm("Way_Maker_68bpm_Multitracks"), ("Way Maker".to_string(), Some(68.0)));
        assert_eq!(title_and_bpm("Gracia Sublime - 72 BPM"), ("Gracia Sublime".to_string(), Some(72.0)));
        // Out-of-range numbers are not tempos.
        assert_eq!(title_and_bpm("Song 2000 bpm"), ("Song 2000".to_string(), None));
    }

    #[test]
    fn extracts_only_audio_and_flattens_paths() {
        let tmp = std::env::temp_dir().join(format!("lp-import-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let zip_path = tmp.join("Song 90bpm.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut z = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, data) in [
                ("Song/Click.wav", &b"RIFFfake"[..]),
                ("Song/sub/Drums.mp3", b"ID3fake"),
                ("../../evil/Bass.wav", b"RIFF"),
                ("__MACOSX/Song/._Click.wav", b"junk"),
                ("Song/readme.txt", b"hi"),
                ("Other/Click.wav", b"RIFF2"),
            ] {
                z.start_file(name, opts).unwrap();
                z.write_all(data).unwrap();
            }
            z.finish().unwrap();
        }
        let library = tmp.join("library");
        std::fs::create_dir_all(&library).unwrap();
        let (dir, files) = extract_zip(&zip_path, &library, "Song").unwrap();
        let names: Vec<String> =
            files.iter().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned()).collect();
        // Entries with ".." (path traversal) and hidden / macOS junk are dropped entirely.
        assert_eq!(names, vec!["Click (2).wav", "Click.wav", "Drums.mp3"]);
        assert!(files.iter().all(|p| Path::new(p).starts_with(&dir)), "nothing escapes the folder");
        assert!(!tmp.join("evil").exists());
        // A second import of the same title goes to a new folder.
        let (dir2, _) = extract_zip(&zip_path, &library, "Song").unwrap();
        assert_ne!(dir, dir2);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
