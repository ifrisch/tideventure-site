-- Pass-through entity tax worksheets. State only: a pass-through entity makes
-- no federal estimated income tax payments, so there is no federal column here
-- by design. R2 at taxentity/<email>/<year> remains the system of record.
CREATE TABLE IF NOT EXISTS entity_projections (
  id             TEXT PRIMARY KEY,      -- <email>:<year>
  entity_email   TEXT NOT NULL,
  tax_year       INTEGER NOT NULL,
  prior_year     INTEGER NOT NULL,
  entity_type    TEXT,
  state          TEXT,
  status         TEXT DEFAULT 'draft',
  pte_tax        REAL DEFAULT 0,
  remaining      REAL DEFAULT 0,
  quarterly      REAL DEFAULT 0,
  updated_at     TEXT,
  updated_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_entityproj_entity ON entity_projections(entity_email);

-- One row per owner per entity-year. This is the link between an entity's
-- payment and the PTE credit on an owner's individual return, so an owner's
-- worksheet can read its credit rather than having it typed in twice.
CREATE TABLE IF NOT EXISTS entity_owner_allocations (
  id             TEXT PRIMARY KEY,      -- <entity>:<year>:<owner>
  entity_email   TEXT NOT NULL,
  owner_email    TEXT NOT NULL,
  tax_year       INTEGER NOT NULL,
  owner_name     TEXT,
  ownership_pct  REAL DEFAULT 0,
  allocated_pte  REAL DEFAULT 0,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_alloc_owner ON entity_owner_allocations(owner_email, tax_year);
CREATE INDEX IF NOT EXISTS idx_alloc_entity ON entity_owner_allocations(entity_email, tax_year);
