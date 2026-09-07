import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import { api } from "../lib/api";
import { loadIdentity, saveIdentity, loadOrCreateKeyB64 } from "../lib/identity";

/** Pairing: request a 6-digit code on an approved device, confirm here. */
export default function Pair() {
  const [serverOk, setServerOk] = useState(false);
  const [code, setCode] = useState("");

  async function bootstrap() {
    const id = await loadIdentity();
    let user_id = id.user_id ?? undefined;
    let token = id.token ?? undefined;
    if (!token) {
      const s = await api.createSession(user_id ?? undefined);
      user_id = s.user_id;
      token = s.token;
    }
    await loadOrCreateKeyB64();
    if (!id.device_id && token) {
      const d = await api.registerDevice(token, "android-phone", "android", "v1-placeholder-pk");
      await saveIdentity({ user_id: user_id!, token, device_id: d.id });
    }
    setServerOk(true);
    Alert.alert("Ready", "Device registered. Enter the 6-digit pairing code shown on your other device.");
  }

  async function confirm() {
    const id = await loadIdentity();
    if (!id.token) { Alert.alert("Error", "Bootstrap first."); return; }
    try {
      const res = await api.confirmPairing(id.token, code.trim());
      Alert.alert("Paired", `Device trusted. Fingerprint: ${res.fingerprint ?? "n/a"}`);
    } catch (e) {
      Alert.alert("Failed", String(e));
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Pair devices</Text>
      <Text>1. Run the Linux agent once (creates your account). 2. Request a code there. 3. Confirm it here — check the fingerprint matches on both sides.</Text>
      <Pressable onPress={bootstrap} style={{ padding: 12, backgroundColor: "#111", borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>Register this phone</Text>
      </Pressable>
      {serverOk && (
        <>
          <TextInput
            placeholder="6-digit code"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={6}
            style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
          />
          <Pressable onPress={confirm} style={{ padding: 12, backgroundColor: "#0a7", borderRadius: 8 }}>
            <Text style={{ color: "#fff", textAlign: "center" }}>Confirm pairing</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
