import { useCallback, useEffect, useState } from "react";
import { ScrollView, View, Text, TextInput, Pressable, Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import { resetAll, getSyncKeyB64, setSyncKeyB64, getOrCreateLocalDeviceId } from "../lib/identity";
import { isValidKeyB64, keyFingerprint } from "../lib/crypto";
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

const K = { wifi: "ucm.wifi", bt: "ucm.bt" };

async function loadPolicy(): Promise<TransportPolicy> {
  const [w, b] = await Promise.all([
    SecureStore.getItemAsync(K.wifi),
    SecureStore.getItemAsync(K.bt),
  ]);
  return {
    wifiEnabled: w !== "0",
    bluetoothEnabled: b !== "0",
  };
}

/** Privacy controls + WiFi LAN / Bluetooth transport management. */
export default function Settings() {
  const [policy, setPolicy] = useState<TransportPolicy>({
    wifiEnabled: true,
    bluetoothEnabled: true,
  });
  const [peers, setPeers] = useState<LanPeer[]>([]);
  const [host, setHost] = useState("");
  const [btDetail, setBtDetail] = useState("checking…");
  const [btQueued, setBtQueued] = useState(0);
  const [syncKey, setSyncKey] = useState("");
  const [savedFp, setSavedFp] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const p = await loadPolicy();
    setPolicy(p);
    setPeers(listLanPeers());
    const bt = await getBtStatus();
    setBtDetail(bt.detail);
    setBtQueued(btOutbox().length);
    const k = await getSyncKeyB64();
    setSavedFp(isValidKeyB64(k) ? keyFingerprint(k!) : null);
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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Settings & privacy</Text>
      <Text>
        Clipboard contents may include passwords. Sync is end-to-end encrypted; the server never
        sees plaintext.
      </Text>
      <Text>Auto-delete default: 7 days. History limit: 1000 items. Max item: 64 KiB.</Text>

      <Text style={{ fontSize: 16, fontWeight: "600", marginTop: 8 }}>
        Transports (wifi → bluetooth)
      </Text>
      <Text style={{ color: "#666" }}>
        Direct device-to-device sync only — no account, no registration. Both devices must hold
        the same sync key and be on the same Wi-Fi (or in Bluetooth range).
      </Text>
      {(
        [
          ["WiFi LAN (same network, fastest)", "wifiEnabled", K.wifi],
          ["Bluetooth (no WiFi needed)", "bluetoothEnabled", K.bt],
        ] as [string, keyof TransportPolicy, string][]
      ).map(([label, field, key]) => (
        <Pressable
          key={field}
          onPress={() => toggle(key, field)}
          style={{ padding: 12, borderWidth: 1, borderRadius: 8 }}
        >
          <Text>{(policy[field] ? "✓ " : "○ ") + label}</Text>
        </Pressable>
      ))}
      <Text style={{ color: "#666" }}>
        Bluetooth: {btDetail}
        {btQueued > 0 ? ` (${btQueued} staged)` : ""}
      </Text>

      <Text style={{ fontSize: 16, fontWeight: "600", marginTop: 8 }}>Sync key (E2E)</Text>
      <Text style={{ color: "#666" }}>
        This key encrypts every clipboard item and must be identical on all devices. On Linux run
        `ucm key-show`, then paste the key here.
        {savedFp
          ? ` Saved fingerprint: ${savedFp} — compare with the fingerprint printed by \`ucm key-show\`.`
          : " No valid key saved yet — sync cannot decrypt."}
      </Text>
      <TextInput
        placeholder="Paste sync key (base64, 44 chars)"
        value={syncKey}
        onChangeText={setSyncKey}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      <Pressable
        onPress={async () => {
          const v = syncKey.trim();
          if (!isValidKeyB64(v)) {
            Alert.alert(
              "Invalid key",
              "The key must be base64 decoding to exactly 32 bytes (like `ucm key-show` prints).",
            );
            return;
          }
          try {
            await setSyncKeyB64(v);
          } catch (e) {
            Alert.alert(
              "Save failed",
              `Could not write the key to secure storage: ${String(e)}. The "Sync key missing" banner will keep showing until the key is saved.`,
            );
            return;
          }
          setSavedFp(keyFingerprint(v));
          setSyncKey("");
          Alert.alert("Saved", `Sync key saved. Fingerprint: ${keyFingerprint(v)}`);
        }}
        style={{ padding: 12, backgroundColor: "#111", borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center" }}>Save sync key</Text>
      </Pressable>

      <Text style={{ fontSize: 16, fontWeight: "600", marginTop: 8 }}>
        WiFi peers ({peers.length})
      </Text>
      <Text style={{ color: "#666" }}>
        On your PC run `ucm daemon` (or `ucm lan-serve`), then enter its LAN IP below. Find it with
        `hostname -I`.
      </Text>
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
            Alert.alert(
              ok ? "Peer added" : "No answer",
              ok
                ? `${p.host} answered the LAN health check.`
                : `${p.host}:${p.tcp_port} did not answer. Same Wi-Fi?`,
            );
            setPeers(listLanPeers());
            setHost("");
          }}
          style={{ padding: 12, backgroundColor: "#111", borderRadius: 8 }}
        >
          <Text style={{ color: "#fff" }}>Add</Text>
        </Pressable>
      </View>
      {peers.length === 0 ? (
        <Text style={{ color: "#888" }}>No WiFi peers yet.</Text>
      ) : (
        peers.map((item) => (
          <View
            key={item.device_id}
            style={{
              padding: 10,
              borderWidth: 1,
              borderColor: "#eee",
              borderRadius: 8,
              marginBottom: 8,
            }}
          >
            <Text>
              {item.name} · {item.host}:{item.tcp_port}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
              <Pressable
                onPress={async () => {
                  const ok = await healthCheck(item);
                  Alert.alert(
                    ok ? "Online" : "Offline",
                    ok ? "Peer answered." : "Peer did not answer.",
                  );
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
                    await pushEnvelope(
                      item,
                      buildWifiEnvelope({
                        sender_device_id: await getOrCreateLocalDeviceId(),
                        item: {
                          id: "00000000-0000-4000-8000-000000000000",
                          owner_id: "probe",
                          source_device_id: "probe",
                          content_type: "text/plain",
                          ciphertext: "eA==",
                          nonce: "eA==",
                          metadata: {},
                          created_at: new Date().toISOString(),
                          expires_at: null,
                          deleted_at: null,
                        },
                      }),
                    );
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
        ))
      )}

      <Pressable
        onPress={() =>
          Alert.alert(
            "Pause",
            "To pause sync, disable network or revoke this device temporarily. Per-device pause ships in beta.",
          )
        }
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
    </ScrollView>
  );
}
