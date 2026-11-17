//! IPC commands exposed to the frontend.
//!
//! Engine commands are *synchronous* on purpose: in Tauri 2, non-async
//! commands run on the main thread, which is the engine's control thread
//! (and JUCE's message thread). Database commands are also short and
//! synchronous; the connection is guarded by a mutex.
//! Long work (decoding, analysis) never runs inside a command: the engine
//! does it on its own threads and the UI polls `studio_status`.

pub mod app;
pub mod database;
pub mod engine;
pub mod import;
pub mod studio;
