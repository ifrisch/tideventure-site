-- Estimated tax projection worksheets. R2 stays the system of record
-- (taxproj/<email>/<year>); this mirrors them so the admin side can list and
-- filter without scanning the bucket, matching the pattern used by the other
-- mirrored entities.
CREATE TABLE IF NOT EXISTS tax_projections (
  id             TEXT PRIMARY KEY,      -- <email>:<year>
  client_email   TEXT NOT NULL,
  tax_year       INTEGER NOT NULL,
  prior_year     INTEGER NOT NULL,
  filing_status  TEXT NOT NULL,
  status         TEXT DEFAULT 'draft',  -- draft | reviewed. Nothing leaves draft without the CPA saying so.
  total_tax      REAL DEFAULT 0,
  balance_due    REAL DEFAULT 0,
  quarterly      REAL DEFAULT 0,
  safe_harbor    REAL DEFAULT 0,
  updated_at     TEXT,
  updated_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_taxproj_client ON tax_projections(client_email);
CREATE INDEX IF NOT EXISTS idx_taxproj_year ON tax_projections(tax_year);
