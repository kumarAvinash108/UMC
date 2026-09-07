//! `ucm` CLI: daemon + history/peer controls (tray UI hooks into the same daemon).
use clap::{Parser, Subcommand};
use ucm_linux::{bluetooth, clipboard, config::Config, db::Db, keystore, lan, sync, sync::Engine, transport};

#[derive(Parser)]
#[command(name = "ucm", version, about = "Universal Clipboard Manager — Linux agent")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the clipboard daemon (systemd --user runs this).
    Daemon,
    /// Show recent local history (decrypted).
    History { #[arg(long, default_value_t = 20)] limit: usize },
    /// Pair: print QR/short-code instructions for the phone.
    Pair,
    /// Pause / resume sync.
    Pause,
    Resume,
    /// Wipe local keys + history (deliberate reset flow).
    Reset,
    /// Print the E2E sync key (copy it into the Android app's Settings).
    KeyShow,
    /// Adopt a shared E2E key (overwrites this device's key).
    KeyImport {
        /// Base64 key from `ucm key-show` on the other device.
        key: String,
    },
    /// Show transport policy: WiFi LAN + Bluetooth + cloud switches.
    Transport,
    /// Run only the WiFi LAN listener (prints received envelope ids, never plaintext).
    LanServe,
    /// Listen for WiFi LAN beacons and list peers.
    LanPeers {
        /// Seconds to listen for beacons.
        #[arg(long, default_value_t = 6)]
        timeout: u64,
    },
    /// Encrypt TEXT with the device key and push it to one LAN peer.
    LanSend {
        /// Peer host (IPv4, e.g. 192.168.1.5).
        #[arg(long)]
        host: String,
        /// Peer LAN TCP port.
        #[arg(long, default_value_t = 41235)]
        port: u16,
        /// Plaintext to send (encrypted locally before leaving this machine).
        text: String,
    },
    /// Show Bluetooth radio status + service UUIDs.
    BtStatus,
    /// Stage a Bluetooth envelope: encrypt TEXT and print the frame plan.
    /// With `--tcp host:port` the frames are also written to that stream
    /// (RFCOMM socket, L2CAP CoC, or `nc -l` in tests — same byte format).
    BtSend {
        text: String,
        #[arg(long)]
        tcp: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("ucm=info").init();
    let cfg = Config::from_env();
    let cli = Cli::parse();
    let db_path = format!("{}/history.db", cfg.data_dir);

    match cli.cmd.unwrap_or(Cmd::Daemon) {
        Cmd::Daemon => {
            let key = keystore::load_or_create_key(&cfg.data_dir).await?;
            let db = Db::open(&db_path)?;
            let poll = cfg.poll_ms;
            Engine::new(cfg, key)
                .run(db, clipboard::autodetect(poll), clipboard::autodetect(poll))
                .await
        }
        Cmd::History { limit } => {
            let key = keystore::load_or_create_key(&cfg.data_dir).await?;
            let db = Db::open(&db_path)?;
            let user = db.get("user_id")?.unwrap_or_default();
            let device = db.get("device_id")?.unwrap_or_default();
            for item in db.recent(limit)? {
                // Per-row AAD identity (falls back to session meta for legacy rows).
                let owner = if item.owner_id.is_empty() { &user } else { &item.owner_id };
                let source = if item.source_device_id.is_empty() { &device } else { &item.source_device_id };
                match ucm_linux::crypto::decrypt(&key, &item.ciphertext, &item.nonce, &item.id, owner, source, &item.created_at) {
                    Ok(t) => println!("{}  {}", item.created_at, t.lines().next().unwrap_or_default()),
                    Err(_) => println!("{}  <undecryptable — created on another device or key>", item.created_at),
                }
            }
            Ok(())
        }
        Cmd::Pair => {
            println!("LAN-only (default): no pairing server needed. Share the sync key instead:");
            println!("  1. On this Linux device: `ucm key-show`");
            println!("  2. In the Android app: Settings → Sync key → paste → Save.");
            println!("  3. Fingerprints must match on both sides.");
            println!();
            println!("Cloud pairing (only with UCM_CLOUD_ENABLED=true):");
            println!("  1. Ensure `ucm daemon` has run once (creates your account).");
            println!("  2. In the phone app enter this server URL and confirm the 6-digit code via:");
            println!("   curl -X POST $UCM_SERVER_URL/v1/pairing/confirm -H \"Authorization: Bearer <token>\" -d '{{\"code\":\"<CODE>\"}}'");
            Ok(())
        }
        Cmd::Pause => {
            println!("Pausing: set UCM_SYNC_ENABLED=false and restart the user service:");
            println!("  systemctl --user stop ucm");
            Ok(())
        }
        Cmd::Resume => {
            println!("Resuming: set UCM_SYNC_ENABLED=true and restart:");
            println!("  systemctl --user start ucm");
            Ok(())
        }
        Cmd::Reset => {
            eprintln!("This deletes local keys and history. Type YES to confirm:");
            let mut s = String::new();
            std::io::stdin().read_line(&mut s)?;
            if s.trim() == "YES" {
                std::fs::remove_file(&db_path).ok();
                std::fs::remove_file(format!("{}/device.key", cfg.data_dir)).ok();
                println!("Local data removed. Revoke this device from another device if needed.");
            }
            Ok(())
        }
        Cmd::KeyShow => {
            let b64 = keystore::show_key_b64(&cfg.data_dir).await?;
            println!("sync key (keep secret — anyone with this can read your clipboard):");
            println!("{b64}");
            println!("fingerprint: {}", keystore::fingerprint_b64(&b64));
            println!("On the phone: Settings → Sync key → paste → Save. Fingerprints must match.");
            Ok(())
        }
        Cmd::KeyImport { key } => {
            keystore::import_key_b64(&cfg.data_dir, &key).await?;
            println!("Key imported. Restart the daemon (systemctl --user restart ucm).");
            println!("Note: history encrypted with the previous key is no longer readable.");
            Ok(())
        }
        Cmd::Transport => {
            let st = bluetooth::availability();
            println!("wifi-lan:   {}", if cfg.wifi_enabled { "enabled" } else { "disabled" });
            println!("bluetooth:  {}", if cfg.bt_enabled { "enabled" } else { "disabled" });
            println!("cloud:      {} (UCM_CLOUD_ENABLED=true to enable relay)", if cfg.cloud_enabled { "enabled" } else { "disabled — direct LAN/BT mode" });
            println!("paused:     {}", if cfg.sync_enabled { "no" } else { "yes (UCM_SYNC_ENABLED=false)" });
            println!("lan_port:   {}", cfg.lan_port);
            println!("discovery:  udp/{}", cfg.discovery_port);
            println!("bt_radio:   available={} powered={} ({})", st.available, st.powered, st.detail);
            println!("bt_service: {}", bluetooth::SERVICE_UUID);
            println!("capabilities: {:?}", cfg.capabilities());
            println!("hint: `ucm lan-peers` scans WiFi; `ucm bt-status` details the radio.");
            Ok(())
        }
        Cmd::LanServe => {
            let key = keystore::load_or_create_key(&cfg.data_dir).await?;
            let db = Db::open(&db_path).unwrap_or_else(|_| Db::open_memory().expect("memdb"));
            // Real identity (not a placeholder): pushed envelopes must carry
            // our owner namespace or peers will drop them, and vice versa.
            let sess = sync::local_session(&db, &key).unwrap_or(sync::SessionState {
                user_id: sync::lan_owner_id(&key),
                token: String::new(),
                device_id: "ephemeral".into(),
            });
            let (tx, mut rx) = tokio::sync::mpsc::channel::<lan::LanEnvelope>(32);
            let beacon = lan::local_beacon(&sess.device_id, &cfg.device_name, cfg.lan_port, cfg.capabilities());
            let reg = lan::new_registry();
            let own = sess.device_id.clone();
            let dport = cfg.discovery_port;
            let lport = cfg.lan_port;
            let serve_db = db_path.clone();
            tokio::spawn(async move { let _ = lan::announce_loop(beacon, dport).await; });
            tokio::spawn(async move { let _ = lan::discover_loop(reg, own, dport).await; });
            tokio::spawn(async move { let _ = lan::serve(lport, tx, serve_db).await; });
            println!("LAN serving on tcp/{lport} (device {}). Ctrl-C to stop.", sess.device_id);
            while let Some(env) = rx.recv().await {
                // Never print ciphertext or plaintext — id + sender only.
                println!("lan rx id={} transport={} sender={}", env.item.id, env.transport, env.sender_device_id);
                // Replica: store anything in our owner namespace for pollers.
                if env.item.owner_id == sess.user_id {
                    let db2 = Db::open(&db_path).unwrap_or_else(|_| Db::open_memory().expect("memdb"));
                    let _ = db2.insert(&lan::to_local_item(&env, true));
                }
            }
            Ok(())
        }
        Cmd::LanPeers { timeout } => {
            lan_peers_cli(&cfg, timeout).await
        }
        Cmd::LanSend { host, port, text } => {
            lan_send_cli(&cfg, &db_path, &host, port, &text).await
        }
        Cmd::BtStatus => {
            let st = bluetooth::availability();
            println!("available: {}", st.available);
            println!("powered:   {}", st.powered);
            println!("detail:    {}", st.detail);
            println!("service:   {}", bluetooth::SERVICE_UUID);
            println!("char:      {}", bluetooth::CHAR_UUID);
            println!("framing:   {} seq/total base64 lines, {}B chunks", bluetooth::FRAME_PREFIX, bluetooth::MTU_CHUNK);
            println!("next: android advertises this UUID via BLE; linux `bluetoothctl power on` then pair.");
            Ok(())
        }
        Cmd::BtSend { text, tcp } => {
            bt_send_cli(&cfg, &db_path, &text, tcp.as_deref()).await
        }
    }
}

/// Identity for one-shot CLI sends: the cloud account when the relay holds
/// one, else the key-derived LAN namespace (works fully offline).
fn cli_session(db: &Db, cfg: &Config, key: &[u8; 32]) -> anyhow::Result<sync::SessionState> {
    if cfg.cloud_enabled {
        if let (Some(user_id), Some(token), Some(device_id)) =
            (db.get("user_id")?, db.get("token")?, db.get("device_id")?)
        {
            return Ok(sync::SessionState { user_id, token, device_id });
        }
    }
    sync::local_session(db, key)
}

async fn lan_peers_cli(cfg: &Config, timeout_secs: u64) -> anyhow::Result<()> {
    let timeout = std::env::var("UCM_LAN_SCAN_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(timeout_secs);
    let _ = cfg;
    let reg = lan::new_registry();
    let sock = tokio::net::UdpSocket::bind(format!("0.0.0.0:{}", lan::DISCOVERY_PORT)).await?;
    println!("Listening for LAN beacons {timeout}s on udp/{}…", lan::DISCOVERY_PORT);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let mut buf = vec![0u8; 2048];
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, addr))) => {
                if let Ok(b) = serde_json::from_slice::<lan::Beacon>(&buf[..n]) {
                    if lan::validate_beacon(&b).is_ok() {
                        let mut reg = reg.lock().await;
                        reg.insert(
                            b.device_id.clone(),
                            lan::PeerInfo {
                                device_id: b.device_id.clone(),
                                name: b.name.clone(),
                                platform: b.platform.clone(),
                                host: addr.ip().to_string(),
                                tcp_port: b.tcp_port,
                                capabilities: b.capabilities.clone(),
                                fingerprint: b.fingerprint.clone(),
                                last_seen: std::time::Instant::now(),
                            },
                        );
                    }
                }
            }
            _ => break,
        }
    }
    let peers = lan::peer_list(&reg).await;
    if peers.is_empty() {
        println!("No peers found. Same WiFi? Is `ucm daemon`/`lan-serve` running on the other device?");
    }
    for p in &peers {
        let t = transport::pick_transport(
            &p.capabilities,
            true,
            &transport::TransportPolicy { wifi_enabled: true, bluetooth_enabled: true, cloud_enabled: true },
        );
        println!(
            "{} {} {}:{} caps={:?} via={} ",
            p.device_id,
            p.name,
            p.host,
            p.tcp_port,
            p.capabilities,
            t.map(|t| t.to_string()).unwrap_or_else(|| "none".into())
        );
    }
    Ok(())
}

