use serde::Serialize;

/// Error returned by every IPC command. Serialized as `{ code, message }`
/// (mirrors `IpcError` in `src/lib/ipc/types.ts`).
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<liveplayer_engine::EngineError> for CommandError {
    fn from(e: liveplayer_engine::EngineError) -> Self {
        Self { code: "engine", message: e.to_string() }
    }
}

impl From<liveplayer_db::DbError> for CommandError {
    fn from(e: liveplayer_db::DbError) -> Self {
        Self { code: "database", message: e.to_string() }
    }
}

impl CommandError {
    pub fn state(message: impl Into<String>) -> Self {
        Self { code: "state", message: message.into() }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
