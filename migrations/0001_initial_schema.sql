-- TideVenture CPA — D1 schema (Phase 0)
-- Full table set. This session wires up only the transient-token tables
-- (setup_tokens, reset_tokens, rate_limits); the rest are created now so
-- later migration phases (clients, prospects, messages, …) have their
-- destination ready. Creating an unused table costs nothing.

-- ── Transient auth data (pilot — migrated this session) ──
CREATE TABLE IF NOT EXISTS setup_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,   -- e.g. login:jane@x.com or reset:jane@x.com
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL    -- for cheap sweep of stale windows
);

-- ── Core relational data (destinations for later phases) ──
CREATE TABLE IF NOT EXISTS clients (
  email                  TEXT PRIMARY KEY,
  role                   TEXT DEFAULT 'client',
  business_name          TEXT,
  contact_name           TEXT,
  state                  TEXT,
  customer_type          TEXT,
  services               TEXT,   -- JSON array
  dashboard_cards        TEXT,   -- JSON array
  tax_statuses           TEXT,   -- JSON array
  monthly_price          REAL DEFAULT 0,
  yearly_price           REAL DEFAULT 0,
  status                 TEXT DEFAULT 'active',
  password_hash          TEXT,
  engagement_accepted_at TEXT,
  engagement_signature   TEXT,
  engagement_letter_hash TEXT,
  deactivated_at         TEXT,
  created_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

CREATE TABLE IF NOT EXISTS prospects (
  id               TEXT PRIMARY KEY,
  email            TEXT,
  name             TEXT,
  phone            TEXT,
  city             TEXT,
  state            TEXT,
  entity_type      TEXT,
  services         TEXT,
  cfo_services     TEXT,
  members          INTEGER,
  revenue          TEXT,
  notes            TEXT,
  source           TEXT,
  stage            TEXT DEFAULT 'new',
  status           TEXT DEFAULT 'new',
  viewed           INTEGER DEFAULT 0,
  created_at       TEXT,
  stage_updated_at TEXT,
  converted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  client_email   TEXT NOT NULL,
  sender         TEXT,
  sender_email   TEXT,
  body           TEXT,
  ts             TEXT,
  read_by_firm   INTEGER DEFAULT 0,
  read_by_client INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(client_email, ts);
CREATE INDEX IF NOT EXISTS idx_messages_unread_firm ON messages(client_email, read_by_firm);

CREATE TABLE IF NOT EXISTS documents (
  id           TEXT PRIMARY KEY,
  client_email TEXT NOT NULL,
  name         TEXT,
  source       TEXT,
  content_type TEXT,
  size         INTEGER,
  r2_key       TEXT NOT NULL,
  uploaded_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_client ON documents(client_email);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT,
  action      TEXT,
  actor_email TEXT,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS engagement_records (
  id            TEXT PRIMARY KEY,
  client_email  TEXT NOT NULL,
  signature     TEXT,
  consent_esign INTEGER,
  signed_at     TEXT,
  ip            TEXT,
  user_agent    TEXT,
  letter_hash   TEXT,
  letter_text   TEXT
);
CREATE INDEX IF NOT EXISTS idx_engagement_client ON engagement_records(client_email);

CREATE TABLE IF NOT EXISTS questionnaires (
  client_email TEXT NOT NULL,
  year         INTEGER NOT NULL,
  status       TEXT,
  completed_at TEXT,
  r2_key       TEXT,
  PRIMARY KEY (client_email, year)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
