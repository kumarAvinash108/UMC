import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, RefreshControl, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import { Link, useRouter } from "expo-router";
import { api, wsUrl } from "../lib/api";
import { loadIdentity, getSyncKeyB64, getOrCreateLocalDeviceId } from "../lib/identity";
import { listLanPeers, fetchPeerItems, type LanPollCursor } from "../lib/lan";
import { decryptText, encryptText, isValidKeyB64, keyFingerprint, lanOwnerId, randomId } from "../lib/crypto";
import { fanOut, loadPolicy } from "../lib/transport";
import { searchRows, upsertRow, setPinned, deleteRow, type LocalRow } from "../lib/store";

const CURSOR_K = { since: "ucm.lan_since", sinceId: "ucm.lan_since_id", keyFp: "ucm.key_fp" };

async function loadLanCursor(): Promise<LanPollCursor | null> {
  const [since, since_id] = await Promise.all([
    SecureStore.getItemAsync(CURSOR_K.since),
    SecureStore.getItemAsync(CURSOR_K.sinceId),
  ]);
  return since ? { since, since_id: since_id ?? "" } : null;
}

async function saveLanCursor(c: LanPollCursor | null) {
  if (!c) return;
  await Promise.all([
    SecureStore.setItemAsync(CURSOR_K.since, c.since),
    SecureStore.setItemAsync(CURSOR_K.sinceId, c.since_id),
  ]);
}

interface ServerItem {
  id: string;
  owner_id: string;
  source_device_id: string;
  content_type: "text/plain";
  ciphertext: string;
  nonce: string;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
  deleted_at: string | null;
}

/**
 * Decrypt one ciphertext item and import it to local history.
 * Returns 1 when the item was skipped (wrong key / tampered) — the raw
 * bytes are never displayed or logged.
 */
async function importCiphertext(syncKey: string, it: ServerItem): Promise<number> {
  try {
    const pt = decryptText({
      keyB64: syncKey,
      ciphertextB64: it.ciphertext,
      nonceB64: it.nonce,
      aad: {
        id: it.id,
        owner_id: it.owner_id,
        source_device_id: it.source_device_id,
        content_type: "text/plain",
        created_at: it.created_at,
      },
    });
    await upsertRow({
      id: it.id,
      plaintext: pt,
      source_device: it.source_device_id,
      created_at: it.created_at,
      pinned: 0,
      pending: 0,
    });
    return 0;
  } catch {
    return 1;
  }
}

async function writeIncomingClipboard(text: string, source: string, localDeviceId: string) {
  if (source === localDeviceId) return;
  await Clipboard.setStringAsync(text);
}

/**
 * History screen: foreground pull/push + sync-status indicator + copy action.
 * Android only permits reliable clipboard access while the app is foregrounded,
 * so the foreground loop polls and syncs new clipboard text automatically.
 */
