# Linux install (Ubuntu 24.04 / Fedora, GNOME Wayland + X11 fallback)

## From source
```bash
cargo build --release -p ucm-linux
sudo install -m755 target/release/ucm /usr/local/bin/ucm
mkdir -p ~/.config/systemd/user
cp apps/linux/systemd/ucm.service ~/.config/systemd/user/ucm.service
systemctl --user daemon-reload
systemctl --user enable --now ucm
loginctl enable-linger  # optional: run while logged out
journalctl --user -u ucm -f
```

Env (`~/.config/ucm/env` or systemd `Environment=`):
`UCM_SERVER_URL=http://localhost:3000 UCM_DEVICE_NAME=my-linux UCM_DATA_DIR=~/.local/share/ucm UCM_SYNC_ENABLED=true`

## Packaging
- **.deb (Ubuntu)**: `cargo deb -p ucm-linux` (add `[package.metadata.deb]` as needed) → `target/debian/*.deb`.
- **.rpm (Fedora)**: `cargo rpm` / `cargo-generate-rpm` → `target/generate-rpm/*.rpm`.
- Both install `/usr/bin/ucm` + the user unit; service runs as `systemd --user`.

## Wayland vs X11
Auto-detected via `WAYLAND_DISPLAY`. On GNOME Wayland the agent polls the clipboard (800 ms default); keep the daemon in the graphical session (`After=graphical-session.target`). X11 sessions use the same interface through the X11 backend.

## Troubleshooting
- No clipboard: ensure a GNOME session is active; check `echo $WAYLAND_DISPLAY`.
- No sync: `curl $UCM_SERVER_URL/v1/health`; check token in `~/.local/share/ucm/history.db` meta table.
- Reset: `ucm reset` (type YES), then revoke the old device from the phone.
