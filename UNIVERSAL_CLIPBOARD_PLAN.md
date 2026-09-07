# Universal Clipboard Manager
## Cross-platform product and implementation plan

**Goal:** Build a private, reliable clipboard manager that synchronizes text and selected image/file content between two Linux distributions and an Android phone. The first release should be useful on a local network, while remaining ready for secure internet synchronization.

**Recommended first targets**

- **Linux desktop 1:** Ubuntu 24.04 LTS, GNOME, Wayland
- **Linux desktop 2:** Fedora Workstation, GNOME, Wayland
- **Linux compatibility:** X11 fallback where practical
- **Android:** Expo React Native using an Expo development build
- **Backend:** Small HTTPS/WebSocket service with encrypted clipboard payloads

---

## 1. Product definition

### Core user experience

1. A user copies text on Linux.
2. The Linux agent detects the clipboard change and encrypts it locally.
3. The encrypted item is synchronized to the user’s other trusted devices.
4. The Android app displays the item in history and lets the user copy it locally.
5. A user can search, pin, delete, and expire clipboard items.
6. The user can pause synchronization at any time.

### Initial scope

**Include in v1**

- Text clipboard synchronization
- Clipboard history with timestamps and source device
- Search and pinned items
- Device pairing and revocation
- End-to-end encryption
- Online/offline queueing
- Automatic expiry and history limits
- Linux tray/menu-bar controls
- Android history screen and copy action
- Clear privacy controls and sync status

**Defer until after v1**

- Rich HTML formatting
- Large files and arbitrary binary blobs
- OCR, translation, or AI features
- Public sharing links
- Browser extensions
- iOS support
- Multi-user workspaces

### Important platform constraint

Android limits background clipboard access, especially on newer Android versions. The Android app must not promise unrestricted background clipboard monitoring. The first Android release should reliably support foreground refresh, user-triggered sync, and copying from the app. Any background behavior must be implemented only where the OS and Expo development build permit it, with a visible explanation in the UI.

---

## 2. Recommended architecture

```text
Linux Clipboard Agent             Android Expo App
        |                                 |
        | encrypted WebSocket/HTTPS       |
        +------------ Sync API -----------+
                         |
              Encrypted storage/relay
```

### Components

**A. Linux agent**

- Rust desktop service for clipboard monitoring, encryption, local cache, and sync.
- GTK/libadwaita settings and history UI, or a lightweight tray client connected to the service.
- Wayland support through a desktop-environment-compatible clipboard portal/helper.
- X11 support through an X11 clipboard backend.
- Runs as a per-user `systemd --user` service.

Rust is a good fit for a small secure background service with predictable memory use and easy distribution. Keep the clipboard backend behind an interface so Wayland, X11, and future desktop environments do not leak into sync logic.

**B. Android app**

- Expo-managed React Native project.
- Expo Router for navigation.
- Expo SecureStore for device keys and session material.
- Expo SQLite for local history and offline queue.
- Expo Notifications only if notifications are later needed.
- Expo development build rather than Expo Go once native clipboard/background behavior is required.
- A small native Expo module or config plugin may be added only when Android clipboard APIs cannot be handled by existing Expo APIs.

**C. Sync service**

- Stateless HTTP API for authentication, device registration, history metadata, and encrypted payload delivery.
- WebSocket channel for near-real-time delivery while devices are connected.
- PostgreSQL for accounts, devices, item metadata, and encrypted payloads.
- Redis or an in-process connection registry can be added for WebSocket fan-out when needed.
- Object storage is optional and should only be introduced for large encrypted attachments.

The server should never receive plaintext clipboard contents or encryption keys.

---

## 3. Security model

### Encryption

Use authenticated end-to-end encryption for every clipboard payload. The client encrypts before upload and decrypts only on trusted devices.

- Generate a device key pair on first launch.
- Store private keys in the Linux secret service/keyring and Android Keystore-backed secure storage.
- Use a modern audited cryptographic library rather than implementing cryptography manually.
- Bind ciphertext to item metadata with authenticated additional data so timestamps, item IDs, and device IDs cannot be silently swapped.
- Encrypt locally stored history as well as data in transit.
- Use TLS for all network traffic, even though payloads are already end-to-end encrypted.

### Trust and pairing

1. The first device creates the account or local identity.
2. A second device requests pairing.
3. The user confirms using a short code or QR code.
4. Devices exchange public keys and receive scoped access credentials.
5. The user can view, rename, pause, or revoke any device.

### Clipboard privacy controls

- Global pause switch.
- Per-device sync enable/disable.
- Auto-delete after a selectable period: 1 hour, 1 day, 7 days, or never.
- Maximum history count and maximum item size.
- Never sync items matching configurable sensitive-app rules where detectable.
- Do not log clipboard plaintext, keys, tokens, or decrypted payloads.
- Show a first-run warning that clipboard contents may include passwords and secrets.

