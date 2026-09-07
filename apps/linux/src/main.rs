//! `ucm` CLI: daemon + history/peer controls (tray UI hooks into the same daemon).
use clap::{Parser, Subcommands};
use ucm_linux::{clipboard, config::Config, db::Db, keystore, sync::Engine};

#[derive(Parser)]
#[command(name = "ucm", version, about = "Universal Clipboard Manager — Linux agent")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommands)]
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter("ucm=info").init();
    let cfg = Config::from_env();
    let cli = Cli::parse();
    let db_path = format!("{}/history.db", cfg.data_dir);

    match cli.cmd.unwrap_or(Cmd::Daemon) {
        Cmd::Daemon => {
            let key = keystore::load_or_create_key(&cfg.data_dir)?;
            let db = Db::open(&db_path)?;
            let poll = cfg.poll_ms;
            Engine::new(cfg, key)
                .run(db, clipboard::autodetect(poll), clipboard::autodetect(poll))
                .await
        }
        Cmd::History => {
            let key = keystore::load_or_create_key(&cfg.data_dir)?;
            let db = Db::open(&db_path)?;
            let user = db.get("user_id")?.unwrap_or_default();
            let device = db.get("device_id")?.unwrap_or_default();
            for item in db.recent(20)? {
                // created_at is needed for AAD; stored alongside in v1 queue rows via created_at col.
                match ucm_linux::crypto::decrypt(&key, &item.ciphertext, &item.nonce, &item.id, &user, &device, &item.created_at) {
                    Ok(t) => println!("{}  {}", item.created_at, t.lines().next().unwrap_or_default()),
                    Err(_) => println!("{}  <undecryptable — created on another device>", item.created_at),
                }
            }
            Ok(())
        }
        Cmd::Pair => {
            println!("1. Install the Android app and open Pair.");
            println!("2. On this Linux device, ensure `ucm daemon` has run once (creates your account).");
            println!("3. In the phone app enter this server URL and confirm the 6-digit code it shows via:");
            println!("   curl -X POST $UCM_SERVER_URL/v1/pairing/confirm -H \"Authorization: Bearer <token>\" -d '{{\"code\":\"<CODE>\"}}'");
            println!("4. Verify the device fingerprint shown on both sides before confirming.");
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
    }
}
