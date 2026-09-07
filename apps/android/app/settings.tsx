import { View, Text, Pressable, Alert } from "react-native";
import { resetAll } from "../lib/identity";

/** Privacy controls: pause, expiry info, wipe. */
export default function Settings() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Settings & privacy</Text>
      <Text>Clipboard contents may include passwords. Sync is end-to-end encrypted; the server never sees plaintext.</Text>
      <Text>Auto-delete default: 7 days. History limit: 1000 items. Max item: 64 KiB.</Text>
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