async fn lan_send_cli(cfg: &Config, db_path: &str, host: &str, port: u16, text: &str) -> anyhow::Result<()> {
    let key = keystore::load_or_create_key(&cfg.data_dir).await?;
    let db = Db::open(db_path)?;
    // Real identity: cloud account when the relay holds one, else the
    // key-derived LAN namespace — placeholder owners are dropped by peers.
    let sess = cli_session(&db, cfg, &key)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (ciphertext, nonce) = ucm_linux::crypto::encrypt(&key, text, &id, &sess.user_id, &sess.device_id, &created_at)?;
    let env = lan::LanEnvelope::new_wifi(
        &sess.device_id,
        &cfg.device_name,
        lan::LanItem {
            id: id.clone(),
            owner_id: sess.user_id.clone(),
            source_device_id: sess.device_id.clone(),
            content_type: "text/plain".into(),
            ciphertext,
            nonce,
            metadata: serde_json::json!({}),
            created_at,
            expires_at: None,
            deleted_at: None,
        },
    );
    lan::validate_envelope(&env)?;
    let peer = lan::PeerInfo {
        device_id: format!("manual:{host}:{port}"),
        name: "manual".into(),
        platform: "unknown".into(),
        host: host.into(),
        tcp_port: port,
        capabilities: vec!["wifi-lan".into()],
        fingerprint: None,
        last_seen: std::time::Instant::now(),
    };
    lan::push_to_peer(&peer, &env).await?;
    println!("sent {id} to {host}:{port} (ciphertext only, {}B)", text.len());
    Ok(())
}

