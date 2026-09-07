import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, Alert, FlatList } from "react-native";
import * as SecureStore from "expo-secure-store";
import { resetAll } from "../lib/identity";
import {
  addManualPeer,
  healthCheck,
  listLanPeers,
  pushEnvelope,
  removeLanPeer,
  buildWifiEnvelope,
  LAN_DEFAULT_TCP_PORT,
  type LanPeer,
} from "../lib/lan";
import { getBtStatus, btOutbox } from "../lib/bluetooth";
import { getTransportStatus, type TransportPolicy } from "../lib/transport";
import { loadIdentity } from "../lib/identity";

const K = { wifi: "ucm.wifi", bt: "ucm.bt", cloud: "ucm.cloud" };

async function loadPolicy(): Promise<TransportPolicy> {
  const [w, b, c] = await Promise.all([
    SecureStore.getItemAsync(K.wifi),
    SecureStore.getItemAsync(K.bt),
    SecureStore.getItemAsync(K.cloud),
  ]);
  return {
    wifiEnabled: w !== "0",
    bluetoothEnabled: b !== "0",
    cloudEnabled: c !== "0",
  };
}

/** Privacy controls + WiFi LAN / Bluetooth transport management. */
export default function Settings() {
  const [policy, setPolicy] = useState<TransportPolicy>({ wifiEnabled: true, bluetoothEnabled: true, cloudEnabled: true });
  const [peers, setPeers] = useState<LanPeer[]>([]);
  const [host, setHost] = useState("");
  const [btDetail, setBtDetail] = useState("checking…");
  const [btQueued, setBtQueued] = useState(0);

  const refresh = useCallback(async () => {
    const p = await loadPolicy();
    setPolicy(p);
    setPeers(listLanPeers());
    const bt = await getBtStatus();
    setBtDetail(bt.detail);
    setBtQueued(btOutbox().length);
    void getTransportStatus;
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function toggle(key: string, field: keyof TransportPolicy) {
    const next = !policy[field];
    setPolicy({ ...policy, [field]: next });
    await SecureStore.setItemAsync(key, next ? "1" : "0");
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Settings & privacy</Text>
      <Text>Clipboard contents may include passwords. Sync is end-to-end encrypted; the server never sees plaintext.</Text>
      <Text>Auto-delete default: 7 days. History limit: 1000 items. Max item: 64 KiB.</Text>

      <Text style={{ fontSize: 16, fontWeight: "600", marginTop: 8 }}>Transports (wifi → bluetooth → cloud)</Text>
      {(
        [
          ["WiFi LAN (same network, fastest)", "wifiEnabled", K.wifi],
          ["Bluetooth (no WiFi needed)", "bluetoothEnabled", K.bt],
          ["Cloud relay (works anywhere)", "cloudEnabled", K.cloud],
        ] as [string, keyof TransportPolicy, string][]
      ).map(([label, field, key]) => (
        <Pressable key={field} onPress={() => toggle(key, field)} style={{ padding: 12, borderWidth: 1, borderRadius: 8 }}>
          <Text>{(policy[field] ? "✓ " : "○ ") + label}</Text>
        </Pressable>
      ))}
      <Text style={{ color: "#666" }}>Bluetooth: {btDetail}{btQueued > 0 ? ` (${btQueued} staged)` : ""}</Text>

      <Text style={{ fontSize: 16, fontWeight: "600", marginTop: 8 }}>WiFi peers ({peers.length})</Text>
      <Text style={{ color: "#666" }}>On your PC run `ucm daemon` (or `ucm lan-serve`), then enter its LAN IP below. Find it with `hostname -I`.</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput
          placeholder="192.168.1.5"
          value={host}
          onChangeText={setHost}
          autoCapitalize="none"
          style={{ flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
        />
        <Pressable
          onPress={async () => {
            if (!host.trim()) return;
            const p = addManualPeer(host.trim(), LAN_DEFAULT_TCP_PORT);
            const ok = await healthCheck(p);
            Alert.alert(ok ? "Peer added" : "No answer", ok ? `${p.host} answered the LAN health check.` : `${p.host}:${p.tcp_port} did not answer. Same Wi-Fi?`);
            setPeers(listLanPeers());
            setHost("");
          }}
          style={{ padding: 12, backgroundColor: "#111", borderRadius: 8 }}
        >
          <Text style={{ color: "#fff" }}>Add</Text>
        </Pressable>
      </View>
      <FlatList
        data={peers}
        keyExtractor={(p) => p.device_id}
        ListEmptyComponent={<Text style={{ color: "#888" }}>No WiFi peers yet.</Text>}
        renderItem={({ item }) => (
          <View style={{ padding: 10, borderWidth: 1, borderColor: "#eee", borderRadius: 8, marginBottom: 8 }}>
            <Text>{item.name} · {item.host}:{item.tcp_port}</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
              <Pressable
                onPress={async () => {
                  const ok = await healthCheck(item);
                  Alert.alert(ok ? "Online" : "Offline", ok ? "Peer answered." : "Peer did not answer.");
                }}
                style={{ padding: 8, borderWidth: 1, borderRadius: 6 }}
              >
                <Text>Ping</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  // Connectivity probe: an empty-shaped envelope is rejected
                  // by the peer with 400, which still proves reachability
                  // without sending any real clipboard bytes.
                  try {
                    await pushEnvelope(item, buildWifiEnvelope({
                      sender_device_id: (await loadIdentity()).device_id ?? "android-probe",
                      item: {
                        id: "00000000-0000-4000-8000-000000000000",
                        owner_id: "probe", source_device_id: "probe", content_type: "text/plain",
                        ciphertext: "eA==", nonce: "eA==", metadata: {},
                        created_at: new Date().toISOString(), expires_at: null, deleted_at: null,
                      },
                    }));
                  } catch (e) {
                    Alert.alert("Probe result", String(e));
                  }
                }}
                style={{ padding: 8, borderWidth: 1, borderRadius: 6 }}
              >
                <Text>Probe</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  removeLanPeer(item.device_id);
                  setPeers(listLanPeers());
                }}
                style={{ padding: 8, borderWidth: 1, borderRadius: 6 }}
              >
                <Text>Remove</Text>
              </Pressable>
            </View>
          </View>
        )}
      />

      <Pressable
        onPress={() => Alert.alert("Pause", "To pause sync, disable network or revoke this device temporarily. Per-device pause ships in beta.")}
        style={{ padding: 12, borderWidth: 1, borderRadius: 8 }}
      >
        <Text>Pause sync</Text>
      </Pressable>
      <Pressable
        onPress={async () => {
          await resetAll();
          Alert.alert("Reset", "Local keys and session removed.");
        }}
        style={{ padding: 12, backgroundColor: "#a00", borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center" }}>Reset (wipe keys)</Text>
      </Pressable>
    </View>
  );
}
