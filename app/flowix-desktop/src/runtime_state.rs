//! Mutable Windows state must not share the executable installation directory.
use std::path::PathBuf;

pub fn windows_state_dir() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA")
        .map(|root| PathBuf::from(root).join("FlowixData"))
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())
}
