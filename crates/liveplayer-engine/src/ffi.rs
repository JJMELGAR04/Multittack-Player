//! Raw declarations mirroring `engine/include/liveplayer_engine.h`.
//! Keep in sync with the header; bump `ABI_VERSION` together with it.

use std::ffi::{c_char, c_int};

pub const ABI_VERSION: u32 = 2;

#[repr(C)]
pub struct lp_engine {
    _private: [u8; 0],
}

pub type lp_result = c_int;
pub const LP_OK: lp_result = 0;
pub const LP_ERR_INVALID_ARGUMENT: lp_result = 1;
pub const LP_ERR_BUFFER_TOO_SMALL: lp_result = 2;
#[allow(dead_code)] // documented code; reported through the catch-all arm
pub const LP_ERR_INTERNAL: lp_result = 3;
pub const LP_ERR_INVALID_STATE: lp_result = 4;

#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct lp_transport_state {
    pub play_state: i32,
    pub ended: i32,
    pub stretching: i32,
    pub device_xruns: i32,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub tempo_ratio: f64,
    pub master_gain: f64,
    pub audio_load: f64,
    pub render_load: f64,
    pub underruns: u64,
}

pub type JsonFn = unsafe extern "C" fn(*mut lp_engine, *mut c_char, usize, *mut usize) -> lp_result;

unsafe extern "C" {
    pub fn lp_engine_abi_version() -> u32;
    pub fn lp_engine_version() -> *const c_char;
    pub fn lp_engine_juce_version() -> *const c_char;
    pub fn lp_engine_build_type() -> *const c_char;

    pub fn lp_engine_create() -> *mut lp_engine;
    pub fn lp_engine_destroy(engine: *mut lp_engine);
    pub fn lp_engine_last_error(engine: *const lp_engine) -> *const c_char;

    pub fn lp_engine_ping(engine: *mut lp_engine, value: i64, out_value: *mut i64) -> lp_result;
    pub fn lp_engine_describe_audio_devices(
        engine: *mut lp_engine,
        buffer: *mut c_char,
        capacity: usize,
        out_required: *mut usize,
    ) -> lp_result;

    pub fn lp_engine_open_default_output(engine: *mut lp_engine) -> lp_result;
    pub fn lp_engine_get_output_info(
        engine: *mut lp_engine,
        buffer: *mut c_char,
        capacity: usize,
        out_required: *mut usize,
    ) -> lp_result;

    pub fn lp_engine_load_song(engine: *mut lp_engine, request_json: *const c_char) -> lp_result;
    pub fn lp_engine_get_song_status(
        engine: *mut lp_engine,
        buffer: *mut c_char,
        capacity: usize,
        out_required: *mut usize,
    ) -> lp_result;
    pub fn lp_engine_get_peaks(
        engine: *mut lp_engine,
        track: i32,
        buffer: *mut u8,
        capacity: usize,
        out_required: *mut usize,
    ) -> lp_result;
    pub fn lp_engine_detect_sections(engine: *mut lp_engine, bpm: f64, downbeat_offset_sec: f64) -> lp_result;

    pub fn lp_engine_play(engine: *mut lp_engine) -> lp_result;
    pub fn lp_engine_pause(engine: *mut lp_engine) -> lp_result;
    pub fn lp_engine_stop(engine: *mut lp_engine) -> lp_result;
    pub fn lp_engine_seek(engine: *mut lp_engine, position_sec: f64) -> lp_result;
    pub fn lp_engine_set_master_gain(engine: *mut lp_engine, gain: f64) -> lp_result;
    pub fn lp_engine_set_tempo_ratio(engine: *mut lp_engine, ratio: f64) -> lp_result;
    pub fn lp_engine_get_transport(engine: *mut lp_engine, out_state: *mut lp_transport_state) -> lp_result;
}
