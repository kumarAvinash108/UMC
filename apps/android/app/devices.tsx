import { useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, Alert } from "react-native";
import { api } from "../lib/api";
import { loadIdentity } from "../lib/identity";

export default function Devices() {
  const [devices, setDevices] = useState<{ id: string; name: string; platform: string; revoked_at: string | null }[]>([]);

  async function load() {
    const id = await loadIdentity();
    if (!id.token) return;
    const res = await api.listDevices(id.token);
    setDevices(res.devices);
  }

  useEffect(() => { load(); }, []);

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Devices</Text>
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={<Text>No devices yet.</Text>}
        renderItem={({ item }) => (
          <View style={{ padding: 12, borderWidth: 1, borderRadius: 8, marginBottom: 8 }}>
            <Text>{item.name} ({item.platform})</Text>
            <Text style={{ color: "#888", fontSize: 12 }}>{item.id}</Text>
            {item.revoked_at ? (
              <Text style={{ color: "red" }}>Revoked</Text>
            ) : (
              <Pressable
                onPress={async () => {
                  const id = await loadIdentity();
                  await api.revokeDevice(id.token!, item.id);
                  Alert.alert("Revoked", "Device will stop receiving new items.");
                  await load();
                }}
                style={{ marginTop: 8, padding: 8, borderWidth: 1, borderRadius: 6 }}
              >
                <Text>Revoke</Text>
              </Pressable>
            )}
          </View>
        )}
      />
    </View>
  );
}
