//! Agent configuration (env + file, no secrets in config).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server_url: String,
    pub device_name: String,
    pub data_dir: String,
    pub sync_enabled: bool,
    pub poll_ms: u64,
    pub retention_days: Option<i64>, // None = never
    pub history_limit: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:3000".into(),
            device_name: "linux".into(),
            data_dir: default_data_dir(),
            sync_enabled: true,
            poll_ms: 800,
            retention_days: Some(7),
            history_limit: 1000,
        }
    }
}

impl Config {
    pub fn from_env() -> Self {
        let mut c = Self::default();
        if let Ok(v) = std::env::var("UCM_SERVER_URL") { c.server_url = v; }
        if let Ok(v) = std::env::var("UCM_DEVICE_NAME") { c.device_name = v; }
        if let Ok(v) = std::env::var("UCM_DATA_DIR") { c.data_dir = v; }
        if let Ok(v) = std::env::var("UCM_SYNC_ENABLED") { c.sync_enabled = v != "0" && v != "false"; }
        c
    }
}

fn default_data_dir() -> String {
    std::env::var("UCM_DATA_DIR").unwrap_or_else(|_| {
        let base = std::env::var("XDG_DATA_HOME")
            .unwrap_or_else(|_| format!("{}/.local/share", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())));
        format!("{base}/ucm")
    })
}
