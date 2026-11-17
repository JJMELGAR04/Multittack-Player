//! Safe wrapper around the LIVEPLAYER native engine.
//!
//! Threading: the engine must be created and used on a single *control
//! thread* (the application's main thread, which is also JUCE's message
//! thread). [`Engine`] records that thread and every method refuses to run
//! from any other thread, returning [`EngineError::WrongThread`].
//! Real-time audio, decoding and analysis run on the engine's own threads.

#![allow(non_camel_case_types)]

mod ffi;

use std::ffi::{CStr, CString};
use std::ptr::NonNull;
use std::thread::{self, ThreadId};

use serde::{Deserialize, Serialize};

pub use ffi::ABI_VERSION;

/// Buckets per second in waveform overviews (`LP_PEAKS_PER_SECOND`).
pub const PEAKS_PER_SECOND: u32 = 100;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EngineError {
    #[error("el motor nativo no pudo inicializarse")]
    CreateFailed,
    #[error("ABI del motor incompatible: se esperaba v{expected}, la librería es v{found}")]
    AbiMismatch { expected: u32, found: u32 },
    #[error("el motor solo puede usarse desde su hilo de control")]
    WrongThread,
    #[error("argumento inválido enviado al motor{0}")]
    InvalidArgument(String),
    #[error("{0}")]
    InvalidState(String),
    #[error("error interno del motor: {0}")]
    Internal(String),
    #[error("respuesta del motor no válida: {0}")]
    InvalidResponse(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine_version: String,
    pub abi_version: u32,
    pub juce_version: String,
    pub build_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceType {
    pub name: String,
    pub output_devices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagnostics {
    pub device_types: Vec<AudioDeviceType>,
    #[serde(default)]
    pub asio_supported: bool,
}

/// A device chosen by the user (sample rate / buffer 0 = device default).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChoice {
    pub type_name: String,
    pub device_name: String,
    #[serde(default)]
    pub sample_rate: f64,
    #[serde(default)]
    pub buffer_size: i64,
}

/// What one device can do.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    pub type_name: String,
    pub device_name: String,
    pub available: bool,
    #[serde(default)]
    pub sample_rates: Vec<f64>,
    #[serde(default)]
    pub buffer_sizes: Vec<i64>,
    #[serde(default)]
    pub default_buffer_size: Option<i64>,
    #[serde(default)]
    pub output_channel_names: Vec<String>,
    #[serde(default)]
    pub has_control_panel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    pub open: bool,
    #[serde(default)]
    pub type_name: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub sample_rate: Option<f64>,
    #[serde(default)]
    pub buffer_size: Option<i64>,
    #[serde(default)]
    pub output_latency_ms: Option<f64>,
    #[serde(default)]
    pub output_channels: Option<i64>,
    #[serde(default)]
    pub output_channel_names: Vec<String>,
    #[serde(default)]
    pub sample_rates: Vec<f64>,
    #[serde(default)]
    pub buffer_sizes: Vec<i64>,
    #[serde(default)]
    pub has_control_panel: bool,
    /// Driver-reported dropouts (-1 = the driver does not report them).
    #[serde(default)]
    pub xruns: Option<i64>,
    #[serde(default)]
    pub cpu_load: f64,
    /// Engine-side dropouts (the render thread fell behind).
    #[serde(default)]
    pub underruns: i64,
    #[serde(default)]
    pub main_channel: i64,
    #[serde(default)]
    pub monitor_channel: i64,
    #[serde(default)]
    pub output_mode: i64,
    #[serde(default)]
    pub asio_supported: bool,
    /// The song is being re-decoded for a new sample rate.
    #[serde(default)]
    pub reloading: bool,
    #[serde(default)]
    pub device_events: i64,
    #[serde(default)]
    pub last_device_event: String,
    #[serde(default)]
    pub preferred: Option<DeviceChoice>,
    #[serde(default)]
    pub using_preferred: Option<bool>,
}

/// One file of a song to load.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrackRequest {
    pub path: String,
    pub name: String,
    /// `music`, `click` or `guide` (None = infer from the name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// `main` (instruments) or `monitor` (click / cues). None = from the role.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus: Option<String>,
}