async fn bt_send_cli(cfg: &Config, db_path: &str, text: &str, tcp: Option<&str>) -> anyhow::Result<()> {
    let key = keystore::load_or_create_key(&cfg.data_dir).await?;
    let db = Db::open(db_path)?;
    let sess = cli_session(&db, cfg, &key)?;
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (ciphertext, nonce) = ucm_linux::crypto::encrypt(&key, text, &id, &sess.user_id, &sess.device_id, &created_at)?;
    let env = lan::LanEnvelope {
        v: 1,
        transport: "bluetooth".into(),
        sender_device_id: sess.device_id.clone(),
        sender_name: Some(cfg.device_name.clone()),
        item: lan::LanItem {
            id: id.clone(),
            owner_id: sess.user_id.clone(),
            source_device_id: sess.device_id.clone(),
            content_type: "text/plain".into(),
            ciphertext,
            nonce,
            metadata: serde_json::json!({}),
            created_at,
            expires_at: None,
            deleted_at: None,
        },
    };
    let frames = bluetooth::encode_frames(&env)?;
    println!("staged bt envelope {id} as {} frame(s) (service {})", frames.len(), bluetooth::SERVICE_UUID);
    if let Some(addr) = tcp {
        let mut stream = tokio::net::TcpStream::connect(addr).await?;
        let n = bluetooth::send_over_stream(&mut stream, &env).await?;
        println!("wrote {n} frame(s) to {addr}");
    } else {
        println!("preview: {}", frames.first().map(|f| f.chars().take(64).collect::<String>()).unwrap_or_default());
        println!("hint: `ucm bt-send --tcp <host:port> \"text\"` writes the same bytes an RFCOMM socket would carry.");
    }
    Ok(())
}
