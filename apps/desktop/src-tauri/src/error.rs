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
        // Wrong arguments / states are the user's normal mistakes; the rest goes to the log.
        if !matches!(e, liveplayer_engine::EngineError::InvalidArgument(_) | liveplayer_engine::EngineError::InvalidState(_)) {
            crate::applog::write("ERROR", &format!("motor: {e}"));
        }
        Self { code: "engine", message: e.to_string() }
    }
}

impl From<liveplayer_db::DbError> for CommandError {
    fn from(e: liveplayer_db::DbError) -> Self {
        let code = match e {
            liveplayer_db::DbError::Invalid(_) => "invalid",
            liveplayer_db::DbError::NotFound(_) => "not_found",
            _ => "database",
        };
        if code == "database" {
            crate::applog::write("ERROR", &format!("base de datos: {e}"));
        }
        Self { code, message: e.to_string() }
    }
}

impl CommandError {
    pub fn state(message: impl Into<String>) -> Self {
        Self { code: "state", message: message.into() }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self { code: "invalid", message: message.into() }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