/// Engine role for a library role (`click`, `cues`, `drums`...).
pub fn engine_role(role: &str) -> &'static str {
    match role {
        "click" => "click",
        "cues" => "guide",
        _ => "music",
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputMode {
    /// Everything on outputs 1/2 (rehearsal, headphones).
    Stereo,
    /// Instruments mono on output 1, click + cues mono on output 2.
    Split,
    /// Instruments on 1/2, click + cues on 3/4.
    Quad,
}

impl OutputMode {
    fn code(self) -> i32 {
        match self {
            OutputMode::Stereo => 0,
            OutputMode::Split => 1,
            OutputMode::Quad => 2,
        }
    }
    fn from_code(c: i32) -> Self {
        match c {
            1 => OutputMode::Split,
            2 => OutputMode::Quad,
            _ => OutputMode::Stereo,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedTrack {
    pub name: String,
    pub path: String,
    pub format: String,
    pub source_sample_rate: u32,
    pub channels: u32,
    pub duration_sec: f64,
    pub resampled: bool,
    pub role: String,
    pub bus: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSong {
    pub sample_rate: f64,
    pub duration_sec: f64,
    #[serde(rename = "memoryMB")]
    pub memory_mb: f64,
    pub beats_per_bar: u32,
    /// Automatic level trim of the instruments bus (dB, <= 0) so the stems never clip.
    pub main_trim_db: f64,
    pub monitor_trim_db: f64,
    pub tracks: Vec<LoadedTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTempo {
    pub bpm: f64,
    pub confidence: f64,
    pub beat_offset_sec: f64,
    pub downbeat_offset_sec: f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSection {
    pub start_sec: f64,
    pub end_sec: f64,
    pub kind: String,
    pub label: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongAnalysis {
    pub state: String,
    pub revision: u32,
    #[serde(default)]
    pub tempo: Option<DetectedTempo>,
    #[serde(default)]
    pub sections: Vec<DetectedSection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SongStatus {
    /// `idle`, `loading`, `ready` or `error`.
    pub state: String,
    pub progress: f64,
    pub error: String,
    pub load_id: u64,
    #[serde(default)]
    pub song: Option<LoadedSong>,
    #[serde(default)]
    pub analysis: Option<SongAnalysis>,
    #[serde(default)]
    pub preload: Option<PreloadStatus>,
}

/// Peak levels (linear, ~300 ms release); reading does not reset them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meters {
    pub tracks: Vec<f32>,
    /// Instruments bus L/R (after the limiter).
    pub main: [f32; 2],
    /// Click + cues bus L/R (after the limiter).
    pub monitor: [f32; 2],
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlayState {
    Stopped,
    Playing,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportState {
    pub play_state: PlayState,
    pub ended: bool,
    pub stretching: bool,
    /// Driver-reported glitches since the device opened (`None` = unknown).
    pub device_xruns: Option<u32>,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub tempo_ratio: f64,
    pub master_gain: f64,
    pub audio_load: f64,
    pub render_load: f64,
    pub underruns: u64,
    pub output_mode: OutputMode,
    pub output_channels: u32,
    pub monitor_gain: f64,
    /// Safety limiter gain on each bus (1 = idle).
    pub main_limiter_gain: f64,
    pub monitor_limiter_gain: f64,
    /// Scheduled seamless jump (song seconds), if any.
    pub pending_jump: Option<PendingJump>,
    /// Active loop [start, end) in song seconds, if any.
    pub loop_range: Option<(f64, f64)>,
    /// How far ahead a jump must be scheduled right now (song seconds).
    pub min_jump_lead_sec: f64,
    pub jumps_done: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingJump {
    pub at_sec: f64,
    pub target_sec: f64,
}

/// Background decoding of the next song (setlists).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PreloadStatus {
    /// `idle`, `loading`, `ready`, `skipped` (not enough RAM) or `error`.
    pub state: String,
    #[serde(default)]
    pub tracks: u32,
    #[serde(default)]
    pub memory_mb: Option<f64>,
}

fn static_str(ptr: *const std::ffi::c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: the engine guarantees NUL-terminated UTF-8 strings.
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

/// Static build information; does not require an engine instance.
pub fn engine_info() -> EngineInfo {
    // SAFETY: these functions have no preconditions and return static strings.
    unsafe {
        EngineInfo {
            engine_version: static_str(ffi::lp_engine_version()),
            abi_version: ffi::lp_engine_abi_version(),
            juce_version: static_str(ffi::lp_engine_juce_version()),
            build_type: static_str(ffi::lp_engine_build_type()),
        }
    }
}

/// Owned handle to a native engine instance.
pub struct Engine {
    raw: NonNull<ffi::lp_engine>,
    owner: ThreadId,
}

// SAFETY: the raw pointer is only dereferenced after `check_thread` confirms
// we are on the owning thread, so moving/sharing the handle is sound. This is
// required so the handle can live in Tauri's managed state.
unsafe impl Send for Engine {}
unsafe impl Sync for Engine {}

impl Engine {
    /// Creates the engine. The calling thread becomes its control thread.
    pub fn new() -> Result<Self, EngineError> {
        // SAFETY: no preconditions.
        let found = unsafe { ffi::lp_engine_abi_version() };
        if found != ffi::ABI_VERSION {
            return Err(EngineError::AbiMismatch { expected: ffi::ABI_VERSION, found });
        }
        // SAFETY: called on the thread that will own the engine.
        let raw = NonNull::new(unsafe { ffi::lp_engine_create() }).ok_or(EngineError::CreateFailed)?;
        Ok(Self { raw, owner: thread::current().id() })
    }

    fn check_thread(&self) -> Result<(), EngineError> {
        if thread::current().id() == self.owner { Ok(()) } else { Err(EngineError::WrongThread) }
    }

    fn last_error(&self) -> String {
        // SAFETY: valid pointer, owning thread (checked by callers).
        static_str(unsafe { ffi::lp_engine_last_error(self.raw.as_ptr()) })
    }

    fn map(&self, code: ffi::lp_result) -> Result<(), EngineError> {
        match code {
            ffi::LP_OK => Ok(()),
            ffi::LP_ERR_INVALID_ARGUMENT => {
                let msg = self.last_error();
                Err(EngineError::InvalidArgument(if msg.is_empty() { String::new() } else { format!(": {msg}") }))
            }
            ffi::LP_ERR_INVALID_STATE => Err(EngineError::InvalidState(self.last_error())),
            ffi::LP_ERR_BUFFER_TOO_SMALL => Err(EngineError::Internal("buffer too small".into())),
            _ => {
                let msg = self.last_error();
                Err(EngineError::Internal(if msg.is_empty() { format!("código {code}") } else { msg }))
            }
        }
    }

    /// Calls a two-call-pattern JSON function and deserializes the result.
    fn json<T: for<'de> Deserialize<'de>>(&self, f: ffi::JsonFn) -> Result<T, EngineError> {
        // SAFETY: `f` is an engine JSON function; arguments come from json_with.
        self.json_with(|e, b, c, r| unsafe { f(e, b, c, r) })
    }

    fn json_with<T: for<'de> Deserialize<'de>>(
        &self,
        mut f: impl FnMut(*mut ffi::lp_engine, *mut std::ffi::c_char, usize, *mut usize) -> ffi::lp_result,
    ) -> Result<T, EngineError> {
        self.check_thread()?;
        let engine = self.raw.as_ptr();
        // The content can change between the two calls; retry if it grew.
        for _ in 0..3 {
            let mut required = 0usize;
            // SAFETY: size query with NULL buffer and zero capacity.
            self.map(f(engine, std::ptr::null_mut(), 0, &mut required))?;
            let mut buf = vec![0u8; required + 256];
            // SAFETY: `buf` has `buf.len()` writable bytes.
            let code = f(engine, buf.as_mut_ptr().cast(), buf.len(), &mut required);
            if code == ffi::LP_ERR_BUFFER_TOO_SMALL {
                continue;
            }
            self.map(code)?;
            let json = CStr::from_bytes_until_nul(&buf)
                .map_err(|e| EngineError::InvalidResponse(e.to_string()))?
                .to_str()
                .map_err(|e| EngineError::InvalidResponse(e.to_string()))?;
            return serde_json::from_str(json).map_err(|e| EngineError::InvalidResponse(format!("{e}: {json}")));
        }
        Err(EngineError::InvalidResponse("la respuesta del motor cambió repetidamente".into()))
    }

    /// Round-trip through the native engine: returns `value + 1`.
    pub fn ping(&self, value: i64) -> Result<i64, EngineError> {
        self.check_thread()?;
        let mut out = 0i64;
        // SAFETY: valid engine pointer and out-pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_ping(self.raw.as_ptr(), value, &mut out) })?;
        Ok(out)
    }

    /// Read-only scan of audio back-ends and output devices.
    pub fn audio_diagnostics(&self) -> Result<AudioDiagnostics, EngineError> {
        self.json(ffi::lp_engine_describe_audio_devices)
    }

    /// Opens the system default output (idempotent).
    pub fn open_default_output(&self) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_open_default_output(self.raw.as_ptr()) })
    }

    /// Output device status. Also does the device housekeeping (lost /
    /// reconnected device), so it should be polled regularly.
    pub fn output_info(&self) -> Result<OutputInfo, EngineError> {
        self.json(ffi::lp_engine_get_output_info)
    }

    /// Sample rates, buffer sizes and outputs of one device.
    pub fn describe_device(&self, type_name: &str, device_name: &str) -> Result<DeviceCapabilities, EngineError> {
        let req = serde_json::json!({ "typeName": type_name, "deviceName": device_name }).to_string();
        let c = CString::new(req).map_err(|_| EngineError::InvalidArgument(": nombre con carácter NUL".into()))?;
        // SAFETY: valid NUL-terminated request; buffer arguments come from json_with.
        self.json_with(|e, b, cap, r| unsafe { ffi::lp_engine_describe_device(e, c.as_ptr(), b, cap, r) })
    }

    /// Opens and remembers a device (default output meanwhile if not connected).
    pub fn set_audio_device(&self, choice: &DeviceChoice) -> Result<(), EngineError> {
        self.check_thread()?;
        let req = serde_json::to_string(choice).map_err(|e| EngineError::InvalidArgument(format!(": {e}")))?;
        let c = CString::new(req).map_err(|_| EngineError::InvalidArgument(": nombre con carácter NUL".into()))?;
        // SAFETY: valid engine pointer and NUL-terminated string; owning thread.
        self.map(unsafe { ffi::lp_engine_set_audio_device(self.raw.as_ptr(), c.as_ptr()) })
    }

    /// First device output (0-based) of the main and the monitor bus.
    pub fn set_output_channels(&self, main_first: i32, monitor_first: i32) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_output_channels(self.raw.as_ptr(), main_first, monitor_first) })
    }

    /// 1 kHz / -18 dBFS / 2 s tone on one output (0-based); -1 stops it.
    pub fn test_tone(&self, channel: i32) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_test_tone(self.raw.as_ptr(), channel) })
    }

    /// Driver control panel (ASIO).
    pub fn show_device_panel(&self) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_show_device_panel(self.raw.as_ptr()) })
    }

    /// Starts loading a song in the background; poll [`Engine::song_status`].
    /// `bpm`: tempo known by the user (None = detect). `beats_per_bar`: bar length.
    pub fn load_song(&self, tracks: &[TrackRequest], bpm: Option<f64>, beats_per_bar: i32) -> Result<(), EngineError> {
        self.check_thread()?;
        let request =
            serde_json::json!({ "tracks": tracks, "bpm": bpm.unwrap_or(0.0), "beatsPerBar": beats_per_bar }).to_string();
        let c = CString::new(request).map_err(|_| EngineError::InvalidArgument(": ruta con carácter NUL".into()))?;
        // SAFETY: valid engine pointer and NUL-terminated string; owning thread.
        self.map(unsafe { ffi::lp_engine_load_song(self.raw.as_ptr(), c.as_ptr()) })
    }

    /// Load/analysis status. Also installs a freshly loaded song (must be polled).
    pub fn song_status(&self) -> Result<SongStatus, EngineError> {
        self.json(ffi::lp_engine_get_song_status)
    }

    /// Waveform overview: `track` index, or `-1` for the mix.
    pub fn peaks(&self, track: i32) -> Result<Vec<u8>, EngineError> {
        self.check_thread()?;
        let engine = self.raw.as_ptr();
        let mut required = 0usize;
        // SAFETY: size query.
        self.map(unsafe { ffi::lp_engine_get_peaks(engine, track, std::ptr::null_mut(), 0, &mut required) })?;
        let mut buf = vec![0u8; required];
        // SAFETY: `buf` has exactly `required` writable bytes.
        self.map(unsafe { ffi::lp_engine_get_peaks(engine, track, buf.as_mut_ptr(), buf.len(), &mut required) })?;
        buf.truncate(required);
        Ok(buf)
    }

    /// Re-detects sections. `bpm <= 0`: detected tempo. `downbeat < 0`: estimate the bar grid.
    pub fn detect_sections(&self, bpm: f64, downbeat_offset_sec: f64, beats_per_bar: i32) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_detect_sections(self.raw.as_ptr(), bpm, downbeat_offset_sec, beats_per_bar) })
    }

    /// Output bus (`main` / `monitor`) and analysis role (`music` / `click` / `guide`) of a track.
    pub fn set_track_route(&self, track: i32, bus: &str, role: &str) -> Result<(), EngineError> {
        self.check_thread()?;
        let bus = if bus == "monitor" { 1 } else { 0 };
        let role = match role {
            "click" => 1,
            "guide" => 2,
            _ => 0,
        };
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_track_route(self.raw.as_ptr(), track, bus, role) })
    }

    /// Per-track gain 0..4 (fader, mute, solo, audition).
    pub fn set_track_gain(&self, track: i32, gain: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_track_gain(self.raw.as_ptr(), track, gain) })
    }

    pub fn set_output_mode(&self, mode: OutputMode) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_output_mode(self.raw.as_ptr(), mode.code()) })
    }

    /// Peak meters (~300 ms release; non-destructive read).
    pub fn meters(&self) -> Result<Meters, EngineError> {
        self.check_thread()?;
        let engine = self.raw.as_ptr();
        let mut count = 0usize;
        // SAFETY: size query.
        self.map(unsafe { ffi::lp_engine_get_meters(engine, std::ptr::null_mut(), 0, &mut count) })?;
        let mut v = vec![0f32; count];
        // SAFETY: `v` has `count` writable floats.
        self.map(unsafe { ffi::lp_engine_get_meters(engine, v.as_mut_ptr(), v.len(), &mut count) })?;
        let n = v.len().saturating_sub(4);
        let bus = |i: usize| v.get(n + i).copied().unwrap_or(0.0);
        Ok(Meters { tracks: v[..n].to_vec(), main: [bus(0), bus(1)], monitor: [bus(2), bus(3)] })
    }

    /// Volume of the click / cues bus, linear 0..4.
    pub fn set_monitor_gain(&self, gain: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_monitor_gain(self.raw.as_ptr(), gain) })
    }

    pub fn play(&self) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_play(self.raw.as_ptr()) })
    }

    pub fn pause(&self) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_pause(self.raw.as_ptr()) })
    }

    pub fn stop(&self) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_stop(self.raw.as_ptr()) })
    }

    pub fn seek(&self, position_sec: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_seek(self.raw.as_ptr(), position_sec) })
    }

    /// Linear gain 0..4 (1 = unity, ~2.51 = +8 dB).
    pub fn set_master_gain(&self, gain: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_master_gain(self.raw.as_ptr(), gain) })
    }

    /// Playback speed relative to the original tempo, 0.5..2.0 (pitch kept).
    pub fn set_tempo_ratio(&self, ratio: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_tempo_ratio(self.raw.as_ptr(), ratio) })
    }

    pub fn transport(&self) -> Result<TransportState, EngineError> {
        self.check_thread()?;
        let mut s = ffi::lp_transport_state::default();
        // SAFETY: valid engine pointer and out-pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_get_transport(self.raw.as_ptr(), &mut s) })?;
        Ok(TransportState {
            play_state: match s.play_state {
                1 => PlayState::Playing,
                2 => PlayState::Paused,
                _ => PlayState::Stopped,
            },
            ended: s.ended != 0,
            stretching: s.stretching != 0,
            device_xruns: u32::try_from(s.device_xruns).ok(),
            position_sec: s.position_sec,
            duration_sec: s.duration_sec,
            tempo_ratio: s.tempo_ratio,
            master_gain: s.master_gain,
            audio_load: s.audio_load,
            render_load: s.render_load,
            underruns: s.underruns,
            output_mode: OutputMode::from_code(s.output_mode),
            output_channels: u32::try_from(s.output_channels).unwrap_or(0),
            monitor_gain: s.monitor_gain,
            main_limiter_gain: s.main_limiter_gain,
            monitor_limiter_gain: s.monitor_limiter_gain,
            pending_jump: (s.pending_jump_at >= 0.0)
                .then_some(PendingJump { at_sec: s.pending_jump_at, target_sec: s.pending_jump_target }),
            loop_range: (s.loop_end > s.loop_start && s.loop_start >= 0.0).then_some((s.loop_start, s.loop_end)),
            min_jump_lead_sec: s.min_jump_lead_sec,
            jumps_done: s.jumps_done,
        })
    }

    /// Seamless jump at song second `at_sec` to `target_sec` (bar-synchronous part jumps).
    pub fn schedule_jump(&self, at_sec: f64, target_sec: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_schedule_jump(self.raw.as_ptr(), at_sec, target_sec) })
    }

    pub fn cancel_jump(&self) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_cancel_jump(self.raw.as_ptr()) })
    }

    /// Seamless loop of [start, end); `end <= start` turns it off.
    pub fn set_loop(&self, start_sec: f64, end_sec: f64) -> Result<(), EngineError> {
        self.check_thread()?;
        // SAFETY: valid engine pointer; owning thread.
        self.map(unsafe { ffi::lp_engine_set_loop(self.raw.as_ptr(), start_sec, end_sec) })
    }

    /// Decodes a song in the background so that loading it later is instant
    /// (empty list = forget it).
    pub fn preload_song(&self, tracks: &[TrackRequest]) -> Result<(), EngineError> {
        self.check_thread()?;
        let request = serde_json::json!({ "tracks": tracks }).to_string();
        let c = CString::new(request).map_err(|_| EngineError::InvalidArgument(": ruta con carácter NUL".into()))?;
        // SAFETY: valid engine pointer and NUL-terminated string; owning thread.
        self.map(unsafe { ffi::lp_engine_preload_song(self.raw.as_ptr(), c.as_ptr()) })
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if thread::current().id() != self.owner {
            // Destroying JUCE objects off their thread is undefined behaviour;
            // leaking at process exit is the safe choice.
            eprintln!("liveplayer-engine: Engine dropped off its control thread; leaking instance");
            return;
        }
        // SAFETY: valid pointer created by lp_engine_create, destroyed once.
        unsafe { ffi::lp_engine_destroy(self.raw.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[test]
    fn static_info_is_consistent() {
        let info = engine_info();
        assert_eq!(info.abi_version, ABI_VERSION);
        assert_eq!(info.engine_version, env!("CARGO_PKG_VERSION"));
        assert!(info.juce_version.starts_with("9."), "{}", info.juce_version);
    }

    // Engine instances share process-wide JUCE state that belongs to a single
    // control thread, so all instance tests run sequentially in one test.
    #[test]
    fn engine_instance() {
        ping_round_trip_and_lifecycle();
        audio_diagnostics_parse();
        refuses_foreign_thread();
        transport_requires_song();
        load_and_play_test_song();
        remembers_a_device_that_is_not_connected();
    }

    fn ping_round_trip_and_lifecycle() {
        for _ in 0..3 {
            let engine = Engine::new().expect("engine");
            assert_eq!(engine.ping(41), Ok(42));
            assert_eq!(engine.ping(i64::from(i32::MIN)), Ok(i64::from(i32::MIN) + 1));
        }
    }

    fn audio_diagnostics_parse() {
        let engine = Engine::new().expect("engine");
        let diag = engine.audio_diagnostics().expect("diagnostics");
        // Every desktop OS exposes at least one backend type.
        assert!(!diag.device_types.is_empty());
    }

    fn refuses_foreign_thread() {
        let engine = std::sync::Arc::new(Engine::new().expect("engine"));
        let e2 = engine.clone();
        let r = std::thread::spawn(move || {
            let r = e2.ping(1);
            drop(e2); // not the last reference: no destroy on this thread
            r
        })
        .join()
        .unwrap();
        assert_eq!(r, Err(EngineError::WrongThread));
    }

    fn transport_requires_song() {
        let engine = Engine::new().expect("engine");
        assert!(matches!(engine.play(), Err(EngineError::InvalidState(_))));
        assert!(matches!(engine.set_tempo_ratio(5.0), Err(EngineError::InvalidArgument(_))));
        let t = engine.transport().expect("transport");
        assert_eq!(t.play_state, PlayState::Stopped);
        assert_eq!(engine.song_status().expect("status").state, "idle");
    }

    fn test_audio_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-audio/short")
    }

    fn remembers_a_device_that_is_not_connected() {
        let engine = Engine::new().expect("engine");
        if engine.open_default_output().is_err() {
            eprintln!("SKIP remembers_a_device_that_is_not_connected: no audio output");
            return;
        }
        let choice = DeviceChoice {
            type_name: "Windows Audio".into(),
            device_name: "LIVEPLAYER Missing Interface".into(),
            sample_rate: 48000.0,
            buffer_size: 0,
        };
        if engine.audio_diagnostics().map(|d| d.device_types.iter().all(|t| t.name != choice.type_name)).unwrap_or(true) {
            eprintln!("SKIP: no WASAPI on this machine");
            return;
        }
        engine.set_audio_device(&choice).expect("remembered");
        let info = engine.output_info().expect("info");
        assert!(info.open, "the default output keeps playing");
        assert_eq!(info.using_preferred, Some(false));
        assert_eq!(info.preferred.as_ref().map(|p| p.device_name.as_str()), Some("LIVEPLAYER Missing Interface"));
        assert!(info.device_events >= 1 && !info.last_device_event.is_empty());
        let caps = engine.describe_device(&choice.type_name, &choice.device_name).expect("caps");
        assert!(!caps.available);
        assert!(engine.set_output_channels(0, 99).is_err());
        assert!(engine.test_tone(99).is_err());
    }

    fn load_and_play_test_song() {
        let dir = test_audio_dir();
        if !dir.join("Tone.wav").exists() {
            eprintln!("SKIP load_and_play_test_song: run `node tools/generate-test-song.mjs test-audio` first");
            return;
        }
        let engine = Engine::new().expect("engine");
        if let Err(e) = engine.open_default_output() {
            eprintln!("SKIP load_and_play_test_song: no audio output on this machine ({e})");
            return;
        }
        let out = engine.output_info().expect("output info");
        assert!(out.open && out.sample_rate.unwrap_or(0.0) > 0.0);

        let tracks: Vec<TrackRequest> = ["Tone.wav", "Pulse.wav"]
            .iter()
            .map(|f| TrackRequest {
                path: dir.join(f).to_string_lossy().into_owned(),
                name: f.replace(".wav", ""),
                role: None,
                bus: None,
            })
            .collect();
        engine.load_song(&tracks, None, 4).expect("load");

        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            let s = engine.song_status().expect("status");
            if s.state != "loading" {
                break s;
            }
            assert!(Instant::now() < deadline, "load timed out");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.state, "ready", "{}", status.error);
        let song = status.song.expect("song");
        assert_eq!(song.tracks.len(), 2);
        assert!((song.duration_sec - 8.0).abs() < 0.01);
        assert_eq!(engine.peaks(-1).expect("mix peaks").len(), 800);
        assert_eq!(engine.peaks(0).expect("track peaks").len(), 800);
        assert!(matches!(engine.peaks(7), Err(EngineError::InvalidState(_))));
        assert_eq!(song.tracks[1].bus, "main");
        engine.set_track_route(1, "monitor", "click").unwrap();
        assert_eq!(engine.song_status().unwrap().song.unwrap().tracks[1].bus, "monitor");
        engine.set_track_gain(0, 0.0).unwrap();
        engine.set_track_gain(0, 1.0).unwrap();
        engine.set_output_mode(OutputMode::Split).unwrap();
        let t = engine.transport().unwrap();
        assert_eq!(t.output_mode, OutputMode::Split);
        if t.output_channels < 4 {
            assert!(matches!(engine.set_output_mode(OutputMode::Quad), Err(EngineError::InvalidState(_))));
        }
        engine.set_output_mode(OutputMode::Stereo).unwrap();
        assert_eq!(engine.meters().unwrap().tracks.len(), 2);

        // Silent playback check (master at 0): the transport must advance.
        engine.set_master_gain(0.0).unwrap();
        engine.play().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        let t = engine.transport().unwrap();
        assert_eq!(t.play_state, PlayState::Playing);
        assert!(t.position_sec > 0.3 && t.position_sec < 1.0, "position {}", t.position_sec);
        engine.seek(5.0).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let t = engine.transport().unwrap();
        assert!(t.position_sec > 5.0 && t.position_sec < 5.5, "position {}", t.position_sec);

        // Seamless jump scheduled at 6.0 s back to 1.0 s.
        assert!(engine.schedule_jump(t.position_sec + 0.05, 1.0).is_err(), "too close must be refused");
        engine.schedule_jump(6.0, 1.0).unwrap();
        assert!(engine.transport().unwrap().pending_jump.is_some());
        std::thread::sleep(Duration::from_millis(1000));
        let t = engine.transport().unwrap();
        assert_eq!(t.jumps_done, 1);
        assert!(t.pending_jump.is_none());
        assert!(t.position_sec > 1.0 && t.position_sec < 1.6, "position after the jump {}", t.position_sec);
        engine.set_loop(1.5, 2.5).unwrap();
        assert_eq!(engine.transport().unwrap().loop_range, Some((1.5, 2.5)));
        engine.set_loop(0.0, 0.0).unwrap();
        engine.stop().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let t = engine.transport().unwrap();
        assert_eq!(t.play_state, PlayState::Stopped);
        assert_eq!(t.position_sec, 0.0);
        assert_eq!(t.underruns, 0);

        // Preloading: the next song decodes in the background and then loads instantly.
        let next: Vec<TrackRequest> = vec![TrackRequest {
            path: dir.join("Pulse.wav").to_string_lossy().into_owned(),
            name: "Pulse".into(),
            role: None,
            bus: None,
        }];
        engine.preload_song(&next).unwrap();
        let mut ready = false;
        for _ in 0..200 {
            if engine.song_status().unwrap().preload.map(|p| p.state == "ready").unwrap_or(false) {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(ready, "preload did not finish");
        engine.load_song(&next, None, 4).unwrap();
        let st = engine.song_status().unwrap();
        assert_eq!(st.state, "ready", "a preloaded song is installed without waiting");
        assert_eq!(st.song.unwrap().tracks.len(), 1);
        assert_eq!(st.preload.unwrap().state, "idle");
    }
}
