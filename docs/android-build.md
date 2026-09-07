# Android build (Expo dev build)

## Prereqs
Node 20+, Android SDK / Android Studio, `npx expo` working.

## Run
```bash
cd apps/android
npm install
npx expo start            # dev server (foreground sync, pull-to-refresh, tap-to-copy)
npx expo run:android      # development build on emulator/device
eas build -p android --profile preview  # signed test artifact (needs EAS account)
```

## Connecting a physical phone ("Network request failed")

`localhost` on a phone means the phone itself, so the app must use your PC's
LAN IP. The app auto-derives it from the Metro host, but an explicit URL is
more reliable:

```bash
hostname -I  # e.g. 192.168.224.147
echo 'EXPO_PUBLIC_SYNC_URL=http://192.168.224.147:3000' > apps/android/.env  # gitignored
cd apps/android && npx expo start -c
```

Checklist: sync service running (`curl http://<lan-ip>:3000/v1/health`),
phone on the same Wi-Fi, and re-check the IP after reconnects (DHCP changes it).

## Notes
- Uses `expo-router` (history/pair/devices/settings), `expo-secure-store` (Keystore-backed keys/session), `expo-sqlite` (offline history), `expo-clipboard` (copy action).
- **Background clipboard monitoring is not supported** on modern Android; the app documents this and implements foreground refresh + WS live updates while open + offline queue.
- If native clipboard/background APIs beyond Expo are needed, add a small Expo config plugin / native module — only then, and keep it behind the same foreground UX.
- Test on at least two recent API levels; verify: fresh install, pairing + revoked pairing, foreground refresh, copy-to-clipboard, network loss recovery, SecureStore reset, unicode/multiline/long text.
