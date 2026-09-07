import { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, RefreshControl, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Link } from "expo-router";
import { api, wsUrl } from "../lib/api";
import { loadIdentity } from "../lib/identity";
import { searchRows, upsertRow, setPinned, deleteRow, type LocalRow } from "../lib/store";

/**
 * History screen: foreground refresh + sync-status indicator + copy action.
 * Background clipboard monitoring is intentionally NOT promised (Android OS limits).
 */
export default function History() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [status, setStatus] = useState<"offline" | "syncing" | "live">("offline");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStatus("syncing");
    try {
      const id = await loadIdentity();
      if (id.token) {
        // Pull latest server items (ciphertext) — NOTE: v1 Android decrypts with
        // the shared device key established at pairing; production uses per-device
        // key agreement. For scaffold, server ciphertext shown as pending-decrypt
        // is skipped unless we hold the key (Linux demo uses same test key flow).
        const page = await api.listItems(id.token, undefined, 50);
        void page;
      }
      setRows(await searchRows(q));
      setStatus("live");
    } catch (e) {
      setStatus("offline");
    } finally {
      setRefreshing(false);
    }
  }, [q]);

  useEffect(() => {
    refresh();
    let ws: WebSocket | null = null;
    (async () => {
      const id = await loadIdentity();
      if (!id.token) return;
      ws = new WebSocket(wsUrl(id.token));
      ws.onmessage = async (m) => {
        try {
          const evt = JSON.parse(m.data);
          if (evt.type === "item.created" || evt.type === "item.deleted") await refresh();
        } catch {}
      };
    })();
    return () => ws?.close();
  }, [refresh]);

  async function copyRow(row: LocalRow) {
    await Clipboard.setStringAsync(row.plaintext);
    Alert.alert("Copied", "Item copied to Android clipboard.");
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Clipboard history ({status})</Text>
      <Text style={{ color: "#666" }}>
        Android cannot monitor the clipboard in the background. Pull to refresh while the app is open, then tap an item to copy it.
      </Text>
      <TextInput
        placeholder="Search history…"
        value={q}
        onChangeText={(t) => setQ(t)}
        onSubmitEditing={refresh}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={<Text>No items yet. Copy text on Linux, then pull to refresh.</Text>}
        renderItem={({ item }) => (
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 8, marginBottom: 8 }}>
            <Text numberOfLines={3}>{item.plaintext}</Text>
            <Text style={{ color: "#888", fontSize: 12 }}>{item.created_at} · {item.source_device}</Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Pressable onPress={() => copyRow(item)} style={{ padding: 8, backgroundColor: "#111", borderRadius: 6 }}>
                <Text style={{ color: "#fff" }}>Copy</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  await setPinned(item.id, !item.pinned);
                  await refresh();
                }}
                style={{ padding: 8, borderWidth: 1, borderRadius: 6 }}
              >
                <Text>{item.pinned ? "Unpin" : "Pin"}</Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  const id = await loadIdentity();
                  if (id.token) {
                    try { await api.deleteItem(id.token, item.id); } catch {}
                  }
                  await deleteRow(item.id);
                  await refresh();
                }}
                style={{ padding: 8, borderWidth: 1, borderRadius: 6 }}
              >
                <Text>Delete</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Link href="/pair">Pair a device</Link>
        <Link href="/devices">Devices</Link>
        <Link href="/settings">Settings</Link>
      </View>
      {__DEV__ && <SyncSelfTest onSeed={async (t) => { await upsertRow({ id: `local-${Date.now()}`, plaintext: t, source_device: "demo", created_at: new Date().toISOString(), pinned: 0, pending: 0 }); await refresh(); }} />}
    </View>
  );
}

function SyncSelfTest({ onSeed }: { onSeed: (t: string) => Promise<void> }) {
  return (
    <Pressable onPress={() => onSeed("hello from self-test")} style={{ padding: 8 }}>
      <Text style={{ color: "#888" }}>Seed demo row (dev)</Text>
    </Pressable>
  );
}
