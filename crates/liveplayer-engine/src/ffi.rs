//! Raw declarations mirroring `engine/include/liveplayer_engine.h`.
//! Keep in sync with the header; bump `ABI_VERSION` together with it.

use std::ffi::{c_char, c_int};

pub const ABI_VERSION: u32 = 1;

#[repr(C)]
pub struct lp_engine {
    _private: [u8; 0],
}

pub type lp_result = c_int;
pub const LP_OK: lp_result = 0;
pub const LP_ERR_INVALID_ARGUMENT: lp_result = 1;
pub const LP_ERR_BUFFER_TOO_SMALL: lp_result = 2;
pub const LP_ERR_INTERNAL: lp_result = 3;

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
}
