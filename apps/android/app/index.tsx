import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, RefreshControl, Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import { Link, useRouter } from "expo-router";
import { getSyncKeyB64, setSyncKeyB64, getOrCreateLocalDeviceId } from "../lib/identity";
import { listLanPeers, fetchPeerItems, type LanPollCursor } from "../lib/lan";
import { decryptText, encryptText, generateSyncKeyB64, isValidKeyB64, keyFingerprint, lanOwnerId, randomId } from "../lib/crypto";
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
 * Returns the plaintext on success, or null when the item was skipped
 * (wrong key / tampered) — the raw bytes are never displayed or logged.
 * The caller reuses the returned plaintext instead of decrypting twice,
 * so one bad item never aborts the whole refresh.
 */
async function importCiphertext(syncKey: string, it: ServerItem): Promise<string | null> {
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
    return pt;
  } catch {
    return null;
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
      const policy = await loadPolicy();
      const syncKey = await getSyncKeyB64();
      const keyOk = isValidKeyB64(syncKey);
      setHasKey(keyOk);
      let failed = 0;
      if (keyOk) {
        // WiFi/Bluetooth only: identity is the key-derived LAN namespace
        // (must match Linux `lan_owner_id`) — no accounts, no registration.
        const localDeviceId = await getOrCreateLocalDeviceId();
        // New/changed sync key => full LAN re-pull so previously skipped
        // items get another chance instead of staying behind the cursor.
        const fp = keyFingerprint(syncKey!);
        const prevFp = await SecureStore.getItemAsync(CURSOR_K.keyFp);
        if (prevFp !== fp) {
          await SecureStore.setItemAsync(CURSOR_K.keyFp, fp);
          await SecureStore.deleteItemAsync(CURSOR_K.since);
          await SecureStore.deleteItemAsync(CURSOR_K.sinceId);
        }
        // Direct LAN poll: every known peer serves its replica.
        // Cursor is shared across peers — replicas overlap, and the max
        // cursor always moves forward.
        if (policy.wifiEnabled) {
          let cursor = await loadLanCursor();
          for (const peer of listLanPeers()) {
            try {
              for (let p = 0; p < 5; p++) {
                const r = await fetchPeerItems(peer, cursor, 100);
                for (const env of r.items) {
                  const text = await importCiphertext(syncKey!, {
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
                  if (text === null) {
                    failed += 1;
                    continue;
                  }
                  if (!appliedIncomingIds.current.has(env.item.id) && Date.parse(env.item.created_at) >= startedAt.current && env.item.source_device_id !== localDeviceId) {
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
    return () => {
      clearInterval(poll);
      clearInterval(refreshTimer);
    };
  }, [refresh]);

  async function copyRow(row: LocalRow) {
    await Clipboard.setStringAsync(row.plaintext);
    Alert.alert("Copied", "Item copied to Android clipboard.");
  }

  /** Read the Android clipboard, encrypt, and fan out (wifi → bluetooth). */
  async function pushClipboard(silent = false) {
    if (pushingRef.current) return;
    pushingRef.current = true;
    setPushing(true);
    try {
      const policy = await loadPolicy();
      const syncKey = await getSyncKeyB64();
      // Unreachable in the UI (first-run onboarding gates on a valid key),
      // but never push unencrypted rather than nagging.
      if (!isValidKeyB64(syncKey)) return;
      // Identity is the key-derived LAN namespace (must match Linux
      // `lan_owner_id`) — no accounts, no registration.
      const owner = lanOwnerId(syncKey!);
      const source = await getOrCreateLocalDeviceId();
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
        pending: 0,
      });
      lastPushedText.current = text;
      const via = [`wifi:${r.wifi}`, `bt:${r.bluetooth}`].join(" ");
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

  // First run (or after Reset): no nagging banner — a dedicated setup
  // screen that explains the two ways to get a sync key.
  if (hasKey === false) {
    return <KeyOnboarding onDone={refresh} />;
  }

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Clipboard history ({status})</Text>
      <Text style={{ color: "#666" }}>
        Android cannot monitor the clipboard in the background. Copy text, tap Push, then pull to
        refresh for items from your other devices.
        {` `}WiFi peers: {listLanPeers().length} — add your PC's LAN IP in Settings for direct sync.
      </Text>
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

/**
 * First-run setup: no "sync key missing" error — the user either pastes the
 * key from Linux (`ucm key-show`) or generates a fresh one here and imports
 * it on Linux (`ucm key-import <key>`). Either way both sides end up with
 * the same E2E key and the history screen takes over.
 */
function KeyOnboarding({ onDone }: { onDone: () => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [fresh, setFresh] = useState<{ key: string; fallback: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  async function savePasted() {
    const v = draft.trim();
    if (!isValidKeyB64(v)) {
      Alert.alert(
        "That doesn't look like a sync key",
        "Paste the exact output of `ucm key-show` on your Linux device (base64, 44 characters).",
      );
      return;
    }
    setSaving(true);
    try {
      const home = await setSyncKeyB64(v);
      setDraft("");
      if (home === "fallback") {
        Alert.alert(
          "Saved (with a note)",
          "Your phone's secure hardware store refused the key, so it is kept in the app-private database instead. Sync works normally.",
        );
      }
      await onDone();
    } catch (e) {
      Alert.alert("Couldn't save the key", `Storage failed on this phone: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function generate() {
    setSaving(true);
    let k: string;
    try {
      k = generateSyncKeyB64();
    } catch (e) {
      Alert.alert("Couldn't create a key", `This phone refused to make random bytes: ${String(e)}`);
      setSaving(false);
      return;
    }
    try {
      const home = await setSyncKeyB64(k);
      setFresh({ key: k, fallback: home === "fallback" });
    } catch (e) {
      Alert.alert("Couldn't save the key", `Key created, but storage failed on this phone: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function copyFresh() {
    if (fresh) await Clipboard.setStringAsync(fresh.key);
  }

  return (
    <View style={{ flex: 1, padding: 20, gap: 14, justifyContent: "center" }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Welcome to UCM 🎉</Text>
      <Text style={{ color: "#444" }}>
        Everything is end-to-end encrypted over direct WiFi / Bluetooth — no account, no
        registration. First, both devices need the same sync key. Pick one:
      </Text>

      <Text style={{ fontSize: 16, fontWeight: "600" }}>Option 1 — paste your Linux key</Text>
      <Text style={{ color: "#666" }}>
        On your PC run `ucm key-show`, then paste the key here.
      </Text>
      <TextInput
        placeholder="Paste sync key (base64, 44 chars)"
        value={draft}
        onChangeText={setDraft}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
      />
      <Pressable
        onPress={() => void savePasted()}
        disabled={saving}
        style={{ padding: 14, backgroundColor: saving ? "#666" : "#0a7", borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>
          {saving ? "Saving…" : "Save pasted key"}
        </Text>
      </Pressable>

      <Text style={{ fontSize: 16, fontWeight: "600" }}>Option 2 — make one here</Text>
      <Text style={{ color: "#666" }}>
        No Linux key yet? Generate one, then on your PC run `ucm key-import` with it.
      </Text>
      <Pressable
        onPress={() => void generate()}
        disabled={saving}
        style={{ padding: 14, backgroundColor: saving ? "#666" : "#111", borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>
          {saving ? "Saving…" : "Generate a new key"}
        </Text>
      </Pressable>
      {fresh && (
        <View style={{ padding: 12, borderWidth: 1, borderColor: "#0a7", borderRadius: 8, gap: 8 }}>
          <Text selectable style={{ fontFamily: "monospace" }}>
            {fresh.key}
          </Text>
          <Text style={{ color: "#666", fontSize: 12 }}>
            Fingerprint: {keyFingerprint(fresh.key)} — compare after `ucm key-import` on Linux.
          </Text>
          {fresh.fallback && (
            <Text style={{ color: "#966800", fontSize: 12 }}>
              Note: your phone's secure hardware store refused the key, so it is kept in the
              app-private database instead. Sync works normally.
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => void copyFresh()}
              style={{ padding: 8, backgroundColor: "#111", borderRadius: 6 }}
            >
              <Text style={{ color: "#fff" }}>Copy key</Text>
            </Pressable>
            <Pressable
              onPress={() => void onDone()}
              style={{ padding: 8, borderWidth: 1, borderRadius: 6 }}
            >
              <Text>Done — show history</Text>
            </Pressable>
          </View>
        </View>
      )}
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
