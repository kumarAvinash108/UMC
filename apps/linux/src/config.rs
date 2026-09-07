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
    // --- WiFi LAN / Bluetooth P2P transport (see docs/wifi-bluetooth.md) ---
    /// Same-WiFi discovery + direct HTTP push (`lan.rs`).
    pub wifi_enabled: bool,
    /// Bluetooth framed envelopes (`bluetooth.rs`). No radio => degraded,
    /// never fatal: daemon keeps running on WiFi/cloud.
    pub bt_enabled: bool,
    /// TCP port of the LAN HTTP listener (`POST /lan/v1/items`).
    pub lan_port: u16,
    /// UDP port for LAN discovery beacons.
    pub discovery_port: u16,
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
            wifi_enabled: true,
            bt_enabled: true,
            lan_port: 41235,
            discovery_port: 41234,
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
        if let Ok(v) = std::env::var("UCM_WIFI_ENABLED") { c.wifi_enabled = !(v == "0" || v == "false"); }
        if let Ok(v) = std::env::var("UCM_BT_ENABLED") { c.bt_enabled = !(v == "0" || v == "false"); }
        if let Ok(v) = std::env::var("UCM_LAN_PORT") { if let Ok(p) = v.parse() { c.lan_port = p; } }
        if let Ok(v) = std::env::var("UCM_DISCOVERY_PORT") { if let Ok(p) = v.parse() { c.discovery_port = p; } }
        c
    }

    /// Capabilities advertised on LAN beacons + cloud device registration.
    pub fn capabilities(&self) -> Vec<String> {
        let mut caps = Vec::new();
        if self.wifi_enabled { caps.push("wifi-lan".to_string()); }
        if self.bt_enabled { caps.push("bluetooth".to_string()); }
        caps
    }
}

fn default_data_dir() -> String {
    std::env::var("UCM_DATA_DIR").unwrap_or_else(|_| {
        let base = std::env::var("XDG_DATA_HOME")
            .unwrap_or_else(|_| format!("{}/.local/share", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())));
        format!("{base}/ucm")
    })
}