---

## 4. Data model and API foundation

### Core entities

**User**

- `id`
- `created_at`
- account/authentication metadata only

**Device**

- `id`
- `user_id`
- `name`
- `platform`
- `public_key`
- `last_seen_at`
- `revoked_at`

**ClipboardItem**

- `id`
- `owner_id`
- `source_device_id`
- `content_type`
- `ciphertext`
- `nonce`
- `metadata`
- `created_at`
- `expires_at`
- `deleted_at`

The server may store safe metadata needed for routing and retention, but it must not store plaintext content.

### Initial API surface

- `POST /v1/auth/session`
- `POST /v1/devices`
- `GET /v1/devices`
- `POST /v1/devices/{id}/revoke`
- `POST /v1/pairing/request`
- `POST /v1/pairing/confirm`
- `GET /v1/items?cursor=...`
- `POST /v1/items`
- `DELETE /v1/items/{id}`
- `POST /v1/items/{id}/ack`
- `GET /v1/events` or WebSocket `/v1/sync`

Design all list endpoints with cursor pagination, since clipboard history can grow quickly.

---

## 5. Step-by-step delivery plan

### Phase 0: Confirm decisions and constraints

1. Confirm the first Linux distributions: Ubuntu 24.04 and Fedora Workstation.
2. Decide whether the first deployment is cloud-hosted, self-hosted, or local-network-only.
3. Confirm the first content type is text only.
4. Define retention defaults and maximum clipboard size.
5. Create a threat model covering lost phones, compromised servers, revoked devices, and accidental secret copying.
6. Write the v1 acceptance criteria before implementation begins.

**Exit condition:** The team can state exactly what is synchronized, where plaintext exists, and what Android is allowed to do in the background.

### Phase 1: Repository and developer foundations

1. Create a monorepo with separate packages:
   - `apps/android`
   - `apps/linux`
   - `services/sync`
   - `packages/protocol`
   - `docs`
2. Add formatting, linting, type checking, Rust checks, and commit hooks.
3. Add environment templates without committing secrets.
4. Add local development services using Docker Compose for PostgreSQL and the sync service.
5. Define versioned protocol types shared by clients and server.
6. Add CI jobs for Android TypeScript checks, Rust checks, API tests, and security scanning.

**Exit condition:** A clean checkout can run the sync service and validate all packages with one documented command.

### Phase 2: Build the sync service without plaintext

1. Implement device registration and authenticated sessions.
2. Implement device listing, naming, and revocation.
3. Implement encrypted item upload, cursor pagination, acknowledgement, deletion, and expiry.
4. Add WebSocket delivery for connected devices.
5. Enforce item size, rate, retention, and pagination limits server-side.
6. Add migrations and integration tests against PostgreSQL.
7. Verify through tests that the server cannot decrypt submitted content.

**Exit condition:** A test client can upload ciphertext and deliver it to another authorized device without exposing plaintext to the service.

### Phase 3: Linux clipboard agent

1. Define a `ClipboardProvider` interface with `read`, `write`, and `watch` operations.
2. Implement the Wayland provider used by Ubuntu GNOME and Fedora GNOME.
3. Implement an X11 provider as a fallback.
4. Add local encrypted SQLite history and an offline upload queue.
5. Add device identity and secure key storage using the Linux secret service.
6. Add sync state, retries with backoff, and conflict-safe item IDs.
7. Register a per-user `systemd --user` service.
8. Add a small settings window with:
   - sync toggle
   - device name
   - retention settings
   - history limit
   - pairing flow
   - device management
9. Package and test `.deb` and `.rpm` artifacts.

**Exit condition:** Copying text on both Ubuntu and Fedora creates one local item and, when enabled, delivers it to a paired device. Clipboard loops are prevented by tagging items with their origin.

### Phase 4: Expo Android application

1. Create the Expo app with TypeScript and Expo Router.
2. Build screens for onboarding, pairing, clipboard history, search, item detail, settings, and devices.
3. Store local history and pending operations in Expo SQLite.
4. Store credentials and private key material with Expo SecureStore and Android Keystore-backed storage.
5. Implement foreground sync and a clear sync-status indicator.
6. Add copy-to-Android-clipboard for selected history items.
7. Add pull-to-refresh, offline mode, retry states, empty states, and error recovery.
8. Create an Expo development build for any required native clipboard capability.
9. Test Android lifecycle behavior on recent Android versions and document background limitations in the product behavior, not as a hidden failure.

**Exit condition:** A paired Android phone can receive encrypted history, search it offline, copy an item to the phone clipboard, and recover after network loss.

### Phase 5: Pairing and end-to-end workflow

