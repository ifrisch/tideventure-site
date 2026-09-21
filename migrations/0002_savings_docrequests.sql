-- TideVenture CPA — D1 schema additions for the Tax Savings Ledger and
-- document-request checklist. Same pattern as 0001: R2 stays authoritative,
-- these tables are the queryable mirror (dual-write + nightly self-heal).

CREATE TABLE IF NOT EXISTS savings_entries (
  id           TEXT PRIMARY KEY,
  client_email TEXT NOT NULL,
  amount       REAL NOT NULL,
  category     TEXT,
  description  TEXT,
  tax_year     INTEGER,
  entry_date   TEXT,
  created_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_savings_client ON savings_entries(client_email);

CREATE TABLE IF NOT EXISTS doc_requests (
  id           TEXT PRIMARY KEY,
  client_email TEXT NOT NULL,
  title        TEXT NOT NULL,
  note         TEXT,
  status       TEXT DEFAULT 'requested',  -- requested | submitted | received | waived
  requested_at TEXT,
  received_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_docreq_client ON doc_requests(client_email);
