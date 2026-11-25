import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Only data this platform owns. Cases, entitlements and usage stay in their systems of record. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_records (
  caller TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  upstream_key TEXT NOT NULL,              -- stable key sent upstream, so a retry after a crash cannot double-write
  state TEXT NOT NULL CHECK (state IN ('in_progress','completed')),
  status INTEGER, headers TEXT, body TEXT,
  dispatched INTEGER NOT NULL DEFAULT 0,   -- 1 once checks passed and the upstream call was about to be made
  locked_until INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (caller, operation, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_idem_expiry ON idempotency_records(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, agent TEXT, action TEXT NOT NULL,
  resource TEXT, outcome TEXT NOT NULL, correlation_id TEXT, detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit_log(kind, seq);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, seq);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append only'); END;

CREATE TABLE IF NOT EXISTS action_requests (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, case_id TEXT NOT NULL, customer_id TEXT NOT NULL, case_version INTEGER NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL, agent TEXT NOT NULL,
  decided_by TEXT, failure TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_owner ON action_requests(requested_by, status, created_at);
CREATE INDEX IF NOT EXISTS idx_action_status ON action_requests(status, created_at);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL,
  secret_enc BLOB NOT NULL,                -- AES-256-GCM
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_previous_secrets (  -- signs next to the new secret until it expires
  subscription_id TEXT PRIMARY KEY REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  secret_enc BLOB NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (  -- transactional outbox
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  body TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT,
  UNIQUE (event_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';

-- Reviewed identity crosswalk. Ids are never matched by padding or similarity (see DECISIONS.md).
CREATE TABLE IF NOT EXISTS account_aliases (
  source TEXT NOT NULL, source_id TEXT NOT NULL, customer_id TEXT NOT NULL, reviewed_by TEXT NOT NULL, note TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
) WITHOUT ROWID;
INSERT OR IGNORE INTO account_aliases VALUES
  ('entitlement_csv', 'ACC-77', 'ACC-007', 'data-steward', 'Mis-keyed export id; tier and renewal agree with the XML feed');

CREATE TABLE IF NOT EXISTS upstream_snapshots (  -- last known good, for degraded reads
  key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL
) WITHOUT ROWID;
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