1. Implement QR or short-code pairing between Linux and Android.
2. Show the device fingerprint on both sides before trust is finalized.
3. Test first-device setup, second-device setup, revoked-device behavior, and re-pairing.
4. Test simultaneous copies from multiple devices.
5. Add deletion propagation and expiry propagation.
6. Add pause/resume behavior without losing queued items unexpectedly.
7. Add protection against duplicate delivery and clipboard feedback loops.

**Exit condition:** A user can install all three clients, pair them without editing configuration files, and understand the trust state at every step.

### Phase 6: Quality, privacy, and release packaging

1. Test Ubuntu Wayland, Fedora Wayland, Ubuntu/Fedora X11 where available, and at least two current Android API levels.
2. Test offline startup, reconnect, sleep/wake, logout/login, and service restart.
3. Run property-based tests for protocol parsing and item ordering.
4. Run dependency, secret, and static security scans.
5. Verify logs contain no clipboard plaintext.
6. Build signed Android artifacts and reproducible Linux packages.
7. Write installation, upgrade, backup, troubleshooting, and privacy documentation.
8. Provide a reset flow that removes local keys and history deliberately.

**Exit condition:** Release candidates pass the acceptance checklist below and can be installed by a new user without developer tools.

---

## 6. Testing strategy

### Unit tests

- Encryption/decryption and tamper detection
- Item expiry and retention rules
- Cursor pagination
- Retry and backoff behavior
- Clipboard loop prevention
- Pairing state transitions
- Protocol serialization compatibility

### Integration tests

- Client-to-service authentication
- Upload, delivery, acknowledgement, deletion, and expiry
- Device revocation
- Offline queue replay
- WebSocket reconnect
- PostgreSQL migrations

### Desktop tests

- Ubuntu 24.04 GNOME Wayland
- Fedora Workstation GNOME Wayland
- X11 fallback
- Service starts after login
- Copy and paste with common applications
- Secret-service unavailable behavior

### Android tests

- Fresh install and upgrade
- Pairing and revoked pairing
- Foreground refresh
- Copying an item to the local clipboard
- Android lifecycle and network loss
- Secure storage reset
- Small, long, Unicode, and multiline text

### Acceptance scenarios

1. Text copied on Ubuntu appears on Android.
2. Text copied on Fedora appears on Ubuntu.
3. Android can copy a selected item back to Linux when the user triggers the action.
4. Offline copies synchronize after reconnection in the expected order.
5. Revoked devices stop receiving new items.
6. Expired items disappear from every device.
7. The server database contains ciphertext rather than readable clipboard text.
8. No clipboard content appears in application logs.
9. Disabling sync stops new uploads while preserving the local history according to the user’s setting.

---

## 7. Release milestones

### Milestone 1: Local desktop prototype

- Linux clipboard capture and local encrypted history
- Ubuntu and Fedora Wayland support
- Basic settings and pause control

### Milestone 2: Secure service prototype

- Device identity
- Encrypted upload and download
- PostgreSQL persistence
- Basic WebSocket delivery

### Milestone 3: Android prototype

- Expo app shell
- Pairing
- History display
- Copy-to-Android action
- Foreground synchronization

### Milestone 4: Private beta

- Full retention and deletion controls
- Device revocation
- Offline queues
- Linux packages
- Android development build and signed test build

### Milestone 5: v1 release

- Ubuntu and Fedora support matrix
- Security review of the protocol and key handling
- Upgrade and recovery documentation
- Monitoring, backups, and incident response for the sync service

---

## 8. Suggested project structure

```text
universal-clipboard/
├── apps/
│   ├── android/              # Expo React Native app
│   └── linux/                # Rust agent and desktop UI
├── services/
│   └── sync/                 # HTTPS/WebSocket sync service
├── packages/
│   └── protocol/             # Versioned schemas and shared API types
├── infra/                    # Local Docker and deployment configuration
├── docs/
│   ├── threat-model.md
│   ├── protocol.md
│   ├── linux-install.md
│   └── android-build.md
├── docker-compose.yml
└── README.md
```

---

## 9. Decisions to make before coding

- Will the sync service be self-hosted, hosted by the project, or both?
- Is an account required, or should local-network pairing work without an account?
- Should image support follow immediately after text, or remain out of v1?
- Which Android API levels must be supported?
- Should history be shared across all devices or filtered per device?
- What is the default expiry period for potentially sensitive clipboard contents?
- Is a GTK/libadwaita desktop settings window sufficient, or is a full history window required on Linux?

**Recommended defaults:** self-hostable service, account-based device management, text-only v1, current Android versions plus one older supported version, 7-day default expiry, and a focused Linux settings/history window.

---

## Definition of done

The first release is complete when a new user can install the Linux client on Ubuntu and Fedora, install the Expo-based Android app, pair the devices with an explicit trust confirmation, synchronize text clipboard history end to end, search and copy items, work offline, revoke a device, and verify through documentation that the server never receives clipboard plaintext.
