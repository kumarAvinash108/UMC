-- UCM sync service schema (PostgreSQL). MemoryStore is default for local dev;
-- apply this migration for hosted deployments.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linux','android')),
  public_key TEXT NOT NULL,
  capabilities TEXT[] NOT NULL DEFAULT '{}', -- e.g. '{wifi-lan,bluetooth}'
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_device_id UUID NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  ciphertext TEXT NOT NULL, -- opaque E2E ciphertext, never plaintext
  nonce TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_items_owner_created ON items(owner_id, created_at, id);
CREATE TABLE IF NOT EXISTS pairings (
  code_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_device_id UUID NOT NULL,
  requester_public_key TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  capabilities TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
