//! Multitrack Studio: open songs, transport, tempo, sections.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use liveplayer_db::{Database, NewSongMeta, NewTrack, SectionRecord, SongRecord, SongSummary, SongTempo, beats_per_bar};
use liveplayer_engine::{Engine, OutputInfo, OutputMode, SongStatus, TrackRequest, TransportState, engine_role};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::database::DbState;
use crate::error::{CommandError, CommandResult};

/// Id of the song currently loaded (or loading) in the engine.
#[derive(Default)]
pub struct CurrentSong(pub Mutex<Option<i64>>);

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &["wav", "wave", "mp3", "aif", "aiff", "flac", "ogg"];
const MAX_TRACKS: usize = 64;

pub(crate) fn lock<T>(m: &Mutex<T>) -> CommandResult<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| CommandError::state("estado bloqueado por un error previo"))
}

fn is_audio_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    AUDIO_EXTENSIONS.contains(&ext.as_str()) && path.is_file()
}

/// A dropped/picked folder stands for the audio files directly inside it.
fn expand_folders(paths: &[String]) -> CommandResult<Vec<String>> {
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            let entries = std::fs::read_dir(path)
                .map_err(|e| CommandError::invalid(format!("no se puede leer la carpeta {p}: {e}")))?;
            let before = out.len();
            for entry in entries.flatten() {
                let file = entry.path();
                if is_audio_file(&file) {
                    out.push(file.to_string_lossy().into_owned());
                }
            }
            if out.len() == before {
                return Err(CommandError::invalid(format!("la carpeta no contiene archivos de audio: {p}")));
            }
        } else {
            out.push(p.clone());
        }
    }
    Ok(out)
}

pub(crate) fn validate_files(paths: &[String]) -> CommandResult<Vec<String>> {
    let paths = expand_folders(paths)?;
    if paths.is_empty() {
        return Err(CommandError::invalid("selecciona al menos un archivo de audio"));
    }
    if paths.len() > MAX_TRACKS {
        return Err(CommandError::invalid(format!("máximo {MAX_TRACKS} pistas por canción")));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in &paths {
        let path = Path::new(p);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            return Err(CommandError::invalid(format!(
                "formato no soportado: {} (se admiten WAV, MP3, AIFF, FLAC y OGG)",
                path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
            )));
        }
        if !path.is_file() {
            return Err(CommandError::invalid(format!("no se encuentra el archivo: {p}")));
        }
        if seen.insert(p.clone()) {
            out.push(p.clone());
        }
    }
    // Stable, predictable order (Click, Drums, ... as in the folder).
    out.sort_by_key(|p| p.to_lowercase());
    Ok(out)
}

fn file_stem(p: &str) -> String {
    Path::new(p).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

/// Song title from the folder that contains the stems (usual multitrack layout).
fn title_for(paths: &[String]) -> String {
    let parent = Path::new(&paths[0]).parent();
    let same_folder = paths.iter().all(|p| Path::new(p).parent() == parent);
    match parent.and_then(|d| d.file_name()) {
        Some(name) if same_folder => name.to_string_lossy().into_owned(),
        _ => file_stem(&paths[0]),
    }
}

pub(crate) fn load_into_engine(engine: &Engine, song: &SongRecord) -> CommandResult<()> {
    let missing: Vec<&str> =
        song.tracks.iter().filter(|t| !Path::new(&t.file_path).is_file()).map(|t| t.file_path.as_str()).collect();
    if !missing.is_empty() {
        return Err(CommandError::invalid(format!("faltan archivos de esta canción: {}", missing.join(", "))));
    }
    let tracks: Vec<TrackRequest> = song
        .tracks
        .iter()
        .map(|t| TrackRequest {
            path: t.file_path.clone(),
            name: t.name.clone(),
            role: Some(engine_role(&t.role).to_string()),
            bus: Some(t.bus.clone()),
        })
        .collect();
    engine.load_song(&tracks, song.original_bpm, beats_per_bar(&song.time_signature))?;
    Ok(())
}

// ---- Output routing settings (persisted) -------------------------------------

const OUTPUT_MODE_KEY: &str = "output.mode";
const MONITOR_GAIN_KEY: &str = "output.monitorGain";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub mode: OutputMode,
    pub monitor_gain: f64,
}

