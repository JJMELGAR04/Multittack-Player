//! Safe wrapper around the LIVEPLAYER native engine.
//!
//! Threading: the engine must be created and used on a single *control
//! thread* (the application's main thread, which is also JUCE's message
//! thread). [`Engine`] records that thread and every method refuses to run
//! from any other thread, returning [`EngineError::WrongThread`].

#![allow(non_camel_case_types)]

mod ffi;

use std::ffi::CStr;
use std::ptr::NonNull;
use std::thread::{self, ThreadId};

use serde::{Deserialize, Serialize};

pub use ffi::ABI_VERSION;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EngineError {
    #[error("el motor nativo no pudo inicializarse")]
    CreateFailed,
    #[error("ABI del motor incompatible: se esperaba v{expected}, la librería es v{found}")]
    AbiMismatch { expected: u32, found: u32 },
    #[error("el motor solo puede usarse desde su hilo de control")]
    WrongThread,
    #[error("argumento inválido enviado al motor")]
    InvalidArgument,
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
}

fn static_str(ptr: *const std::ffi::c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // SAFETY: the engine guarantees NUL-terminated UTF-8 static strings.
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
        if thread::current().id() == self.owner {
            Ok(())
        } else {
            Err(EngineError::WrongThread)
        }
    }

    fn map(&self, code: ffi::lp_result) -> Result<(), EngineError> {
        match code {
            ffi::LP_OK => Ok(()),
            ffi::LP_ERR_INVALID_ARGUMENT => Err(EngineError::InvalidArgument),
            ffi::LP_ERR_BUFFER_TOO_SMALL => Err(EngineError::Internal("buffer too small".into())),
            ffi::LP_ERR_INTERNAL | _ => {
                // SAFETY: valid pointer, owning thread (checked by callers).
                let msg = static_str(unsafe { ffi::lp_engine_last_error(self.raw.as_ptr()) });
                Err(EngineError::Internal(if msg.is_empty() { format!("código {code}") } else { msg }))
            }
        }
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
        self.check_thread()?;
        let engine = self.raw.as_ptr();

        // Device lists can change between calls; retry if the buffer is short.
        for _ in 0..3 {
            let mut required = 0usize;
            // SAFETY: size query with NULL buffer and zero capacity.
            self.map(unsafe { ffi::lp_engine_describe_audio_devices(engine, std::ptr::null_mut(), 0, &mut required) })?;

            let mut buf = vec![0u8; required];
            // SAFETY: `buf` has exactly `required` writable bytes.
            let code = unsafe {
                ffi::lp_engine_describe_audio_devices(engine, buf.as_mut_ptr().cast(), buf.len(), &mut required)
            };
            if code == ffi::LP_ERR_BUFFER_TOO_SMALL {
                continue;
            }
            self.map(code)?;

            let json = CStr::from_bytes_until_nul(&buf)
                .map_err(|e| EngineError::InvalidResponse(e.to_string()))?
                .to_str()
                .map_err(|e| EngineError::InvalidResponse(e.to_string()))?;
            return serde_json::from_str(json).map_err(|e| EngineError::InvalidResponse(e.to_string()));
        }
        Err(EngineError::InvalidResponse("la lista de dispositivos cambió repetidamente".into()))
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
        println!("{diag:#?}");
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
}