export default function History() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [status, setStatus] = useState<"offline" | "syncing" | "live">("offline");
  const [refreshing, setRefreshing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  const router = useRouter();
  const startedAt = useRef(Date.now());
  const lastPushedText = useRef<string | null>(null);
  const ignoredClipboardText = useRef<string | null>(null);
  const appliedIncomingIds = useRef<Set<string>>(new Set());
  const pushingRef = useRef(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStatus("syncing");
    try {
      const id = await loadIdentity();
      const policy = await loadPolicy();
      const syncKey = await getSyncKeyB64();
      const keyOk = isValidKeyB64(syncKey);
      setHasKey(keyOk);
      let failed = 0;
      if (keyOk) {
        const localDeviceId = policy.cloudEnabled && id.device_id
          ? id.device_id
          : await getOrCreateLocalDeviceId();
        // New/changed sync key => full LAN re-pull so previously skipped
        // items get another chance instead of staying behind the cursor.
        const fp = keyFingerprint(syncKey!);
        const prevFp = await SecureStore.getItemAsync(CURSOR_K.keyFp);
        if (prevFp !== fp) {
          await SecureStore.setItemAsync(CURSOR_K.keyFp, fp);
          await SecureStore.deleteItemAsync(CURSOR_K.since);
          await SecureStore.deleteItemAsync(CURSOR_K.sinceId);
        }
        // Cloud pull (opt-in relay for off-LAN devices).
        if (policy.cloudEnabled && id.token) {
          const page = (await api.listItems(id.token, undefined, 50)) as { items: ServerItem[] };
          for (const it of page.items ?? []) {
            if (it.deleted_at) continue;
            failed += await importCiphertext(syncKey!, it);
            if (!appliedIncomingIds.current.has(it.id) && Date.parse(it.created_at) >= startedAt.current && it.source_device_id !== localDeviceId) {
              const text = decryptText({
                keyB64: syncKey!, ciphertextB64: it.ciphertext, nonceB64: it.nonce,
                aad: { id: it.id, owner_id: it.owner_id, source_device_id: it.source_device_id, content_type: "text/plain", created_at: it.created_at },
              });
              ignoredClipboardText.current = text;
              await writeIncomingClipboard(text, it.source_device_id, localDeviceId);
              appliedIncomingIds.current.add(it.id);
            }
          }
        }
        // Direct LAN poll (no cloud): every known peer serves its replica.
        // Cursor is shared across peers — replicas overlap, and the max
        // cursor always moves forward.
        if (policy.wifiEnabled) {
          let cursor = await loadLanCursor();
          for (const peer of listLanPeers()) {
            try {
              for (let p = 0; p < 5; p++) {
                const r = await fetchPeerItems(peer, cursor, 100);
                for (const env of r.items) {
                  failed += await importCiphertext(syncKey!, {
                    id: env.item.id,
                    owner_id: env.item.owner_id,
                    source_device_id: env.item.source_device_id,
                    content_type: "text/plain",
                    ciphertext: env.item.ciphertext,
                    nonce: env.item.nonce,
                    metadata: env.item.metadata,
                    created_at: env.item.created_at,
                    expires_at: env.item.expires_at,
                    deleted_at: null,
                  });
                  if (!appliedIncomingIds.current.has(env.item.id) && Date.parse(env.item.created_at) >= startedAt.current && env.item.source_device_id !== localDeviceId) {
                    const text = decryptText({
                      keyB64: syncKey!, ciphertextB64: env.item.ciphertext, nonceB64: env.item.nonce,
                      aad: { id: env.item.id, owner_id: env.item.owner_id, source_device_id: env.item.source_device_id, content_type: "text/plain", created_at: env.item.created_at },
                    });
                    ignoredClipboardText.current = text;
                    await writeIncomingClipboard(text, env.item.source_device_id, localDeviceId);
                    appliedIncomingIds.current.add(env.item.id);
                  }
                }
                cursor = r.cursor;
                if (r.items.length < 100) break;
              }
            } catch {
              // Peer asleep or gone — next refresh retries.
            }
          }
          await saveLanCursor(cursor);
        }
      }
      setUnreadable(failed);
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
    const poll = setInterval(async () => {
      if (pushingRef.current) return;
      const text = (await Clipboard.getStringAsync()).trim();
      if (!text || text === lastPushedText.current) return;
      if (text === ignoredClipboardText.current) {
        ignoredClipboardText.current = null;
        return;
      }
      await pushClipboard(true);
    }, 1000);
    const refreshTimer = setInterval(refresh, 3000);
    let ws: WebSocket | null = null;
    (async () => {
      const id = await loadIdentity();
      const policy = await loadPolicy();
      // WS live updates only exist on the opt-in cloud relay.
      if (!policy.cloudEnabled || !id.token) return;
      ws = new WebSocket(wsUrl(id.token));
      ws.onmessage = async (m) => {
        try {
          const evt = JSON.parse(m.data);
          if (evt.type === "item.created" || evt.type === "item.deleted") await refresh();
        } catch {}
      };
    })();
    return () => {
      clearInterval(poll);
      clearInterval(refreshTimer);
      ws?.close();
    };
  }, [refresh]);

  async function copyRow(row: LocalRow) {
    await Clipboard.setStringAsync(row.plaintext);
    Alert.alert("Copied", "Item copied to Android clipboard.");
  }

  /** Read the Android clipboard, encrypt, and fan out (wifi → bluetooth → cloud-if-enabled). */
  async function pushClipboard(silent = false) {
    if (pushingRef.current) return;
    pushingRef.current = true;
    setPushing(true);
    try {
      const id = await loadIdentity();
      const policy = await loadPolicy();
      const syncKey = await getSyncKeyB64();
      if (!isValidKeyB64(syncKey)) {
        Alert.alert("Sync key missing", "Paste the key from `ucm key-show` in Settings first.");
        return;
      }
      // Identity: cloud account when the relay is on and paired, otherwise
      // the key-derived LAN namespace (must match Linux `lan_owner_id`).
      const cloudMode = policy.cloudEnabled && !!id.token && !!id.user_id && !!id.device_id;
      const owner = cloudMode ? id.user_id! : lanOwnerId(syncKey!);
      const source = cloudMode ? id.device_id! : await getOrCreateLocalDeviceId();
      const text = (await Clipboard.getStringAsync()).trim();
      if (!text) {
        if (!silent) Alert.alert("Clipboard empty", "Copy some text first, then push.");
        return;
      }
      if (text === lastPushedText.current) return;
      if (text.length > 60_000) {
        Alert.alert("Too large", "v1 text items are capped (~60 KiB).");
        return;
      }
      const itemId = randomId();
      const created_at = new Date().toISOString();
      const { ciphertextB64, nonceB64 } = encryptText({
        keyB64: syncKey!,
        plaintext: text,
        aad: {
          id: itemId,
          owner_id: owner,
          source_device_id: source,
          content_type: "text/plain",
          created_at,
        },
      });
      const r = await fanOut(
        cloudMode ? id.token : null,
        {
          id: itemId,
          content_type: "text/plain",
          ciphertext: ciphertextB64,
          nonce: nonceB64,
          metadata: {},
          owner_id: owner,
          source_device_id: source,
          sender_name: "android-phone",
          created_at,
          expires_at: null,
        },
        policy,
      );
      await upsertRow({
        id: itemId,
        plaintext: text,
        source_device: source,
        created_at,
        pinned: 0,
        pending: policy.cloudEnabled && !r.cloud ? 1 : 0,
      });
      lastPushedText.current = text;
      const via = [
        `wifi:${r.wifi}`,
        `bt:${r.bluetooth}`,
        `cloud:${r.cloud ? "ok" : policy.cloudEnabled ? "queued" : "off"}`,
      ].join(" ");
      if (!silent) {
        Alert.alert(
          "Pushed",
          r.errors.length ? `Sent (${via}). Notes: ${r.errors.join("; ")}` : `Sent (${via}).`,
        );
      }
      await refresh();
    } catch (e) {
      if (!silent) Alert.alert("Push failed", String(e));
    } finally {
      pushingRef.current = false;
      setPushing(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Clipboard history ({status})</Text>
      <Text style={{ color: "#666" }}>
        Android cannot monitor the clipboard in the background. Copy text, tap Push, then pull to
        refresh for items from your other devices.
        {` `}WiFi peers: {listLanPeers().length} — add your PC's LAN IP in Settings for direct sync.
      </Text>
      {hasKey === false && (
        <Pressable
          onPress={() => router.push("/settings")}
          style={{
            padding: 12,
            backgroundColor: "#fff4e0",
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#e0a800",
          }}
        >
          <Text>
            Sync key missing — nothing can decrypt. Tap to paste the key from `ucm key-show`.
          </Text>
        </Pressable>
      )}
      {unreadable > 0 && (
        <Pressable
          onPress={() => router.push("/settings")}
          style={{
            padding: 12,
            backgroundColor: "#fdecea",
            borderRadius: 8,
            borderWidth: 1,
            borderColor: "#c00",
          }}
        >
          <Text>
            {unreadable} item(s) can't be decrypted — sync-key mismatch? Tap to re-enter the key.
          </Text>
        </Pressable>
      )}
      <Pressable
        onPress={() => void pushClipboard()}
        disabled={pushing}
        style={{ padding: 14, backgroundColor: pushing ? "#666" : "#0a7", borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>
          {pushing ? "Pushing…" : "Push current clipboard"}
        </Text>
      </Pressable>
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
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          <View style={{ gap: 12, paddingBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: "600" }}>Clipboard history ({status})</Text>
            <Text style={{ color: "#666" }}>
              Android cannot monitor the clipboard in the background. Copy text, tap Push, then pull to
              refresh for items from your other devices. WiFi peers: {listLanPeers().length} — add your
              PC's LAN IP in Settings for direct sync.
            </Text>
            {hasKey === false && (
              <Pressable onPress={() => router.push("/settings")} style={{ padding: 12, backgroundColor: "#fff4e0", borderRadius: 8, borderWidth: 1, borderColor: "#e0a800" }}>
                <Text>Sync key missing — nothing can decrypt. Tap to paste the key from `ucm key-show`.</Text>
              </Pressable>
            )}
            {unreadable > 0 && (
              <Pressable onPress={() => router.push("/settings")} style={{ padding: 12, backgroundColor: "#fdecea", borderRadius: 8, borderWidth: 1, borderColor: "#c00" }}>
                <Text>{unreadable} item(s) can't be decrypted — sync-key mismatch? Tap to re-enter the key.</Text>
              </Pressable>
            )}
            <Pressable onPress={() => void pushClipboard()} disabled={pushing} style={{ padding: 14, backgroundColor: pushing ? "#666" : "#0a7", borderRadius: 8 }}>
              <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>{pushing ? "Pushing…" : "Push current clipboard"}</Text>
            </Pressable>
            <TextInput placeholder="Search history…" value={q} onChangeText={(t) => setQ(t)} onSubmitEditing={refresh} style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }} />
          </View>
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={<Text>No items yet. Copy text on Linux, then pull to refresh.</Text>}
        renderItem={({ item }) => (
          <View
            style={{
              padding: 12,
              borderWidth: 1,
              borderColor: "#eee",
              borderRadius: 8,
              marginBottom: 8,
            }}
          >
            <Text numberOfLines={3}>{item.plaintext}</Text>
            <Text style={{ color: "#888", fontSize: 12 }}>
              {item.created_at} · {item.source_device}
            </Text>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Pressable
                onPress={() => copyRow(item)}
                style={{ padding: 8, backgroundColor: "#111", borderRadius: 6 }}
              >
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
                    try {
                      await api.deleteItem(id.token, item.id);
                    } catch {}
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
        ListFooterComponent={
          <View style={{ gap: 12, paddingTop: 4 }}>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Link href="/pair">Pair a device</Link>
              <Link href="/devices">Devices</Link>
              <Link href="/settings">Settings</Link>
            </View>
            {__DEV__ && <SyncSelfTest onSeed={async (t) => {
              await upsertRow({ id: `local-${Date.now()}`, plaintext: t, source_device: "demo", created_at: new Date().toISOString(), pinned: 0, pending: 0 });
              await refresh();
            }} />}
          </View>
        }
      />
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