fn read_output_settings(db: &Database) -> OutputSettings {
    let mode = db
        .get_setting(OUTPUT_MODE_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<OutputMode>(&v).ok())
        .unwrap_or(OutputMode::Stereo);
    let monitor_gain = db
        .get_setting(MONITOR_GAIN_KEY)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|g| (0.0..=2.0).contains(g))
        .unwrap_or(1.0);
    OutputSettings { mode, monitor_gain }
}

/// Applies the saved routing (called after the device opens with a song load).
/// A saved 4-channel mode on a 2-channel device falls back to stereo.
pub(crate) fn apply_output_settings(engine: &Engine, db: &Database) {
    let s = read_output_settings(db);
    let _ = engine.set_monitor_gain(s.monitor_gain);
    if engine.set_output_mode(s.mode).is_err() {
        let _ = engine.set_output_mode(OutputMode::Stereo);
    }
}

#[tauri::command]
pub fn studio_output_settings(db: State<'_, DbState>) -> CommandResult<OutputSettings> {
    Ok(read_output_settings(&*lock(&db)?))
}

#[tauri::command]
pub fn studio_set_output(engine: State<'_, Engine>, db: State<'_, DbState>, settings: OutputSettings) -> CommandResult<()> {
    if !(0.0..=2.0).contains(&settings.monitor_gain) {
        return Err(CommandError::invalid("volumen de monitoreo fuera de rango"));
    }
    engine.open_default_output()?;
    engine.set_output_mode(settings.mode)?;
    engine.set_monitor_gain(settings.monitor_gain)?;
    let db = lock(&db)?;
    db.set_setting(OUTPUT_MODE_KEY, &serde_json::to_string(&settings.mode).unwrap_or_else(|_| "\"stereo\"".into()))?;
    db.set_setting(MONITOR_GAIN_KEY, &settings.monitor_gain.to_string())?;
    Ok(())
}

/// Audition helper: per-track gain (0 mutes, 1 normal).
#[tauri::command]
pub fn studio_set_track_gain(engine: State<'_, Engine>, track: i32, gain: f64) -> CommandResult<()> {
    Ok(engine.set_track_gain(track, gain)?)
}

/// Renames a track / changes what it is; its output (PA or band) follows.
#[tauri::command]
pub fn studio_update_track(
    engine: State<'_, Engine>,
    db: State<'_, DbState>,
    current: State<'_, CurrentSong>,
    song_id: i64,
    position: u32,
    name: String,
    role: String,
) -> CommandResult<SongRecord> {
    let db = lock(&db)?;
    db.update_track(song_id, position, &name, &role)?;
    let song = db.get_song(song_id)?.ok_or_else(|| CommandError::invalid("la canción no existe"))?;
    if *lock(&current.0)? == Some(song_id)
        && let Some(t) = song.tracks.iter().find(|t| t.position == position)
    {
        engine.set_track_route(position as i32, &t.bus, engine_role(&t.role))?;
    }
    Ok(song)
}

#[tauri::command]
pub fn studio_set_song_info(db: State<'_, DbState>, song_id: i64, title: String, time_signature: String) -> CommandResult<()> {
    Ok(lock(&db)?.set_song_info(song_id, &title, &time_signature)?)
}

#[tauri::command]
pub fn studio_open_files(
    engine: State<'_, Engine>,
    db: State<'_, DbState>,
    current: State<'_, CurrentSong>,
    paths: Vec<String>,
) -> CommandResult<SongRecord> {
    let files = validate_files(&paths)?;
    let mut db = lock(&db)?;
    let id = match db.find_song_by_files(&files)? {
        Some(id) => id,
        None => {
            let tracks: Vec<NewTrack> = files
                .iter()
                .map(|p| NewTrack {
                    name: file_stem(p),
                    file_path: p.clone(),
                    role: crate::commands::import::guess_role(&file_stem(p)).unwrap_or("other").to_string(),
                })
                .collect();
            let meta = NewSongMeta { original_bpm: None, time_signature: "4/4".into(), source_archive: None };
            db.create_song(&title_for(&files), &tracks, &meta)?
        }
    };
    db.touch_song(id)?;
    let song = db.get_song(id)?.ok_or_else(|| CommandError::state("la canción no se guardó"))?;
    load_into_engine(&engine, &song)?;
    apply_output_settings(&engine, &db);
    *lock(&current.0)? = Some(id);
    Ok(song)
}

