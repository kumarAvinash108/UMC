//! Transport policy: prefer free local links, fall back to cloud.
//!
//! Preference order (matches `pickTransport` in `@ucm/protocol` and
//! `lib/transport.ts` on Android):
//! wifi-lan (same network, no pairing server needed) → bluetooth
//! (works with no WiFi at all) → cloud relay (works anywhere).
//! The policy never inspects clipboard contents — it only looks at peer
//! capabilities and local on/off switches.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Wifi,
    Bluetooth,
    Cloud,
}

impl std::fmt::Display for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Transport::Wifi => write!(f, "wifi"),
            Transport::Bluetooth => write!(f, "bluetooth"),
            Transport::Cloud => write!(f, "cloud"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TransportPolicy {
    pub wifi_enabled: bool,
    pub bluetooth_enabled: bool,
    pub cloud_enabled: bool,
}

impl Default for TransportPolicy {
    fn default() -> Self {
        Self { wifi_enabled: true, bluetooth_enabled: true, cloud_enabled: true }
    }
}

/// Pick the best transport for a peer advertising `capabilities`
/// (`wifi-lan` / `bluetooth`) with an optional known WiFi `host:port`.
pub fn pick_transport(
    capabilities: &[String],
    has_wifi_route: bool,
    policy: &TransportPolicy,
) -> Option<Transport> {
    if policy.wifi_enabled && has_wifi_route && capabilities.iter().any(|c| c == "wifi-lan") {
        return Some(Transport::Wifi);
    }
    if policy.bluetooth_enabled && capabilities.iter().any(|c| c == "bluetooth") {
        return Some(Transport::Bluetooth);
    }
    if policy.cloud_enabled {
        return Some(Transport::Cloud);
    }
    None
}

/// Aggregate link status shown by `ucm transport` for troubleshooting.
#[derive(Debug, Clone, Serialize)]
pub struct TransportStatus {
    pub wifi_enabled: bool,
    pub bluetooth_enabled: bool,
    pub cloud_enabled: bool,
    pub lan_port: u16,
    pub discovery_port: u16,
    pub bt_available: bool,
    pub bt_powered: bool,
    pub bt_detail: String,
    pub wifi_peers: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_wifi_then_bt_then_cloud() {
        let p = TransportPolicy::default();
        let caps = vec!["wifi-lan".to_string(), "bluetooth".to_string()];
        assert_eq!(pick_transport(&caps, true, &p), Some(Transport::Wifi));
        assert_eq!(
            pick_transport(&caps, false, &p),
            Some(Transport::Bluetooth)
        );
        assert_eq!(pick_transport(&[], false, &p), Some(Transport::Cloud));
        let off = TransportPolicy { wifi_enabled: false, bluetooth_enabled: false, cloud_enabled: false };
        assert_eq!(pick_transport(&caps, true, &off), None);
    }
}