#[tauri::command]
pub fn studio_open_song(
    engine: State<'_, Engine>,
    db: State<'_, DbState>,
    current: State<'_, CurrentSong>,
    song_id: i64,
) -> CommandResult<SongRecord> {
    let db = lock(&db)?;
    let song = db.get_song(song_id)?.ok_or_else(|| CommandError::invalid(format!("no existe la canción {song_id}")))?;
    load_into_engine(&engine, &song)?;
    apply_output_settings(&engine, &db);
    db.touch_song(song_id)?;
    *lock(&current.0)? = Some(song_id);
    Ok(song)
}

#[tauri::command]
pub fn studio_recent_songs(db: State<'_, DbState>) -> CommandResult<Vec<SongSummary>> {
    Ok(lock(&db)?.recent_songs(20)?)
}

#[tauri::command]
pub fn studio_get_song(db: State<'_, DbState>, song_id: i64) -> CommandResult<Option<SongRecord>> {
    Ok(lock(&db)?.get_song(song_id)?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioStatus {
    song_id: Option<i64>,
    engine: SongStatus,
}

#[tauri::command]
pub fn studio_status(engine: State<'_, Engine>, current: State<'_, CurrentSong>) -> CommandResult<StudioStatus> {
    Ok(StudioStatus { song_id: *lock(&current.0)?, engine: engine.song_status()? })
}

/// Waveform overview as raw bytes (ArrayBuffer on the JS side).
#[tauri::command]
pub fn studio_peaks(engine: State<'_, Engine>, track: i32) -> CommandResult<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(engine.peaks(track)?))
}

#[tauri::command]
pub fn studio_detect_sections(
    engine: State<'_, Engine>,
    bpm: f64,
    downbeat_offset_sec: f64,
    beats_per_bar: i32,
) -> CommandResult<()> {
    Ok(engine.detect_sections(bpm, downbeat_offset_sec, beats_per_bar)?)
}

#[tauri::command]
pub fn studio_save_sections(db: State<'_, DbState>, song_id: i64, sections: Vec<SectionRecord>) -> CommandResult<()> {
    Ok(lock(&db)?.replace_sections(song_id, &sections)?)
}

#[tauri::command]
pub fn studio_save_tempo(db: State<'_, DbState>, song_id: i64, tempo: SongTempo) -> CommandResult<()> {
    Ok(lock(&db)?.set_song_tempo(song_id, &tempo)?)
}

#[tauri::command]
pub fn output_info(engine: State<'_, Engine>) -> CommandResult<OutputInfo> {
    Ok(engine.output_info()?)
}

// ---- Transport ---------------------------------------------------------------

#[tauri::command]
pub fn transport_play(engine: State<'_, Engine>) -> CommandResult<()> {
    Ok(engine.play()?)
}

#[tauri::command]
pub fn transport_pause(engine: State<'_, Engine>) -> CommandResult<()> {
    Ok(engine.pause()?)
}

#[tauri::command]
pub fn transport_stop(engine: State<'_, Engine>) -> CommandResult<()> {
    Ok(engine.stop()?)
}

#[tauri::command]
pub fn transport_seek(engine: State<'_, Engine>, position_sec: f64) -> CommandResult<()> {
    Ok(engine.seek(position_sec)?)
}

#[tauri::command]
pub fn transport_set_master_gain(engine: State<'_, Engine>, gain: f64) -> CommandResult<()> {
    Ok(engine.set_master_gain(gain)?)
}

#[tauri::command]
pub fn transport_set_tempo_ratio(engine: State<'_, Engine>, ratio: f64) -> CommandResult<()> {
    Ok(engine.set_tempo_ratio(ratio)?)
}

#[tauri::command]
pub fn transport_state(engine: State<'_, Engine>) -> CommandResult<TransportState> {
    Ok(engine.transport()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_validation() {
        let a = vec!["C:\\Musica\\Way Maker\\Click.wav".to_string(), "C:\\Musica\\Way Maker\\Bass.mp3".to_string()];
        assert_eq!(title_for(&a), "Way Maker");
        let b = vec!["C:\\x\\One.wav".to_string(), "C:\\y\\Two.wav".to_string()];
        assert_eq!(title_for(&b), "One");
        assert!(validate_files(&[]).is_err());
        assert!(validate_files(&["C:\\nope\\song.txt".to_string()]).is_err());
        assert!(validate_files(&["C:\\definitely\\missing.wav".to_string()]).is_err());
    }
}
