import { SignJWT, jwtVerify } from 'jose';
import { LINES, GROUPS, FILING_STATUSES, isValidFilingStatus, computeWorksheet, TAXRULE_KEYS, SECTIONS } from './taxworksheet.js';
import { K1_LINES, K1_LINE_BY_KEY } from './taxk1.js';
import { STATES, PAID_BY, STATE_LINES, computeStateWorksheet } from './taxstate.js';
import { ENTITY_TYPES, ENTITY_STATES, ENTITY_LINES, computeEntityWorksheet } from './taxentity.js';

const SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  // Allowances beyond 'self', each for a resource the pages actually load:
  // Google Fonts (stylesheet from fonts.googleapis.com, font files from
  // fonts.gstatic.com), the Turnstile challenge widget, and the Cloudflare
  // Web Analytics beacon. Without the font entries the pages silently fall
  // back to system fonts; without the analytics entries no traffic is recorded.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com; frame-ancestors 'none'; object-src 'none'",
};

function withSecurity(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SEC_HEADERS)) r.headers.set(k, v);
  return r;
}

// A well-formed <salt>:<hash> that no password matches. Login runs a full
// verify against this for unknown emails so timing doesn't reveal existence.
const DUMMY_PW_HASH = '0'.repeat(32) + ':' + '0'.repeat(64);

// Normalize + strictly validate an email before it is used as an R2 key
// component. Rejects '/', backslashes, consecutive dots, and over-long input so a
// crafted address can't reshape a key's logical prefix. Returns null if invalid.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || e.includes('..') || e.includes('/') || e.includes('\\')) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) return null;
  return e;
}

// Return the URL only if it is http/https, else '' — used to keep hostile feed
// URLs (e.g. javascript:) out of rendered hrefs.
function safeHttpUrl(u) {
  try { const p = new URL(u); return (p.protocol === 'http:' || p.protocol === 'https:') ? u : ''; }
  catch { return ''; }
}

export default {
  async fetch(request, env) {
    return withSecurity(await handleFetch(request, env));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyJobs(env));
  },
};

// Runs the nightly maintenance jobs sequentially, each isolated so one failure
// can't silently abort the others (the old code fired both in parallel under a
// shared subrequest budget and swallowed all errors). Order matters: back up
// BEFORE pruning, so anything pruned from the hot bucket already exists in the
// backup bucket.
async function runNightlyJobs(env) {
  try { await fetchRegulatoryUpdates(env); }
  catch (e) { await logAudit(env, 'ERROR', 'system', `Regulatory fetch failed: ${String(e.message).slice(0, 160)}`).catch(() => {}); }

  try { await runBackup(env); }
  catch (e) {
    // Make a broken backup VISIBLE — record the failure into the status object
    // the admin panel reads, instead of leaving a stale "healthy" timestamp.
    try {
      await env.tideventure_documents.put('settings/backup-state.json', JSON.stringify({
        lastRun: new Date().toISOString(), error: String(e.message).slice(0, 200), failed: true,
      }), { httpMetadata: { contentType: 'application/json' } });
    } catch {}
    await logAudit(env, 'ERROR', 'system', `Backup failed: ${String(e.message).slice(0, 160)}`).catch(() => {});
  }

  try { await pruneAuditLog(env); }
  catch (e) { await logAudit(env, 'ERROR', 'system', `Audit prune failed: ${String(e.message).slice(0, 160)}`).catch(() => {}); }

  try { await pruneD1Transients(env); }
  catch (e) { await logAudit(env, 'ERROR', 'system', `D1 transient prune failed: ${String(e.message).slice(0, 160)}`).catch(() => {}); }

  // Refresh QBO tokens (keep-alive) and cache each connected client's financials
  // so portals load instantly and admin balances are populated.
  try { const r = await runQboSync(env); await logAudit(env, 'SYNC', 'system', `QBO sync: ${r.synced} synced, ${r.reconnect} need reconnect`).catch(() => {}); }
  catch (e) { await logAudit(env, 'ERROR', 'system', `QBO sync failed: ${String(e.message).slice(0, 160)}`).catch(() => {}); }

  // Self-heal: idempotently re-sync core entities R2 → D1 so any missed
  // dual-write converges within 24h. Excludes audit (append-only).
  try { await backfillAllToD1(env); }
  catch (e) { await logAudit(env, 'ERROR', 'system', `D1 resync failed: ${String(e.message).slice(0, 160)}`).catch(() => {}); }
}

// Paginated R2 list. A bare bucket.list() returns at most 1000 keys and
// silently truncates; every list in this file goes through here instead.
// Returns { objects } so it's a drop-in for the previous list() result shape.
async function listAll(bucket, options = {}) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ ...options, cursor, limit: 1000 });
    for (const o of page.objects) objects.push(o);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects };
}

// Single source of the JWT signing key. JWT_SECRET is mandatory: if it were
// allowed to fall back to DOC_ENC_KEY, one leaked secret would let an attacker
// forge admin tokens AND decrypt every document. Fail closed if it's missing.
function jwtKey(env) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return new TextEncoder().encode(env.JWT_SECRET);
}

// ── D1 migration: transient tokens (pilot phase) ──
// These helpers DUAL-WRITE to D1 and R2 and READ D1-first-then-R2. That makes
// the migration reversible: D1 is authoritative for new records, R2 remains a
// live fallback (so any in-flight token issued before this deploy still works),
// and if env.DB is ever unavailable every call degrades to plain R2. Every D1
// call is wrapped so a D1 error can never take down auth.

async function setupTokenPut(env, token, email) {
  const now = Date.now();
  await env.tideventure_documents.put(`setup/${token}`, JSON.stringify({ email, createdAt: now }),
    { httpMetadata: { contentType: 'application/json' }, customMetadata: { expiresAt: now + 86400000 } });
  try { await env.DB.prepare('INSERT OR REPLACE INTO setup_tokens (token,email,created_at,expires_at) VALUES (?,?,?,?)').bind(token, email, now, now + 86400000).run(); } catch {}
}
async function setupTokenRead(env, token) {
  try {
    const row = await env.DB.prepare('SELECT email, created_at FROM setup_tokens WHERE token = ?').bind(token).first();
    if (row) return { email: row.email, createdAt: row.created_at };
  } catch {}
  const obj = await env.tideventure_documents.get(`setup/${token}`);
  if (obj) { try { return JSON.parse(await obj.text()); } catch {} }
  return null;
}
async function setupTokenDelete(env, token) {
  await env.tideventure_documents.delete(`setup/${token}`).catch(() => {});
  try { await env.DB.prepare('DELETE FROM setup_tokens WHERE token = ?').bind(token).run(); } catch {}
}

async function resetTokenPut(env, token, email) {
  const now = Date.now();
  await env.tideventure_documents.put(`reset/${token}`, JSON.stringify({ email, createdAt: now }), { httpMetadata: { contentType: 'application/json' } });
  try { await env.DB.prepare('INSERT OR REPLACE INTO reset_tokens (token,email,created_at,expires_at) VALUES (?,?,?,?)').bind(token, email, now, now + 3600000).run(); } catch {}
}
async function resetTokenRead(env, token) {
  try {
    const row = await env.DB.prepare('SELECT email, created_at FROM reset_tokens WHERE token = ?').bind(token).first();
    if (row) return { email: row.email, createdAt: row.created_at };
  } catch {}
  const obj = await env.tideventure_documents.get(`reset/${token}`);
  if (obj) { try { return JSON.parse(await obj.text()); } catch {} }
  return null;
}
async function resetTokenDelete(env, token) {
  await env.tideventure_documents.delete(`reset/${token}`).catch(() => {});
  try { await env.DB.prepare('DELETE FROM reset_tokens WHERE token = ?').bind(token).run(); } catch {}
}

// Rate limits. `key` is the part after ratelimit/, e.g. `login/jane@x.com`.
async function rateGet(env, key) {
  try {
    const row = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
    if (row) return { count: row.count, windowStart: row.window_start };
  } catch {}
  const obj = await env.tideventure_documents.get(`ratelimit/${key}`);
  if (obj) { try { const d = JSON.parse(await obj.text()); return { count: d.count || 0, windowStart: d.windowStart || d.first || 0 }; } catch {} }
  return null;
}
async function ratePut(env, key, count, windowStart, ttlMs) {
  await env.tideventure_documents.put(`ratelimit/${key}`, JSON.stringify({ count, windowStart }), { httpMetadata: { contentType: 'application/json' } });
  try { await env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key,count,window_start,expires_at) VALUES (?,?,?,?)').bind(key, count, windowStart, Date.now() + ttlMs).run(); } catch {}
}
async function rateDelete(env, key) {
  await env.tideventure_documents.delete(`ratelimit/${key}`).catch(() => {});
  try { await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run(); } catch {}
}

// Nightly sweep of expired transients from D1 (R2 copies expire naturally via
// the callers' age checks; this keeps the D1 tables lean). Fixes the old
// "expired tokens accumulate forever" issue for these entities.
async function pruneD1Transients(env) {
  const now = Date.now();
  try {
    await env.DB.prepare('DELETE FROM setup_tokens WHERE expires_at < ?').bind(now).run();
    await env.DB.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').bind(now).run();
    await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
  } catch {}
}

// ── D1 migration: core entities (dual-write + backfill) ──
// Aggregate/admin reads are D1-backed by DEFAULT; set D1_READS='off' to revert
// them to R2 (the guard is `env.D1_READS !== 'off'`). R2 stays authoritative and
// is the fallback on any D1 error. Every sync is wrapped so a D1 failure can
// never break a write.

// Merge the authoritative user/ + profile/ records into the single clients row.
// This is where the user/profile drift dies: one row, one truth.
async function syncClientToD1(env, email) {
  try {
    if (!email) return;
    let u = {}, p = {};
    const uo = await env.tideventure_documents.get(`user/${email}`);
    if (uo) { try { u = JSON.parse(await uo.text()); } catch {} }
    const po = await env.tideventure_documents.get(`profile/${email}`);
    if (po) { try { p = JSON.parse(await po.text()); } catch {} }
    if (!uo && !po) return;
    await env.DB.prepare(`INSERT OR REPLACE INTO clients
      (email,role,business_name,contact_name,state,customer_type,services,dashboard_cards,tax_statuses,monthly_price,yearly_price,status,password_hash,engagement_accepted_at,engagement_signature,engagement_letter_hash,deactivated_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      email,
      u.role || 'client',
      u.businessName || p.businessName || null,
      u.contactName || null,
      u.state || p.state || null,
      u.customerType || p.customerType || null,
      JSON.stringify(u.services || p.services || []),
      Array.isArray(u.dashboardCards) ? JSON.stringify(u.dashboardCards) : (Array.isArray(p.dashboardCards) ? JSON.stringify(p.dashboardCards) : null),
      Array.isArray(u.taxStatuses) ? JSON.stringify(u.taxStatuses) : null,
      u.monthlyPrice ?? p.monthlyPrice ?? 0,
      u.yearlyPrice ?? p.yearlyPrice ?? 0,
      u.status || p.status || 'active',
      u.password || null,
      u.engagementAcceptedAt || null,
      u.engagementSignature || null,
      u.engagementLetterHash || null,
      u.deactivatedAt || null,
      u.createdAt || null,
    ).run();
  } catch {}
}
// Turn a clients row back into the merged shape the app code expects.
function rowToClient(r) {
  return {
    email: r.email, role: r.role, businessName: r.business_name, contactName: r.contact_name,
    state: r.state, customerType: r.customer_type,
    services: r.services ? JSON.parse(r.services) : [],
    dashboardCards: r.dashboard_cards ? JSON.parse(r.dashboard_cards) : null,
    taxStatuses: r.tax_statuses ? JSON.parse(r.tax_statuses) : [],
    monthlyPrice: r.monthly_price, yearlyPrice: r.yearly_price, status: r.status,
    password: r.password_hash, engagementAcceptedAt: r.engagement_accepted_at,
    engagementSignature: r.engagement_signature, engagementLetterHash: r.engagement_letter_hash,
    deactivatedAt: r.deactivated_at, createdAt: r.created_at,
  };
}

async function syncProspectToD1(env, p) {
  try {
    if (!p || !p.id) return;
    await env.DB.prepare(`INSERT OR REPLACE INTO prospects
      (id,email,name,business_name,phone,city,state,entity_type,services,cfo_services,members,revenue,notes,source,verified,stage,status,viewed,created_at,stage_updated_at,converted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      p.id, p.email || null, p.name || null, p.businessName || null, p.phone || null, p.city || null, p.state || null,
      p.entityType || null, JSON.stringify(p.services || []), JSON.stringify(p.cfoServices || []),
      p.members || 1, p.revenue || null, p.notes || null, p.source || null, p.verified ? 1 : 0,
      p.stage || 'new', p.status || 'new', p.viewed ? 1 : 0,
      p.createdAt || null, p.stageUpdatedAt || null, p.convertedAt || null,
    ).run();
  } catch {}
}
function rowToProspect(r) {
  return {
    id: r.id, email: r.email, name: r.name, businessName: r.business_name, phone: r.phone, city: r.city, state: r.state,
    entityType: r.entity_type, services: r.services ? JSON.parse(r.services) : [],
    cfoServices: r.cfo_services ? JSON.parse(r.cfo_services) : [], members: r.members,
    revenue: r.revenue, notes: r.notes, source: r.source, verified: !!r.verified, stage: r.stage, status: r.status,
    viewed: !!r.viewed, createdAt: r.created_at, stageUpdatedAt: r.stage_updated_at, convertedAt: r.converted_at,
  };
}

async function syncTaxProjectionToD1(env, r, computed) {
  try {
    await env.DB.prepare(`INSERT OR REPLACE INTO tax_projections
      (id,client_email,tax_year,prior_year,filing_status,status,total_tax,balance_due,quarterly,safe_harbor,updated_at,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `${r.email}:${r.year}`, r.email, r.year, r.priorYear, r.filingStatus, r.status,
      computed?.totals?.baseline?.totalTax || 0, computed?.totals?.baseline?.balanceDue || 0,
      computed?.projected?.quarterly || 0, computed?.safeHarbor?.annual || 0,
      r.updatedAt || null, r.updatedBy || null,
    ).run();
  } catch {}
}

async function syncEntityProjectionToD1(env, r, computed) {
  try {
    await env.DB.prepare(`INSERT OR REPLACE INTO entity_projections
      (id,entity_email,tax_year,prior_year,entity_type,state,status,pte_tax,remaining,quarterly,updated_at,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      `${r.email}:${r.year}`, r.email, r.year, r.priorYear, r.entityType, r.state, r.status,
      computed?.pteTax || 0, computed?.remaining || 0, computed?.quarterly || 0,
      r.updatedAt || null, r.updatedBy || null,
    ).run();
    // Replace this entity-year's allocations wholesale: an owner removed from
    // the roster must not keep a stale credit waiting on their return.
    await env.DB.prepare('DELETE FROM entity_owner_allocations WHERE entity_email = ? AND tax_year = ?')
      .bind(r.email, r.year).run();
    for (const a of (computed?.allocations || [])) {
      if (!a.email) continue;
      await env.DB.prepare(`INSERT OR REPLACE INTO entity_owner_allocations
        (id,entity_email,owner_email,tax_year,owner_name,ownership_pct,allocated_pte,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(
        `${r.email}:${r.year}:${a.email}`, r.email, a.email, r.year, a.name || null,
        a.ownershipPercent || 0, a.allocated || 0, r.updatedAt || null,
      ).run();
    }
  } catch {}
}

async function insertAuditD1(env, entry) {
  try {
    await env.DB.prepare('INSERT INTO audit_log (ts,action,actor_email,detail) VALUES (?,?,?,?)')
      .bind(entry.timestamp, entry.action, entry.email, entry.detail).run();
  } catch {}
}
async function insertEngagementD1(env, r) {
  try {
    await env.DB.prepare(`INSERT OR REPLACE INTO engagement_records (id,client_email,signature,consent_esign,signed_at,ip,user_agent,letter_hash,letter_text) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(r.id || crypto.randomUUID(), r.email, r.signature, r.consentEsign ? 1 : 0, r.signedAt, r.ip || null, r.userAgent || null, r.letterHash || null, r.letterText || null).run();
  } catch {}
}
async function insertSavingsD1(env, s) {
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO savings_entries (id,client_email,amount,category,description,tax_year,entry_date,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(s.id, s.clientEmail, s.amount, s.category || null, s.description || null, s.taxYear || null, s.entryDate || null, s.createdAt || null).run();
  } catch {}
}
async function insertDocRequestD1(env, r) {
  try {
    await env.DB.prepare('INSERT OR REPLACE INTO doc_requests (id,client_email,title,note,status,requested_at,received_at) VALUES (?,?,?,?,?,?,?)')
      .bind(r.id, r.clientEmail, r.title, r.note || null, r.status || 'requested', r.requestedAt || null, r.receivedAt || null).run();
  } catch {}
}

// Backfill / re-sync R2 → D1. clients, prospects, messages, engagement all use
// INSERT OR REPLACE so this is idempotent and safe to re-run (the nightly cron
// calls it to self-heal any missed dual-write). audit_log is append-only, so it
// is ONLY copied when includeAudit is true — i.e. the one-time initial backfill,
// never the nightly re-sync (which would duplicate rows).
async function backfillAllToD1(env, opts = {}) {
  const { objects } = await listAll(env.tideventure_documents);
  const emails = new Set();
  const prospectIds = new Set();
  const savingsIds = new Set();
  const docreqIds = new Set();
  let prospects = 0, messages = 0, audit = 0, engagement = 0, savings = 0, docreqs = 0, pruned = 0;
  for (const o of objects) {
    try {
      if (o.key.startsWith('user/')) emails.add(o.key.slice(5));
      else if (o.key.startsWith('profile/')) emails.add(o.key.slice(8));
      else if (o.key.startsWith('prospect/')) {
        const p = JSON.parse(await (await env.tideventure_documents.get(o.key)).text());
        await syncProspectToD1(env, p); prospects++;
        if (p.id) prospectIds.add(p.id);
      } else if (o.key.startsWith('audit/') && opts.includeAudit) {
        const e = JSON.parse(await (await env.tideventure_documents.get(o.key)).text());
        await insertAuditD1(env, e); audit++;
      } else if (o.key.startsWith('engagement/')) {
        const r = JSON.parse(await (await env.tideventure_documents.get(o.key)).text());
        await insertEngagementD1(env, r); engagement++;
      } else if (o.key.startsWith('savings/')) {
        const s = JSON.parse(await (await env.tideventure_documents.get(o.key)).text());
        await insertSavingsD1(env, s); savings++;
        if (s.id) savingsIds.add(s.id);
      } else if (o.key.startsWith('docrequest/')) {
        const r = JSON.parse(await (await env.tideventure_documents.get(o.key)).text());
        await insertDocRequestD1(env, r); docreqs++;
        if (r.id) docreqIds.add(r.id);
      }
    } catch {}
  }
  for (const email of emails) await syncClientToD1(env, email);
  // Reconcile deletions: because dual-write is upsert-only, a row whose R2
  // source is gone would otherwise linger in D1 forever (and, since reads are
  // D1-backed, keep surfacing in admin lists/KPIs). Prune clients/prospects
  // whose R2 object no longer exists. Guarded on a non-empty listing so a
  // failed/empty list can never wipe the mirror (the bucket is never truly
  // empty — admin user, settings, etc. always exist).
  if (objects.length > 0) {
    try {
      const d1Emails = (await env.DB.prepare('SELECT email FROM clients').all()).results.map(r => r.email);
      for (const e of d1Emails) { if (e && !emails.has(e)) { await env.DB.prepare('DELETE FROM clients WHERE email = ?').bind(e).run(); pruned++; } }
      const d1Pids = (await env.DB.prepare('SELECT id FROM prospects').all()).results.map(r => r.id);
      for (const id of d1Pids) { if (id && !prospectIds.has(id)) { await env.DB.prepare('DELETE FROM prospects WHERE id = ?').bind(id).run(); pruned++; } }
      const d1Sids = (await env.DB.prepare('SELECT id FROM savings_entries').all()).results.map(r => r.id);
      for (const id of d1Sids) { if (id && !savingsIds.has(id)) { await env.DB.prepare('DELETE FROM savings_entries WHERE id = ?').bind(id).run(); pruned++; } }
      const d1Dids = (await env.DB.prepare('SELECT id FROM doc_requests').all()).results.map(r => r.id);
      for (const id of d1Dids) { if (id && !docreqIds.has(id)) { await env.DB.prepare('DELETE FROM doc_requests WHERE id = ?').bind(id).run(); pruned++; } }
    } catch {}
  }
  // Verify: D1 row counts
  // Literal per-table queries (no identifier interpolation) — preserves the
  // invariant that every D1 statement is parameterized or fully literal.
  const COUNT_SQL = {
    clients: 'SELECT COUNT(*) c FROM clients', prospects: 'SELECT COUNT(*) c FROM prospects',
    messages: 'SELECT COUNT(*) c FROM messages', audit_log: 'SELECT COUNT(*) c FROM audit_log',
    engagement_records: 'SELECT COUNT(*) c FROM engagement_records',
    savings_entries: 'SELECT COUNT(*) c FROM savings_entries', doc_requests: 'SELECT COUNT(*) c FROM doc_requests',
  };
  const q = async (t) => { try { return (await env.DB.prepare(COUNT_SQL[t]).first()).c; } catch { return -1; } };
  return {
    sourced: { clients: emails.size, prospects, messages, audit, engagement, savings, docreqs }, pruned,
    d1Counts: { clients: await q('clients'), prospects: await q('prospects'), messages: await q('messages'), audit_log: await q('audit_log'), engagement_records: await q('engagement_records'), savings_entries: await q('savings_entries'), doc_requests: await q('doc_requests') },
  };
}

// Prune audit-log objects older than the retention window. Keys are
// `audit/<ms-timestamp>-<uuid>`, so the timestamp is cheap to parse. Backups run
// before this, so pruned entries are preserved in the backup bucket.
const AUDIT_RETENTION_MS = 550 * 24 * 60 * 60 * 1000; // ~18 months
async function pruneAuditLog(env) {
  const cutoff = Date.now() - AUDIT_RETENTION_MS;
  const { objects } = await listAll(env.tideventure_documents, { prefix: 'audit/' });
  let pruned = 0;
  for (const o of objects) {
    const ts = parseInt(o.key.slice('audit/'.length), 10);
    if (Number.isFinite(ts) && ts < cutoff) {
      await env.tideventure_documents.delete(o.key).catch(() => {});
      pruned++;
    }
  }
  return { pruned };
}

// ── Nightly incremental backup: tideventure-documents → tideventure-backups ──
// Copies objects that are missing from the backup bucket or newer in the source.
// Never deletes from the backup, so accidental deletions remain recoverable.
// Batched to stay within per-invocation subrequest limits; a large backlog
// catches up over successive runs.
const BACKUP_BATCH_LIMIT = 900;
// Ephemeral / worthless-to-back-up prefixes. Skipping them keeps the nightly
// budget focused on real client data (documents, records, signatures) instead
// of being starved by transient counters and OAuth state.
const BACKUP_SKIP_PREFIXES = ['ratelimit/', 'reset/', 'setup/', 'gmail/oauth/', 'qbo/oauth/', 'qbo/snapshot/'];
async function runBackup(env) {
  if (!env.tideventure_backups) return { error: 'Backup bucket not bound' };
  const started = new Date().toISOString();
  // Build map of what the backup already has
  const existing = new Map();
  let cursor;
  do {
    const page = await env.tideventure_backups.list({ cursor, limit: 1000 });
    for (const o of page.objects) existing.set(o.key, new Date(o.uploaded).getTime());
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  let copied = 0, skipped = 0, failed = 0, pending = 0;
  cursor = undefined;
  do {
    const page = await env.tideventure_documents.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      if (BACKUP_SKIP_PREFIXES.some(p => o.key.startsWith(p))) { skipped++; continue; }
      const backedUp = existing.get(o.key);
      if (backedUp !== undefined && backedUp >= new Date(o.uploaded).getTime()) { skipped++; continue; }
      if (copied + failed >= BACKUP_BATCH_LIMIT) { pending++; continue; }
      try {
        const src = await env.tideventure_documents.get(o.key);
        if (!src) continue;
        await env.tideventure_backups.put(o.key, src.body, {
          httpMetadata: src.httpMetadata,
          customMetadata: src.customMetadata,
        });
        copied++;
      } catch { failed++; }
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  const result = { lastRun: started, finished: new Date().toISOString(), copied, skipped, failed, pending };
  try {
    await env.tideventure_documents.put('settings/backup-state.json', JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
  } catch {}
  return result;
}

async function handleFetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    async function getAuthUser() {
      let token = null;
      // Try Authorization header first (used by JS-based clients)
      const auth = request.headers.get('authorization') || '';
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (match) token = match[1];
      // Fallback to the session cookie — but ONLY for safe (GET/HEAD) requests.
      // State-changing requests must carry a Bearer token, so the cookie can't
      // act as an ambient credential for CSRF (a cross-site form/fetch cannot set
      // an Authorization header). The cookie exists only to authenticate top-level
      // GET navigations (document view, OAuth connect).
      if (!token && (request.method === 'GET' || request.method === 'HEAD')) {
        const cookie = request.headers.get('cookie') || '';
        const cmatch = cookie.match(/(?:^|;\s*)tv_session=([^;]+)/);
        if (cmatch) token = cmatch[1];
      }
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, jwtKey(env));
        // Enforce LIVE account status. A JWT is valid for 24h, but deactivating
        // a client must lock them out immediately — not whenever their token
        // happens to expire. Skip for admins and impersonation sessions.
        if (payload.email && !payload.imp && !isAdmin(payload.email)) {
          try {
            const uObj = await env.tideventure_documents.get(`user/${payload.email}`);
            if (uObj) {
              const u = JSON.parse(await uObj.text());
              if (u.status === 'deactivated' || u.status === 'pending_setup') return null;
            }
          } catch {}
        }
        return payload;
      } catch {
        return null;
      }
    }

    // Admin authority is an EXPLICIT allowlist, not "any @tideventurecpa.com
    // address". Deriving admin from the email suffix meant anyone who could get
    // a firm-domain account through onboarding (catch-all, forwarding, a mistyped
    // Convert) became a full admin. ADMIN_EMAILS is a comma-separated env var;
    // the default is the two real admin accounts so a missing var can't lock the
    // owner out. isAdmin also gates the getAuthUser deactivation-skip above.
    function isAdmin(email) {
      if (!email) return false;
      const allow = (env.ADMIN_EMAILS || 'isaac@tideventurecpa.com,admin@tideventurecpa.com')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      return allow.includes(email.toLowerCase());
    }

    // ── QBO OAuth ──
    if (url.pathname === '/api/qbo/auth' && method === 'GET') {
      // Auth via session cookie (sent on this top-level navigation) or Bearer —
      // never a token in the URL, which would leak into history and request logs.
      const u = await getAuthUser();
      if (!u?.email) return json(401, { error: 'Not authenticated' });
      // Clear any existing tokens before starting fresh OAuth
      const existing = await getQboTokens(env, u.email);
      if (existing) {
        await env.tideventure_documents.delete(qboTokenKey(u.email));
      }
      return handleQboAuth(request, env, u.email);
    }
    if (url.pathname === '/api/qbo/callback' && method === 'GET') {
      return handleQboCallback(request, env);
    }
    if (url.pathname === '/api/qbo/status' && method === 'GET') {
      const u = await getAuthUser();
      if (!u?.email) return json(401, { error: 'Not authenticated' });
      const tokens = await getQboTokens(env, u.email);
      return json(200, { connected: !!tokens });
    }
    if (url.pathname === '/api/qbo/tokens' && method === 'POST') {
      const u = await getAuthUser();
      if (!isAdmin(u?.email)) return json(403, { error: 'Admin access required' });
      const body = await request.json();
      await saveQboTokens(env, body.email, { access_token: body.accessToken, refresh_token: body.refreshToken, realmId: body.realmId });
      return json(200, { ok: true });
    }




    // ── Login endpoint ──
    if (url.pathname === '/api/login' && method === 'POST') {
      let email, password, turnstileToken;
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        ({ email, password, turnstileToken } = await request.json());
      } else {
        const fd = await request.formData();
        email = fd.get('email');
        password = fd.get('password');
        turnstileToken = fd.get('turnstileToken');
      }
      if (!email || !password) return json(400, { error: 'Email and password required' });
      const lowerEmail = email.toLowerCase().trim();

      // Rate limiting: check login attempts
      const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';

      // Human-verification challenge — checked before touching the rate limit
      // or password, so a bot can't burn through attempts trying to find one.
      if (env.TURNSTILE_SECRET_KEY) {
        if (!turnstileToken) return json(400, { error: 'Please complete the verification challenge.' });
        const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: turnstileToken, remoteip: ip }),
        });
        const verifyData = await verify.json();
        if (!verifyData.success) return json(400, { error: 'Verification failed. Please try again.' });
      }
      const rlKey = `login/${lowerEmail}`;
      const rl = await rateGet(env, rlKey);
      let attempts = 0, windowStart = Date.now();
      // Only count attempts within the last 15 minutes — an older window
      // resets, so 5 mistyped passwords is a 15-min pause, not a permanent lock.
      if (rl && rl.windowStart && Date.now() - rl.windowStart < 900000) {
        attempts = rl.count || 0;
        windowStart = rl.windowStart;
      }
      if (attempts >= 5) return json(429, { error: 'Too many attempts. Please wait 15 minutes and try again, or reset your password.' });

      // Per-IP throttle, independent of the per-email lock: stops an attacker
      // from locking a victim out by their email, and caps password-spraying many
      // emails from one IP. Keyed on cf-connecting-ip only (x-forwarded-for is
      // client-spoofable).
      const limitIp = request.headers.get('cf-connecting-ip') || 'unknown';
      const ipKey = `login-ip/${limitIp}`;
      const ipRl = await rateGet(env, ipKey);
      let ipAttempts = 0, ipWindow = Date.now();
      if (ipRl && ipRl.windowStart && Date.now() - ipRl.windowStart < 900000) { ipAttempts = ipRl.count || 0; ipWindow = ipRl.windowStart; }
      if (ipAttempts >= 20) return json(429, { error: 'Too many attempts from this network. Please wait 15 minutes and try again.' });

      // Look up user from R2 or fallback secret
      let userObj = null;
      try {
        const stored = await env.tideventure_documents.get(`user/${lowerEmail}`);
        if (stored) userObj = JSON.parse(await stored.text());
      } catch {}
      if (!userObj) {
        try {
          const legacy = JSON.parse(env.USERS_JSON || '{}');
          if (legacy[lowerEmail]) {
            userObj = { email: lowerEmail, password: await hashPassword(legacy[lowerEmail], env), role: isAdmin(lowerEmail) ? 'admin' : 'client', createdAt: new Date().toISOString(), status: 'active' };
            await env.tideventure_documents.put(`user/${lowerEmail}`, JSON.stringify(userObj), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, lowerEmail);
          }
        } catch {}
      }

      // Always run a full password verification, even when the email is unknown
      // (against DUMMY_PW_HASH), so the response time doesn't reveal whether the
      // account exists.
      const pwOk = await verifyPassword(password, userObj?.password || DUMMY_PW_HASH, env);
      if (userObj && pwOk) {
        // Check account status
        if (userObj.status === 'pending_setup') return json(403, { error: 'Account not yet set up. Please use the link from your welcome email.' });
        if (userObj.status === 'deactivated') return json(403, { error: 'This account has been deactivated. Please contact TideVenture CPA for assistance.' });
        // Success — clear rate limit
        await rateDelete(env, rlKey);
        const token = await new SignJWT({ email: lowerEmail, role: userObj.role || 'client', status: userObj.status || 'active' })
          .setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime('24h')
          .sign(jwtKey(env));
        const keyMaterial = await deriveKeyMaterial(env.DOC_ENC_KEY, lowerEmail);
        // Also set the JWT as an HttpOnly cookie so top-level navigations
        // (document view-in-new-tab, OAuth connect redirects) authenticate via
        // the cookie instead of a token in the URL. SameSite=Lax still sends it
        // on top-level GET navigations. The SPA keeps using the Bearer token
        // from the JSON body for its fetch() calls, so this is purely additive.
        const res = json(200, { token, keyMaterial, email: lowerEmail, role: userObj.role || 'client', status: userObj.status || 'active' });
        res.headers.append('Set-Cookie', `tv_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400`);
        return res;
      }

      // Failed attempt — increment both the per-email and per-IP windows.
      attempts++;
      await ratePut(env, rlKey, attempts, windowStart, 900000);
      await ratePut(env, ipKey, ipAttempts + 1, ipWindow, 900000);
      return json(401, { error: 'Invalid credentials' });
    }

    // ── Check session ──
    if (url.pathname === '/api/session' && method === 'GET') {
      const user = await getAuthUser();
      if (!user) return json(401, { error: 'Not authenticated' });
      const keyMaterial = await deriveKeyMaterial(env.DOC_ENC_KEY, user.email);
      // Always read status from the live user record — the JWT claim can be
      // stale (or absent), and the engagement-letter gate depends on it.
      let status = user.status || 'active';
      try {
        const uObj = await env.tideventure_documents.get(`user/${user.email}`);
        if (uObj) { const u = JSON.parse(await uObj.text()); if (u.status) status = u.status; }
      } catch {}
      return json(200, { email: user.email, role: user.role, status, keyMaterial });
    }

    // ── Logout ──
    if (url.pathname === '/api/logout' && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'tv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        },
      });
    }

    // ── Protected API routes ──
    const user = await getAuthUser();
    const email = user?.email;
    // Who the audit log should name. During an impersonation session `email` is
    // the CLIENT, so attributing actions to it records the client doing things
    // the admin did — a log that misattributes is worse than one with a gap.
    const auditActor = (user && typeof user.imp === 'string' && user.imp)
      ? `${user.imp} (impersonating ${email})`
      : email;

    if (url.pathname === '/api/documents' && method === 'GET') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try {
        return await handleListDocuments(env, email, isAdmin(email));
      } catch (e) {
        return json(500, { error: e.message });
      }
    }

    if (url.pathname === '/api/dashboard' && method === 'GET') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try { return await handleDashboard(env, email); } catch (e) { return json(500, { error: e.message }); }
    }

    // Client: own document-request checklist + "I uploaded this" action
    if (url.pathname === '/api/doc-requests' && method === 'GET') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try {
        const { objects } = await listAll(env.tideventure_documents, { prefix: `docrequest/${email}/` });
        const requests = [];
        for (const o of objects) { try { requests.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
        requests.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
        return json(200, { requests });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/doc-requests/fulfill' && method === 'POST') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try {
        const body = await request.json();
        if (!body.id) return json(400, { error: 'id required' });
        const key = `docrequest/${email}/${body.id}`;
        const obj = await env.tideventure_documents.get(key);
        if (!obj) return json(404, { error: 'Request not found' });
        const reqRec = JSON.parse(await obj.text());
        if (reqRec.status !== 'requested') return json(400, { error: 'Already handled' });
        reqRec.status = 'submitted';
        reqRec.submittedAt = new Date().toISOString();
        await env.tideventure_documents.put(key, JSON.stringify(reqRec), { httpMetadata: { contentType: 'application/json' } });
        await insertDocRequestD1(env, reqRec);
        return json(200, { ok: true, request: reqRec });
      } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/profile' && method === 'GET') {
      if (!email) return json(401, { error: 'Unauthorized' });
      const profileEmail = isAdmin(email) && url.searchParams.get('email') ? url.searchParams.get('email') : email;
      try { return await handleGetProfile(env, profileEmail); } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/profile' && method === 'PUT') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try { return await handleUpdateProfile(request, env, email, isAdmin(email)); } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/documents/upload' && method === 'POST') {
      if (!email) return json(401, { error: 'Unauthorized' });
      return handleUploadDocument(request, env, email, auditActor);
    }
    // Admin: upload document to a specific client's portal
    if (url.pathname === '/api/admin/documents/upload' && method === 'POST' && isAdmin(email)) {
      try {
        const fd = await request.formData();
        const file = fd.get('file');
        const clientEmail = (fd.get('email') || '').toLowerCase();
        if (!file || !clientEmail) return json(400, { error: 'File and client email required' });
        const cleanClient = normalizeEmail(clientEmail);
        if (!cleanClient) return json(400, { error: 'Valid client email required' });
        const id = crypto.randomUUID();
        const key = `${cleanClient}/${id}`;
        const buf = await file.arrayBuffer();
        // Encrypt with the CLIENT's key, not the admin's — the client has to be
        // able to open it in their own portal. A failure here must abort the
        // upload: storing the plaintext instead is exactly the bug this fixes.
        const encrypted = await encryptWithWorkerKey(env.DOC_ENC_KEY, cleanClient, buf);
        const storedName = file.name.endsWith('.enc') ? file.name : `${file.name}.enc`;
        await env.tideventure_documents.put(key, encrypted, {
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: { originalName: storedName, uploadedBy: cleanClient, source: 'firm', uploadedAt: new Date().toISOString(), encrypted: 'true' },
        });
        await logAudit(env, 'UPLOAD', auditActor, `${file.name} to ${cleanClient} (encrypted)`);
        return json(200, { ok: true, id });
      } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/audit' && method === 'GET') {
      if (!isAdmin(email)) return json(403, { error: 'Admin access required' });
      try { return await handleAuditLog(env); } catch (e) { return json(500, { error: e.message }); }
    }

    // ── Prospect capture (from pricing/contact pages) ──
    if (url.pathname === '/api/prospect' && method === 'POST') {
      try {
        const body = await request.json();
        // This is the only unauthenticated write endpoint — validate strictly.
        const cleanEmail = normalizeEmail(body.email);
        if (!cleanEmail) return json(400, { error: 'Please enter a valid email address.' });
        // IP-keyed rate limit: cap prospect submissions so the public form
        // can't be used to flood R2/D1 with junk rows. 10 per rolling hour.
        const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
        // Human-verification challenge, same widget as the login form. Unlike the
        // login, a failure here does NOT reject the request: the cost of turning
        // away one real prospect (ad blocker, privacy browser, flaky network —
        // all of which break the widget) outweighs the cost of storing a spam
        // row. Instead the lead is recorded and flagged, and the flag rides along
        // into the notification email so a junk entry is obvious at a glance.
        let verified = false;
        if (env.TURNSTILE_SECRET_KEY && body.turnstileToken) {
          try {
            const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: body.turnstileToken, remoteip: ip }),
            });
            const verifyData = await verify.json();
            verified = !!verifyData.success;
          } catch { verified = false; }
        }
        const rlKey = `prospect/${ip}`;
        const rl = await rateGet(env, rlKey);
        let subs = 0, windowStart = Date.now();
        if (rl && rl.windowStart && Date.now() - rl.windowStart < 3600000) { subs = rl.count; windowStart = rl.windowStart; }
        // Verified humans get the full allowance; unverified ones get a tighter
        // cap, so a bot that simply omits the token can't flood the table even
        // though a single unverified submission is still accepted.
        if (subs >= (verified ? 10 : 3)) return json(429, { error: 'Too many submissions. Please try again later.' });
        await ratePut(env, rlKey, subs + 1, windowStart, 3600000);
        const id = crypto.randomUUID();
        // Allowlist service values so a hostile string can't be stored and later
        // rendered in the portal Plan card (stored-XSS root cause).
        const SERVICE_KEYS = ['tax', 'quarterly', 'monthly', 'cfo', 'bookkeeping'];
        const svcs = Array.isArray(body.services) ? body.services.filter(s => SERVICE_KEYS.includes(s)) : [];
        const cfoSvcs = Array.isArray(body.cfoServices) ? body.cfoServices.filter(s => typeof s === 'string' && s.length < 40).slice(0, 10) : [];
        // Free-text fields are length-capped here: they are stored and later
        // rendered in the admin Prospects tab, so an unbounded string from the
        // public form has no business reaching either.
        const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        const prospect = { id, email: cleanEmail, name: txt(body.name, 120), businessName: txt(body.businessName, 160), phone: txt(body.phone, 40), city: txt(body.city, 80), state: txt(body.state, 2), entityType: txt(body.entityType, 40), services: svcs, cfoServices: cfoSvcs, members: body.members || 1, revenue: txt(body.revenue, 40), notes: txt(body.notes, 4000), source: txt(body.source, 40) || 'pricing', verified, createdAt: new Date().toISOString(), status: 'new' };
        await env.tideventure_documents.put(`prospect/${id}`, JSON.stringify(prospect), { httpMetadata: { contentType: 'application/json' } });
        await syncProspectToD1(env, prospect);
        // A new lead is worthless if nobody is told about it. Log it, then email
        // the firm. Both are best-effort: the visitor already gave us their
        // details, so a mail failure must never turn into an error for them.
        try { await logAudit(env, 'PROSPECT', cleanEmail, `New lead: ${prospect.name || cleanEmail}${prospect.businessName ? ' (' + prospect.businessName + ')' : ''}`); } catch {}
        try {
          await sendProspectNotification(env, prospect);
        } catch (e) {
          try { await logAudit(env, 'ERROR', cleanEmail, `Lead notification email failed: ${String(e.message).slice(0, 120)}`); } catch {}
        }
        return json(200, { ok: true, id });
      } catch (e) { return json(500, { error: e.message }); }
    }

    // ── Admin: Prospect management ──
    if (url.pathname === '/api/admin/prospects' && method === 'GET' && isAdmin(email)) {
      try {
        // Prospects who've signed their engagement letter have graduated to
        // active clients — keep their history but drop them from this list.
        // The graduation check is against the live client record (not just the
        // prospect's own status flag) so it also covers clients who signed
        // before this filter existed.
        if (env.D1_READS !== 'off') {
          try {
            const rows = (await env.DB.prepare(
              `SELECT p.* FROM prospects p
               WHERE p.status != 'active'
                 AND (p.email IS NULL OR LOWER(p.email) NOT IN
                      (SELECT LOWER(email) FROM clients WHERE status = 'active'))
               ORDER BY p.created_at DESC`
            ).all()).results;
            const filtered = rows.map(rowToProspect);
            return json(200, { prospects: filtered, newCount: filtered.filter(p => !p.viewed).length });
          } catch {}
        }
        const results = [];
        const list = await listAll(env.tideventure_documents);
        for (const obj of list.objects) {
          if (obj.key.startsWith('prospect/')) {
            try { results.push(JSON.parse(await (await env.tideventure_documents.get(obj.key)).text())); } catch {}
          }
        }
        const filtered = [];
        for (const p of results) {
          if (p.status === 'active') continue;
          if (p.email) {
            try {
              const uObj = await env.tideventure_documents.get(`user/${p.email.toLowerCase()}`);
              if (uObj) {
                const u = JSON.parse(await uObj.text());
                if (u.status === 'active') continue;
              }
            } catch {}
          }
          filtered.push(p);
        }
        filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return json(200, { prospects: filtered, newCount: filtered.filter(p => !p.viewed).length });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/prospects/viewed' && method === 'POST' && isAdmin(email)) {
      try {
        const list = await listAll(env.tideventure_documents);
        for (const obj of list.objects) {
          if (obj.key.startsWith('prospect/')) {
            try {
              const p = JSON.parse(await (await env.tideventure_documents.get(obj.key)).text());
              if (!p.viewed) { p.viewed = true; await env.tideventure_documents.put(obj.key, JSON.stringify(p), { httpMetadata: { contentType: 'application/json' } }); await syncProspectToD1(env, p); }
            } catch {}
          }
        }
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/prospects/delete' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        await env.tideventure_documents.delete(`prospect/${body.id}`).catch(() => {});
        // Reads are D1-backed, so the mirror row must go too or the deleted
        // prospect keeps showing in the list and KPI counts.
        try { await env.DB.prepare('DELETE FROM prospects WHERE id = ?').bind(body.id).run(); } catch {}
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/prospects/convert' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const prospectKey = `prospect/${body.id}`;
        const obj = await env.tideventure_documents.get(prospectKey);
        if (!obj) return json(404, { error: 'Prospect not found' });
        const prospect = JSON.parse(await obj.text());
        const userEmail = prospect.email;
        const svcs = body.services || (prospect.services || []);
        const derivedType = body.customerType || (svcs.includes('bookkeeping') && svcs.includes('tax') ? 'both' : svcs.includes('bookkeeping') ? 'bookkeeping' : 'tax');
        const user = { email: userEmail, role: 'client', businessName: body.businessName || prospect.name || userEmail.split('@')[0], contactName: prospect.name || '', state: body.state || '', customerType: derivedType, services: svcs, dashboardCards: Array.isArray(body.dashboardCards) ? body.dashboardCards : defaultDashboardCards(svcs), monthlyPrice: body.monthlyPrice || 0, yearlyPrice: body.yearlyPrice || 0, status: 'pending_setup', createdAt: new Date().toISOString() };
        await env.tideventure_documents.put(`user/${userEmail}`, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, userEmail);
        // Generate setup token
        const setupToken = crypto.randomUUID();
        await setupTokenPut(env, setupToken, userEmail); // dual-writes D1 + R2, 24h expiry
        // Mark prospect as converted
        prospect.status = 'converted';
        prospect.convertedAt = new Date().toISOString();
        await env.tideventure_documents.put(prospectKey, JSON.stringify(prospect), { httpMetadata: { contentType: 'application/json' } });
        await syncProspectToD1(env, prospect);

        const setupUrl = `https://tideventurecpa.com/setup-account?token=${setupToken}`;
        const firstName = (prospect.name || '').trim().split(' ')[0] || 'there';
        const bizLine = body.businessName ? ` on behalf of ${body.businessName}` : '';
        const tmpl = await getWelcomeEmailTemplate(env);
        const tmplVars = { firstName, bizLine, businessName: body.businessName || '', setupUrl, email: userEmail };

        return json(200, {
          ok: true, email: userEmail, setupToken, setupUrl,
          defaultSubject: substituteTemplate(tmpl.subject, tmplVars),
          defaultMessage: substituteTemplate(tmpl.message, tmplVars),
        });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: get/save the master welcome-email template
    if (url.pathname === '/api/admin/settings/welcome-email' && method === 'GET' && isAdmin(email)) {
      const tmpl = await getWelcomeEmailTemplate(env);
      return json(200, tmpl);
    }
    if (url.pathname === '/api/admin/settings/welcome-email' && method === 'PUT' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.subject || !body.message) return json(400, { error: 'Subject and message are required' });
        await env.tideventure_documents.put('settings/welcome-email.json', JSON.stringify({
          subject: body.subject, message: body.message, updatedAt: new Date().toISOString(),
        }), { httpMetadata: { contentType: 'application/json' } });
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: get/save the master engagement-letter template
    if (url.pathname === '/api/admin/settings/engagement-letter' && method === 'GET' && isAdmin(email)) {
      const tmpl = await getEngagementTemplate(env);
      return json(200, tmpl);
    }
    if (url.pathname === '/api/admin/settings/engagement-letter' && method === 'PUT' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.message) return json(400, { error: 'Message is required' });
        await env.tideventure_documents.put('settings/engagement-letter.json', JSON.stringify({
          message: body.message, updatedAt: new Date().toISOString(),
        }), { httpMetadata: { contentType: 'application/json' } });
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: view a client's signed engagement record
    if (url.pathname === '/api/admin/engagement-record' && method === 'GET' && isAdmin(email)) {
      try {
        const clientEmail = (url.searchParams.get('email') || '').toLowerCase();
        if (!clientEmail) return json(400, { error: 'Email required' });
        const list = await listAll(env.tideventure_documents, { prefix: `engagement/${clientEmail}/` });
        if (!list.objects.length) return json(200, { signed: false });
        const latest = list.objects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))[0];
        const obj = await env.tideventure_documents.get(latest.key);
        return json(200, { signed: true, record: JSON.parse(await obj.text()) });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: backups
    // Client documents sitting in the backup bucket with no live counterpart —
    // deleted at some point after a backup had already copied them. These are
    // exactly the files that "delete" failed to actually remove, so they are
    // listed explicitly rather than left invisible.
    if (url.pathname === '/api/admin/backup/orphans' && method === 'GET' && isAdmin(email)) {
      if (!env.tideventure_backups) return json(200, { orphans: [], error: 'Backup bucket not bound' });
      try {
        const live = new Set();
        const liveList = await listAll(env.tideventure_documents);
        for (const o of liveList.objects) live.add(o.key);
        const backupList = await listAll(env.tideventure_backups, { include: ['customMetadata'] });
        const orphans = [];
        for (const o of backupList.objects) {
          const parts = o.key.split('/');
          if (!(parts.length === 2 && parts[0].includes('@') && isDocId(parts[1]))) continue;
          if (live.has(o.key)) continue;
          orphans.push({
            key: o.key,
            client: parts[0],
            name: o.customMetadata?.originalName || parts[1],
            uploaded: o.customMetadata?.uploadedAt || null,
            backedUp: o.uploaded,
            size: o.size,
            encrypted: (o.customMetadata?.originalName || '').endsWith('.enc'),
          });
          if (orphans.length >= 200) break;
        }
        return json(200, { orphans, total: orphans.length });
      } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/admin/backup/purge' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const keys = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
        if (!keys.length) return json(400, { error: 'No keys supplied' });
        const result = await purgeFromBackups(env, keys);
        await logAudit(env, 'PURGE', auditActor, `${result.purged} backup copies purged${result.skipped ? `, ${result.skipped} skipped` : ''}`);
        return json(200, { ok: true, ...result });
      } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/admin/backup/status' && method === 'GET' && isAdmin(email)) {
      try {
        const obj = await env.tideventure_documents.get('settings/backup-state.json');
        if (!obj) return json(200, { lastRun: null });
        return json(200, JSON.parse(await obj.text()));
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/backup/run' && method === 'POST' && isAdmin(email)) {
      try {
        const result = await runBackup(env);
        await logAudit(env, 'BACKUP', auditActor, `Manual backup: ${result.copied} copied, ${result.failed} failed`);
        return json(200, result);
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Client: request a password reset (public — never reveals whether the account exists)
    if (url.pathname === '/api/request-password-reset' && method === 'POST') {
      try {
        const body = await request.json();
        // Normalised like every other address that becomes an R2 key. A
        // malformed one returns the same { ok: true } as an unknown one, so
        // this endpoint still reveals nothing about which accounts exist.
        const resetEmail = normalizeEmail(body.email);
        if (!resetEmail) return json(200, { ok: true });
        // Rate limit: 3 requests per hour per email
        const rlKey = `reset/${resetEmail}`;
        const existing = await rateGet(env, rlKey);
        let rlCount = 0, rlWindow = Date.now();
        if (existing && Date.now() - existing.windowStart <= 3600000) { rlCount = existing.count; rlWindow = existing.windowStart; }
        if (rlCount >= 3) return json(200, { ok: true });
        await ratePut(env, rlKey, rlCount + 1, rlWindow, 3600000);

        const userObj = await env.tideventure_documents.get(`user/${resetEmail}`);
        if (userObj) {
          const resetToken = crypto.randomUUID();
          await resetTokenPut(env, resetToken, resetEmail);
          const resetUrl = `https://tideventurecpa.com/reset-password?token=${resetToken}`;
          const text = `We received a request to reset the password for your TideVenture CPA client portal account (${resetEmail}).\n\nUse the link below within 1 hour to choose a new password:\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — your password will remain unchanged.`;
          try {
            await sendGmailEmail(env, {
              to: resetEmail,
              subject: 'Reset your TideVenture CPA portal password',
              text: `${text}\n\nTideVenture CPA\ntideventurecpa.com`,
              html: renderWelcomeEmailHtml(text, resetEmail, 'This message was sent because a password reset was requested for a TideVenture CPA client portal account with this address. If you did not request it, no action is needed.'),
            });
          } catch (e) { await logAudit(env, 'ERROR', resetEmail, `Password reset email failed: ${e.message.slice(0, 120)}`); }
        }
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Client: complete a password reset
    if (url.pathname === '/api/reset-password' && method === 'POST') {
      try {
        const body = await request.json();
        if (!body.token) return json(400, { error: 'Token required' });
        if (!body.password || body.password.length < 10) return json(400, { error: 'Password must be at least 10 characters' });
        const data = await resetTokenRead(env, body.token);
        if (!data) return json(404, { error: 'This reset link is invalid or has already been used' });
        if (Date.now() - data.createdAt > 3600000) {
          await resetTokenDelete(env, body.token);
          return json(410, { error: 'This reset link has expired — please request a new one' });
        }
        const userKey = `user/${data.email}`;
        const userObj = await env.tideventure_documents.get(userKey);
        if (!userObj) return json(404, { error: 'Account not found' });
        const user = JSON.parse(await userObj.text());
        user.password = await hashPassword(body.password, env);
        await env.tideventure_documents.put(userKey, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, userKey.slice(5));
        await resetTokenDelete(env, body.token);
        await rateDelete(env, `login/${data.email}`);
        await logAudit(env, 'RESET', data.email, 'Password reset completed');
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: send the (possibly edited) welcome email to a client
    if (url.pathname === '/api/admin/send-welcome-email' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.email || !body.subject || !body.text) return json(400, { error: 'email, subject, and text are required' });
        const html = renderWelcomeEmailHtml(body.text, body.email);
        const fullText = `${body.text}\n\nWarm regards,\n\nIsaac Frisch, CPA\nTideVenture CPA\ntideventurecpa.com`;
        await sendGmailEmail(env, { to: body.email, subject: body.subject, text: fullText, html });
        await logAudit(env, 'EMAIL', auditActor, `Welcome email sent to ${body.email}`);
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: impersonate a client
    if (url.pathname === '/api/admin/impersonate' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.email) return json(400, { error: 'Email required' });
        const lowerEmail = normalizeEmail(body.email);
        if (!lowerEmail) return json(400, { error: 'Valid email required' });
        const obj = await env.tideventure_documents.get(`user/${lowerEmail}`);
        if (!obj) return json(404, { error: 'User not found' });
        const user = JSON.parse(await obj.text());
        // `imp` carries the impersonating admin's address, not just a boolean.
        // Without it nothing downstream can say WHO acted, so every action taken
        // during the session is recorded against the client. Still truthy, so
        // the existing checks that only test for presence keep working.
        const token = await new SignJWT({ email: lowerEmail, role: 'client', status: user.status || 'active', imp: email })
          .setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime('1h')
          .sign(jwtKey(env));
        await logAudit(env, 'IMPERSONATE', email, `Started viewing ${lowerEmail}'s portal`);
        return json(200, { token, email: lowerEmail });
      } catch (e) { return json(500, { error: e.message }); }
    }

    // Admin: update client services/pricing
    if (url.pathname === '/api/admin/client-settings' && method === 'PUT' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.email) return json(400, { error: 'Email required' });
        const lowerEmail = normalizeEmail(body.email);
        if (!lowerEmail) return json(400, { error: 'Valid email required' });
        // Save to user profile
        const userKey = `user/${lowerEmail}`;
        const obj = await env.tideventure_documents.get(userKey);
        let user = obj ? JSON.parse(await obj.text()) : {};
        if (body.services) user.services = body.services;
        if (body.monthlyPrice !== undefined) user.monthlyPrice = body.monthlyPrice;
        if (body.yearlyPrice !== undefined) user.yearlyPrice = body.yearlyPrice;
        if (body.customerType) user.customerType = body.customerType;
        if (body.businessName) user.businessName = body.businessName;
        if (Array.isArray(body.dashboardCards)) user.dashboardCards = body.dashboardCards;
        await env.tideventure_documents.put(userKey, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, userKey.slice(5));
        // Also save to profile for consistency
        const profileKey = `profile/${lowerEmail}`;
        const profObj = await env.tideventure_documents.get(profileKey);
        let profile = profObj ? JSON.parse(await profObj.text()) : {};
        if (body.customerType) profile.customerType = body.customerType;
        if (body.businessName) profile.businessName = body.businessName;
        if (body.services) profile.services = body.services;
        if (body.monthlyPrice !== undefined) profile.monthlyPrice = body.monthlyPrice;
        if (body.yearlyPrice !== undefined) profile.yearlyPrice = body.yearlyPrice;
        if (Array.isArray(body.dashboardCards)) profile.dashboardCards = body.dashboardCards;
        await env.tideventure_documents.put(profileKey, JSON.stringify(profile), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, profileKey.slice(8));
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: deactivate or reactivate a client — deactivated clients are
    // blocked at login (see /api/login) but their records/history are kept.
    if (url.pathname === '/api/admin/client-status' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.email || !['active', 'deactivated'].includes(body.status)) {
          return json(400, { error: 'email and a valid status (active or deactivated) are required' });
        }
        const lowerEmail = normalizeEmail(body.email);
        if (!lowerEmail) return json(400, { error: 'Valid email required' });
        const userKey = `user/${lowerEmail}`;
        const obj = await env.tideventure_documents.get(userKey);
        if (!obj) return json(404, { error: 'Client not found' });
        const user = JSON.parse(await obj.text());
        user.status = body.status;
        if (body.status === 'deactivated') user.deactivatedAt = new Date().toISOString();
        else delete user.deactivatedAt;
        await env.tideventure_documents.put(userKey, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, userKey.slice(5));
        const profileKey = `profile/${lowerEmail}`;
        const profObj = await env.tideventure_documents.get(profileKey);
        if (profObj) {
          const profile = JSON.parse(await profObj.text());
          profile.status = body.status;
          await env.tideventure_documents.put(profileKey, JSON.stringify(profile), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, profileKey.slice(8));
        }
        await logAudit(env, body.status === 'deactivated' ? 'DEACTIVATE' : 'REACTIVATE', email, lowerEmail);
        return json(200, { ok: true, status: body.status });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: set a client's tax-return statuses (drives the portal's Tax Return
    // Status card, which previously had no way to be populated).
    if (url.pathname === '/api/admin/client-tax-status' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.email || !Array.isArray(body.taxStatuses)) return json(400, { error: 'email and taxStatuses[] required' });
        // 5-stage return pipeline (docs → prep → review → filed → accepted).
        // Legacy values stay valid: portal maps not_started→docs, in_review→review.
        const allowed = ['not_started', 'in_review', 'docs', 'prep', 'review', 'filed', 'accepted'];
        const taxStatuses = body.taxStatuses
          .filter(t => t && typeof t.label === 'string' && t.label.trim())
          .map(t => ({ label: t.label.trim().slice(0, 80), status: allowed.includes(t.status) ? t.status : 'docs' }))
          .slice(0, 12);
        const normTaxEmail = normalizeEmail(body.email);
        if (!normTaxEmail) return json(400, { error: 'Valid email required' });
        const userKey = `user/${normTaxEmail}`;
        const obj = await env.tideventure_documents.get(userKey);
        if (!obj) return json(404, { error: 'Client not found' });
        const user = JSON.parse(await obj.text());
        user.taxStatuses = taxStatuses;
        await env.tideventure_documents.put(userKey, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, userKey.slice(5));
        return json(200, { ok: true, taxStatuses });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // ── Tax Savings Ledger (admin CRUD) ──
    // One R2 object per entry at savings/<email>/<id>; D1 mirror for future
    // aggregations. The client's dashboard shows the running total.
    // ── Estimated tax projection worksheets (admin only) ──
    // Deliberately admin-only and draft-by-default: nothing here is visible to a
    // client, and no figure reaches one without the CPA marking it reviewed.
    if (url.pathname === '/api/admin/tax-projection/schema' && method === 'GET' && isAdmin(email)) {
      return json(200, { lines: LINES, groups: GROUPS, filingStatuses: FILING_STATUSES, taxruleKeys: TAXRULE_KEYS,
        states: STATES, paidBy: PAID_BY, stateLines: STATE_LINES,
        entityTypes: ENTITY_TYPES, entityStates: ENTITY_STATES, entityLines: ENTITY_LINES,
        k1Lines: K1_LINES, sections: SECTIONS });
    }

    if (url.pathname === '/api/admin/tax-projection' && method === 'GET' && isAdmin(email)) {
      const client = normalizeEmail(url.searchParams.get('email'));
      const year = parseInt(url.searchParams.get('year'), 10);
      if (!client || !Number.isInteger(year)) return json(400, { error: 'email and year required' });
      const obj = await env.tideventure_documents.get(`taxproj/${client}/${year}`);
      if (!obj) return json(200, { exists: false });
      const saved = JSON.parse(await obj.text());
      const computed = computeWorksheet(saved.values, saved.groups, saved.filingStatus);
      const state = saved.state && STATE_LINES[saved.state]
        ? computeStateWorksheet(saved.state, saved.stateValues || {}, computed, { paidBy: saved.paidBy })
        : null;
      return json(200, { exists: true, ...saved, computed, state });
    }

    // Recalculate without saving, so the figures update as they are typed and
    // the server stays the only thing that decides what a total is. A separate
    // route rather than a flag on the save, because "show me" and "write it
    // down" should not be one action.
    if (url.pathname === '/api/admin/tax-projection/compute' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!isValidFilingStatus(body.filingStatus)) return json(400, { error: 'Invalid filing status' });
        const known = new Set(LINES.map(l => l.k));
        const values = {};
        for (const [k, v] of Object.entries(body.values || {})) {
          if (!known.has(k)) continue;
          values[k] = { prior: Number(v?.prior) || 0, baseline: Number(v?.baseline) || 0 };
        }
        const groups = {};
        for (const g of GROUPS) {
          groups[g.key] = (Array.isArray(body.groups?.[g.key]) ? body.groups[g.key] : []).slice(0, 50);
        }
        const computed = computeWorksheet(values, groups, body.filingStatus);
        const stateCode = typeof body.state === 'string' && STATE_LINES[body.state] ? body.state : null;
        const stateValues = {};
        if (stateCode) {
          const knownState = new Set(STATE_LINES[stateCode].map(l => l.k));
          for (const [k, v] of Object.entries(body.stateValues || {})) {
            if (!knownState.has(k)) continue;
            stateValues[k] = { prior: Number(v?.prior) || 0, baseline: Number(v?.baseline) || 0 };
          }
        }
        const state = stateCode
          ? computeStateWorksheet(stateCode, stateValues, computed, { paidBy: body.paidBy })
          : null;
        return json(200, { computed, state });
      } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/admin/tax-projection' && method === 'PUT' && isAdmin(email)) {
      const body = await request.json();
      const client = normalizeEmail(body.email);
      const year = parseInt(body.year, 10);
      if (!client || !Number.isInteger(year)) return json(400, { error: 'email and year required' });
      if (!isValidFilingStatus(body.filingStatus)) return json(400, { error: 'Invalid filing status' });
      // Only keys the schema knows about are stored, so a stray field from a
      // stale browser tab can't quietly become part of a tax worksheet.
      const known = new Set(LINES.map(l => l.k));
      const values = {};
      for (const [k, v] of Object.entries(body.values || {})) {
        if (!known.has(k)) continue;
        // Prior and baseline are what gets entered; difference is derived at
        // compute time and never stored, so the two can't fall out of step.
        values[k] = { prior: Number(v?.prior) || 0, baseline: Number(v?.baseline) || 0 };
      }
      const groups = {};
      for (const g of GROUPS) {
        groups[g.key] = (Array.isArray(body.groups?.[g.key]) ? body.groups[g.key] : [])
          .slice(0, 50)
          .map(r => {
            const row = { name: String(r?.name ?? '').slice(0, 120), prior: Number(r?.prior) || 0, baseline: Number(r?.baseline) || 0 };
            if (g.key === 'k1s') {
              row.ein = String(r?.ein ?? '').slice(0, 20);
              // Nested K-1 detail, allowlisted against the K-1 schema exactly as
              // the top-level lines are. When present it DRIVES the summary, so
              // an unknown key here would be a figure nobody could account for.
              const vals = {};
              for (const [k, v] of Object.entries(r?.values || {})) {
                if (!K1_LINE_BY_KEY[k]) continue;
                vals[k] = { prior: Number(v?.prior) || 0, baseline: Number(v?.baseline) || 0 };
              }
              if (Object.keys(vals).length) row.values = vals;
              for (const f of ['passive_activity', 'actively_participated', 'real_estate_professional', 'publicly_traded', 'specified_trade']) {
                if (r?.flags && typeof r.flags[f] === 'boolean') { row.flags = row.flags || {}; row.flags[f] = r.flags[f]; }
              }
            }
            return row;
          });
      }
      // State worksheet, if one applies. Same allowlist discipline as federal.
      const stateCode = typeof body.state === 'string' && STATE_LINES[body.state] ? body.state : null;
      const stateValues = {};
      if (stateCode) {
        const knownState = new Set(STATE_LINES[stateCode].map(l => l.k));
        for (const [k, v] of Object.entries(body.stateValues || {})) {
          if (!knownState.has(k)) continue;
          stateValues[k] = { prior: Number(v?.prior) || 0, baseline: Number(v?.baseline) || 0 };
        }
      }
      const record = {
        email: client,
        year,
        priorYear: Number.isInteger(parseInt(body.priorYear, 10)) ? parseInt(body.priorYear, 10) : year - 1,
        filingStatus: body.filingStatus,
        status: body.status === 'reviewed' ? 'reviewed' : 'draft',
        values,
        groups,
        state: stateCode,
        stateValues,
        // Who actually remits the state estimates. This changes what we tell
        // them to pay, never what the tax computes to.
        // What the entity pays is the PTE credit line on the state worksheet,
        // not a second field here — one number, one place.
        paidBy: PAID_BY.some(p => p.key === body.paidBy) ? body.paidBy : 'individual',
        updatedAt: new Date().toISOString(),
        updatedBy: email,
      };
      await env.tideventure_documents.put(`taxproj/${client}/${year}`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
      const computed = computeWorksheet(values, groups, record.filingStatus);
      const state = stateCode
        ? computeStateWorksheet(stateCode, stateValues, computed, { paidBy: record.paidBy })
        : null;
      await syncTaxProjectionToD1(env, record, computed);
      await logAudit(env, 'TAXPROJ', auditActor, `Saved ${year} projection for ${client} (${record.status})`);
      return json(200, { ok: true, computed, state });
    }

    // ── Pass-through entity worksheets ──
    if (url.pathname === '/api/admin/entity-projection' && method === 'GET' && isAdmin(email)) {
      const entity = normalizeEmail(url.searchParams.get('email'));
      const year = parseInt(url.searchParams.get('year'), 10);
      if (!entity || !Number.isInteger(year)) return json(400, { error: 'email and year required' });
      const obj = await env.tideventure_documents.get(`taxentity/${entity}/${year}`);
      if (!obj) return json(200, { exists: false });
      const saved = JSON.parse(await obj.text());
      const computed = computeEntityWorksheet(saved.state, saved.values, saved.owners);
      return json(200, { exists: true, ...saved, computed });
    }

    if (url.pathname === '/api/admin/entity-projection' && method === 'PUT' && isAdmin(email)) {
      const body = await request.json();
      const entity = normalizeEmail(body.email);
      const year = parseInt(body.year, 10);
      if (!entity || !Number.isInteger(year)) return json(400, { error: 'email and year required' });
      const stateCode = typeof body.state === 'string' && ENTITY_LINES[body.state] ? body.state : null;
      if (!stateCode) return json(400, { error: 'A state with a built worksheet is required' });
      const known = new Set(ENTITY_LINES[stateCode].map(l => l.k));
      const values = {};
      for (const [k, v] of Object.entries(body.values || {})) {
        if (!known.has(k)) continue;
        values[k] = { prior: Number(v?.prior) || 0, baseline: Number(v?.baseline) || 0 };
      }
      const owners = (Array.isArray(body.owners) ? body.owners : []).slice(0, 25).map(o => ({
        email: normalizeEmail(o?.email) || '',
        name: String(o?.name ?? '').slice(0, 120),
        ownershipPercent: Number(o?.ownershipPercent) || 0,
        allocatedPte: o?.allocatedPte === '' || o?.allocatedPte == null ? null : Number(o.allocatedPte) || 0,
      })).filter(o => o.email);
      const record = {
        email: entity, year,
        priorYear: Number.isInteger(parseInt(body.priorYear, 10)) ? parseInt(body.priorYear, 10) : year - 1,
        entityType: ENTITY_TYPES.some(t => t.key === body.entityType) ? body.entityType : 'scorp',
        state: stateCode,
        status: body.status === 'reviewed' ? 'reviewed' : 'draft',
        values, owners,
        updatedAt: new Date().toISOString(), updatedBy: email,
      };
      await env.tideventure_documents.put(`taxentity/${entity}/${year}`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
      const computed = computeEntityWorksheet(stateCode, values, owners);
      await syncEntityProjectionToD1(env, record, computed);
      await logAudit(env, 'TAXPROJ', auditActor, `Saved ${year} entity worksheet for ${entity} (${record.status})`);
      return json(200, { ok: true, computed });
    }

    // What an owner's individual worksheet should show as its PTE credit. This
    // exists so the figure is read from the entity that actually pays it rather
    // than typed onto two worksheets that can then disagree.
    if (url.pathname === '/api/admin/pte-allocation' && method === 'GET' && isAdmin(email)) {
      const owner = normalizeEmail(url.searchParams.get('email'));
      const year = parseInt(url.searchParams.get('year'), 10);
      if (!owner || !Number.isInteger(year)) return json(400, { error: 'email and year required' });
      try {
        const rows = await env.DB.prepare(
          'SELECT entity_email, owner_name, ownership_pct, allocated_pte FROM entity_owner_allocations WHERE owner_email = ? AND tax_year = ?'
        ).bind(owner, year).all();
        const list = rows.results || [];
        return json(200, {
          allocations: list,
          total: Math.round(list.reduce((s, r) => s + (Number(r.allocated_pte) || 0), 0) * 100) / 100,
        });
      } catch { return json(200, { allocations: [], total: 0 }); }
    }

    if (url.pathname === '/api/admin/savings' && method === 'GET' && isAdmin(email)) {
      try {
        const target = normalizeEmail(url.searchParams.get('email') || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        if (!target) return json(400, { error: 'Email required' });
        const { objects } = await listAll(env.tideventure_documents, { prefix: `savings/${target}/` });
        const entries = [];
        for (const o of objects) { try { entries.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
        entries.sort((a, b) => new Date(b.entryDate || b.createdAt) - new Date(a.entryDate || a.createdAt));
        return json(200, { entries, total: entries.reduce((s, e) => s + (Number(e.amount) || 0), 0) });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/savings' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const target = normalizeEmail(body.email || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        const amount = Math.round((Number(body.amount) || 0) * 100) / 100;
        if (!target || !(amount > 0)) return json(400, { error: 'Email and a positive amount are required' });
        const entry = {
          id: crypto.randomUUID(), clientEmail: target, amount,
          category: (body.category || 'other').slice(0, 40),
          description: (body.description || '').slice(0, 500),
          taxYear: Number(body.taxYear) || new Date().getFullYear(),
          entryDate: body.entryDate || new Date().toISOString().slice(0, 10),
          createdAt: new Date().toISOString(), createdBy: email,
        };
        await env.tideventure_documents.put(`savings/${target}/${entry.id}`, JSON.stringify(entry), { httpMetadata: { contentType: 'application/json' } });
        await insertSavingsD1(env, entry);
        await logAudit(env, 'SAVINGS', auditActor, `Logged $${amount} (${entry.category}) for ${target}`);
        return json(200, { ok: true, entry });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/savings/delete' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const target = normalizeEmail(body.email || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        if (!target || !body.id) return json(400, { error: 'email and id required' });
        await env.tideventure_documents.delete(`savings/${target}/${body.id}`).catch(() => {});
        try { await env.DB.prepare('DELETE FROM savings_entries WHERE id = ?').bind(body.id).run(); } catch {}
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // ── Document requests (admin CRUD) ──
    // The firm asks the client for specific documents; the portal shows the
    // checklist and whose court the ball is in. requested → submitted (client
    // says uploaded) → received (firm confirms), or waived.
    if (url.pathname === '/api/admin/doc-requests' && method === 'GET' && isAdmin(email)) {
      try {
        const target = normalizeEmail(url.searchParams.get('email') || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        if (!target) return json(400, { error: 'Email required' });
        const { objects } = await listAll(env.tideventure_documents, { prefix: `docrequest/${target}/` });
        const requests = [];
        for (const o of objects) { try { requests.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
        requests.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
        return json(200, { requests });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/doc-requests' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const target = normalizeEmail(body.email || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        const title = (body.title || '').trim().slice(0, 120);
        if (!target || !title) return json(400, { error: 'email and title required' });
        const reqRec = {
          id: crypto.randomUUID(), clientEmail: target, title,
          note: (body.note || '').slice(0, 300),
          status: 'requested', requestedAt: new Date().toISOString(), requestedBy: email,
        };
        await env.tideventure_documents.put(`docrequest/${target}/${reqRec.id}`, JSON.stringify(reqRec), { httpMetadata: { contentType: 'application/json' } });
        await insertDocRequestD1(env, reqRec);
        await logAudit(env, 'DOCREQ', auditActor, `Requested "${title}" from ${target}`);
        return json(200, { ok: true, request: reqRec });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/doc-requests/update' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const target = normalizeEmail(body.email || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        const allowed = ['requested', 'received', 'waived'];
        if (!target || !body.id || !allowed.includes(body.status)) return json(400, { error: 'email, id, and a valid status required' });
        const key = `docrequest/${target}/${body.id}`;
        const obj = await env.tideventure_documents.get(key);
        if (!obj) return json(404, { error: 'Request not found' });
        const reqRec = JSON.parse(await obj.text());
        reqRec.status = body.status;
        if (body.status === 'received') reqRec.receivedAt = new Date().toISOString();
        await env.tideventure_documents.put(key, JSON.stringify(reqRec), { httpMetadata: { contentType: 'application/json' } });
        await insertDocRequestD1(env, reqRec);
        return json(200, { ok: true, request: reqRec });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/doc-requests/delete' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const target = normalizeEmail(body.email || '');
        if (!target) return json(400, { error: 'Valid client email required' });
        if (!target || !body.id) return json(400, { error: 'email and id required' });
        await env.tideventure_documents.delete(`docrequest/${target}/${body.id}`).catch(() => {});
        try { await env.DB.prepare('DELETE FROM doc_requests WHERE id = ?').bind(body.id).run(); } catch {}
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: move a prospect through the sales pipeline
    if (url.pathname === '/api/admin/prospects/stage' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const allowed = ['new', 'contacted', 'proposal', 'lost'];
        if (!body.id || !allowed.includes(body.stage)) return json(400, { error: 'id and a valid stage required' });
        const key = `prospect/${body.id}`;
        const obj = await env.tideventure_documents.get(key);
        if (!obj) return json(404, { error: 'Prospect not found' });
        const p = JSON.parse(await obj.text());
        p.stage = body.stage;
        p.stageUpdatedAt = new Date().toISOString();
        await env.tideventure_documents.put(key, JSON.stringify(p), { httpMetadata: { contentType: 'application/json' } });
        await syncProspectToD1(env, p);
        return json(200, { ok: true, stage: body.stage });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: firm-wide KPIs, computed live from the current data
    if (url.pathname === '/api/admin/kpis' && method === 'GET' && isAdmin(email)) {
      try { return await handleKpis(env); } catch (e) { return json(500, { error: e.message }); }
    }
    // Scheduling link (for the portal's "Book a Call"): admin sets it in Settings
    if (url.pathname === '/api/scheduling-link' && method === 'GET') {
      if (!email) return json(401, { error: 'Not authenticated' });
      try {
        const obj = await env.tideventure_documents.get('settings/general.json');
        const s = obj ? JSON.parse(await obj.text()) : {};
        return json(200, { schedulingUrl: s.schedulingUrl || '' });
      } catch { return json(200, { schedulingUrl: '' }); }
    }
    if (url.pathname === '/api/admin/settings/general' && method === 'GET' && isAdmin(email)) {
      try {
        const obj = await env.tideventure_documents.get('settings/general.json');
        return json(200, obj ? JSON.parse(await obj.text()) : {});
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/settings/general' && method === 'PUT' && isAdmin(email)) {
      try {
        const body = await request.json();
        let url2 = (body.schedulingUrl || '').trim();
        if (url2 && !/^https?:\/\//i.test(url2)) url2 = 'https://' + url2;
        await env.tideventure_documents.put('settings/general.json', JSON.stringify({ schedulingUrl: url2, updatedAt: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } });
        return json(200, { ok: true, schedulingUrl: url2 });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Client: setup account (set password)
    if (url.pathname === '/api/setup-account' && method === 'GET') {
      const setupToken = url.searchParams.get('token');
      if (!setupToken) return json(400, { error: 'Token required' });
      try {
        const data = await setupTokenRead(env, setupToken);
        if (!data) return json(404, { error: 'Invalid or expired token' });
        // Enforce the 24h expiry the welcome email promises (R2 metadata TTL is inert)
        if (!data.createdAt || Date.now() - data.createdAt > 86400000) {
          await setupTokenDelete(env, setupToken);
          return json(410, { error: 'This setup link has expired. Please contact us for a new one.' });
        }
        const userObj = await env.tideventure_documents.get(`user/${data.email}`);
        const user = userObj ? JSON.parse(await userObj.text()) : {};
        return json(200, { email: data.email, businessName: user.businessName || data.email.split('@')[0], services: user.services || [], monthlyPrice: user.monthlyPrice || 0, yearlyPrice: user.yearlyPrice || 0 });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/setup-account' && method === 'POST') {
      try {
        const body = await request.json();
        const data = await setupTokenRead(env, body.token);
        if (!data) return json(404, { error: 'Invalid or expired token' });
        // Enforce the 24h expiry the welcome email promises (R2 metadata TTL is inert)
        if (!data.createdAt || Date.now() - data.createdAt > 86400000) {
          await setupTokenDelete(env, body.token);
          return json(410, { error: 'This setup link has expired. Please contact us for a new one.' });
        }
        if (!body.password || body.password.length < 10) return json(400, { error: 'Password must be at least 10 characters' });
        const key = `user/${data.email}`;
        const userObj = await env.tideventure_documents.get(key);
        let user = userObj ? JSON.parse(await userObj.text()) : {};
        user.password = await hashPassword(body.password, env);
        user.status = 'pending_engagement';
        await env.tideventure_documents.put(key, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, key.slice(5));
        await setupTokenDelete(env, body.token);
        // Create a JWT token so they're logged in after setup
        const jwt = await new SignJWT({ email: data.email, role: 'client', status: user.status }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('24h').sign(jwtKey(env));
        const keyMaterial = await deriveKeyMaterial(env.DOC_ENC_KEY, data.email);
        return json(200, { ok: true, token: jwt, keyMaterial, email: data.email });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Client: fetch their personalized engagement letter for signing
    if (url.pathname === '/api/engagement-letter' && method === 'GET') {
      if (!email) return json(401, { error: 'Not authenticated' });
      try {
        const letterText = await renderEngagementLetter(env, email);
        return json(200, { letterText, letterHash: await sha256Hex(letterText) });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Client: accept engagement letter
    if (url.pathname === '/api/accept-engagement' && method === 'POST') {
      if (!email) return json(401, { error: 'Not authenticated' });
      try {
        const body = await request.json();
        const signature = (body.signature || '').trim();
        if (!signature) return json(400, { error: 'Signature is required' });
        if (!body.consentEsign) return json(400, { error: 'You must consent to sign electronically' });

        // Re-render server-side so the stored record is exactly what the letter says today
        const letterText = await renderEngagementLetter(env, email);
        const letterHash = await sha256Hex(letterText);
        const signedAt = new Date().toISOString();
        const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
        const userAgent = request.headers.get('user-agent') || 'unknown';

        // Immutable evidence record
        const recordId = crypto.randomUUID();
        const record = { id: recordId, email, signature, consentEsign: true, signedAt, ip, userAgent, letterHash, letterText };
        await env.tideventure_documents.put(`engagement/${email}/${Date.now()}-${recordId}.json`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
        await insertEngagementD1(env, record);

        // Client-visible signed copy in their Documents tab (firm-issued, undeletable)
        const signedDateLabel = signedAt.slice(0, 10);
        const copyHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signed Engagement Letter — TideVenture CPA</title></head>
<body style="font-family:Georgia,serif;max-width:700px;margin:2rem auto;padding:0 1.5rem;color:#152430;line-height:1.7;">
<pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;">${letterText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
<hr style="margin:2rem 0;border:none;border-top:1px solid #ccc;"/>
<h3 style="font-family:Arial,sans-serif;font-size:14px;">ELECTRONICALLY SIGNED</h3>
<table style="font-family:Arial,sans-serif;font-size:13px;line-height:1.8;">
<tr><td style="padding-right:1.5rem;">Signed by:</td><td><strong>${signature.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</strong></td></tr>
<tr><td>Account email:</td><td>${email}</td></tr>
<tr><td>Date &amp; time (UTC):</td><td>${signedAt}</td></tr>
<tr><td>IP address:</td><td>${ip}</td></tr>
<tr><td>Document SHA-256:</td><td style="font-family:monospace;font-size:11px;">${letterHash}</td></tr>
</table>
<p style="font-family:Arial,sans-serif;font-size:11px;color:#777;margin-top:1.5rem;">The signer consented to conduct business electronically and to sign this agreement electronically, in accordance with the U.S. ESIGN Act and applicable state law. This copy was generated by the TideVenture CPA client portal at the time of signing.</p>
</body></html>`;
        // Encrypted like any other client document. It carries the signature,
        // the signer's IP and the agreement text, and it lands in the client's
        // document namespace — being firm-generated rather than uploaded is no
        // reason for it to sit in the clear.
        const letterCipher = await encryptWithWorkerKey(env.DOC_ENC_KEY, email, new TextEncoder().encode(copyHtml));
        await env.tideventure_documents.put(`${email}/${crypto.randomUUID()}`, letterCipher, {
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: { originalName: `Signed Engagement Letter — ${signedDateLabel}.html`, uploadedBy: email, source: 'firm', uploadedAt: signedAt, encrypted: 'true' },
        });

        const key = `user/${email}`;
        const obj = await env.tideventure_documents.get(key);
        let user = obj ? JSON.parse(await obj.text()) : {};
        // Only an account genuinely awaiting engagement may be promoted here.
        // Otherwise a deactivated client could re-activate themselves by
        // re-signing. (getAuthUser already blocks deactivated tokens, but this
        // is the authoritative guard on the state transition itself.)
        if (user.status && user.status !== 'pending_engagement') {
          return json(403, { error: 'This engagement letter has already been completed.' });
        }
        user.status = 'active';
        user.engagementAcceptedAt = signedAt;
        user.engagementSignature = signature;
        user.engagementLetterHash = letterHash;
        await env.tideventure_documents.put(key, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, key.slice(5));

        // Retire any prospect record(s) for this email — they've graduated to
        // a signed client, so they should no longer clutter the Prospects tab.
        // History is kept (not deleted), just excluded from the active list.
        try {
          const list = await listAll(env.tideventure_documents, { prefix: 'prospect/' });
          for (const o of list.objects) {
            const pObj = await env.tideventure_documents.get(o.key);
            if (!pObj) continue;
            const p = JSON.parse(await pObj.text());
            if ((p.email || '').toLowerCase() === email.toLowerCase() && p.status !== 'active') {
              p.status = 'active';
              p.clientActivatedAt = signedAt;
              await env.tideventure_documents.put(o.key, JSON.stringify(p), { httpMetadata: { contentType: 'application/json' } });
              await syncProspectToD1(env, p);
            }
          }
        } catch {}

        await logAudit(env, 'SIGN', auditActor, `Engagement letter signed (${letterHash.slice(0, 12)}…)`);
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }

    // ── Admin: User management ──
    if (url.pathname === '/api/admin/users' && isAdmin(email)) {
      if (method === 'GET') {
        try {
          const results = [];
          const list = await listAll(env.tideventure_documents);
          for (const obj of list.objects) {
            if (obj.key.startsWith('user/')) {
              try {
                const u = JSON.parse(await (await env.tideventure_documents.get(obj.key)).text());
                // Project to safe fields — never ship the password hash or the
                // stored e-signature to the browser.
                results.push({
                  email: u.email, role: u.role, businessName: u.businessName, contactName: u.contactName,
                  state: u.state, customerType: u.customerType, services: u.services, status: u.status,
                  monthlyPrice: u.monthlyPrice, yearlyPrice: u.yearlyPrice, createdAt: u.createdAt, deactivatedAt: u.deactivatedAt,
                });
              } catch {}
            }
          }
          return json(200, { users: results });
        } catch (e) { return json(500, { error: e.message }); }
      }
      if (method === 'PUT') {
        try {
          const body = await request.json();
          if (!body.email || !body.password) return json(400, { error: 'Email and password required' });
          const lower = normalizeEmail(body.email);
          if (!lower) return json(400, { error: 'Invalid email address' });
          // Merge onto any existing record — never overwrite wholesale. A blind
          // replace here would wipe services, pricing, dashboard cards, status,
          // and the e-signature evidence for an already-onboarded client.
          const existingObj = await env.tideventure_documents.get(`user/${lower}`);
          const existing = existingObj ? JSON.parse(await existingObj.text()) : {};
          const user = {
            ...existing,
            email: lower,
            password: await hashPassword(body.password, env),
            role: body.role || existing.role || 'client',
            businessName: body.businessName || existing.businessName || '',
            state: body.state || existing.state || '',
            createdAt: existing.createdAt || new Date().toISOString(),
          };
          await env.tideventure_documents.put(`user/${lower}`, JSON.stringify(user), { httpMetadata: { contentType: 'application/json' } }); await syncClientToD1(env, lower);
          return json(200, { ok: true });
        } catch (e) { return json(500, { error: e.message }); }
      }
    }
    if (url.pathname.match(/^\/api\/admin\/users\/[^\/]+$/) && method === 'DELETE' && isAdmin(email)) {
      try {
        const delEmail = decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
        await env.tideventure_documents.delete(`user/${delEmail}`);
        await rateDelete(env, `login/${delEmail}`);
        // Reads are D1-backed, so drop the mirror row too — otherwise the
        // deleted client persists in the roster and every KPI count.
        try { await env.DB.prepare('DELETE FROM clients WHERE email = ?').bind(delEmail).run(); } catch {}
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: clear rate limit for a user
    if (url.pathname === '/api/admin/ratelimit' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        const rlEmail = normalizeEmail(body.email);
        if (!rlEmail) return json(400, { error: 'Valid email required' });
        await rateDelete(env, `login/${rlEmail}`);
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }

    // ── PandaDoc Signing (external e-sign — the only signing path kept) ──
    // Admin sends an existing client document to PandaDoc for signature; the
    // in-app DIY signing flow was removed. No UI currently invokes this, but the
    // integration is kept intact so a "Send for e-sign" button can be re-added.
    if (url.pathname === '/api/admin/pandadoc-send' && method === 'POST' && isAdmin(email)) {
      try {
        const body = await request.json();
        if (!body.email || !body.documentId || !body.documentName) return json(400, { error: 'Missing fields' });
        if (!env.PANDADOC_API_KEY) return json(400, { error: 'PandaDoc not configured' });
        const targetEmail = normalizeEmail(body.email);
        if (!targetEmail) return json(400, { error: 'Valid recipient email required' });
        // The document id MUST be a uuid, and the object it names must be a real
        // client document (`<email>/<uuid>`). Without both checks this suffix
        // scan resolved any key ending in the supplied string — a documentId of
        // `victim@x.com` matched `user/victim@x.com`, and the matched object was
        // then read, wrapped as a PDF and MAILED to an address supplied in the
        // same request. The download and delete paths were hardened against this
        // in the August review; this route was missed.
        if (!isDocId(body.documentId)) return json(404, { error: 'Document not found' });
        const listResult = await listAll(env.tideventure_documents);
        let docKey = null;
        for (const obj of listResult.objects) {
          if (isClientDocKey(obj.key, body.documentId)) { docKey = obj.key; break; }
        }
        if (!docKey) return json(404, { error: 'Document not found' });
        const r2Doc = await env.tideventure_documents.get(docKey);
        if (!r2Doc) return json(404, { error: 'Document not found' });
        const docBuf = await r2Doc.arrayBuffer();
        // Try to decrypt if admin uploaded
        const uploader = docKey.split('/')[0];
        let pdfData;
        try { pdfData = await decryptWithWorkerKey(env.DOC_ENC_KEY, uploader, docBuf); }
        catch { pdfData = docBuf; }

        // Upload to PandaDoc with recipients
        const pdBody = JSON.stringify({
          name: body.documentName,
          recipients: [{ email: targetEmail, role: 'Client', signing_order: 1 }],
          parse_form_fields: false,
        });
        const boundary = '----BOUNDARY' + Math.random().toString(36).slice(2);
        const enc = new TextEncoder();
        const parts = [
          enc.encode('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + body.documentName.replace(/"/g, '') + '"\r\nContent-Type: application/pdf\r\n\r\n'),
          new Uint8Array(pdfData),
          enc.encode('\r\n'),
          enc.encode('--' + boundary + '\r\nContent-Disposition: form-data; name="data"\r\nContent-Type: application/json\r\n\r\n' + pdBody + '\r\n'),
          enc.encode('--' + boundary + '--\r\n'),
        ];
        const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) { combined.set(p, offset); offset += p.byteLength; }
        const createRes = await fetch('https://api.pandadoc.com/public/v1/documents', {
          method: 'POST',
          headers: { 'Authorization': `API-Key ${env.PANDADOC_API_KEY}`, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          body: combined.buffer,
        });
        if (!createRes.ok) { const err = await createRes.text(); return json(502, { error: 'PandaDoc upload failed: ' + err.slice(0, 300) }); }
        const pdDoc = await createRes.json();
        const pdId = pdDoc.id;
        // Wait for document to be processed (poll up to 10s)
        for (let i = 0; i < 20; i++) {
          const statusRes = await fetch(`https://api.pandadoc.com/public/v1/documents/${pdId}`, {
            headers: { 'Authorization': `API-Key ${env.PANDADOC_API_KEY}` },
          });
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.status === 'document.draft') break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
        // Send document
        const sendResp = await fetch(`https://api.pandadoc.com/public/v1/documents/${pdId}/send`, {
          method: 'POST',
          headers: { 'Authorization': `API-Key ${env.PANDADOC_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ silent: true }),
        });
        if (!sendResp.ok) { const sendErr = await sendResp.text(); return json(502, { error: 'PandaDoc send failed: ' + sendErr.slice(0, 200) }); }
        const sendData = await sendResp.json();
        // Extract shared link from recipient
        const recipient = (sendData.recipients || [])[0];
        const embedUrl = recipient?.shared_link || '';
        // Store the PandaDoc document ID
        await env.tideventure_documents.put(`pandadoc/${targetEmail}/${pdId}`, JSON.stringify({ documentName: body.documentName, sentAt: new Date().toISOString(), status: 'sent', sentBy: email, embedUrl }), { httpMetadata: { contentType: 'application/json' } });
        return json(200, { ok: true, pandadocId: pdId });
      } catch (e) { return json(500, { error: e.message }); }
    }

    // ── Admin Dashboard ──
    if (url.pathname === '/api/admin/dashboard' && method === 'GET' && isAdmin(email)) {
      try { return await handleAdminDashboard(env); } catch (e) { return json(500, { error: e.message }); }
    }

    // ── Tax Questionnaire ──
    const tqMatch = url.pathname.match(/^\/api\/questionnaire\/(\d{4})$/);
    if (tqMatch) {
      if (!email) return json(401, { error: 'Not authenticated' });
      const year = tqMatch[1];
      const key = `questionnaire/${email}/${year}`;
      if (method === 'GET') {
        try {
          const obj = await env.tideventure_documents.get(key);
          if (!obj) return json(200, { year, saved: false, data: null });
          const encrypted = await obj.arrayBuffer();
          try {
            const decrypted = await decryptQuestionnaire(env.DOC_ENC_KEY, email, encrypted);
            return json(200, { year, saved: true, data: JSON.parse(new TextDecoder().decode(decrypted)) });
          } catch {
            // Fallback for legacy unencrypted data
            return json(200, { year, saved: true, data: JSON.parse(await obj.text()) });
          }
        } catch (e) { return json(500, { error: e.message }); }
      }
      if (method === 'PUT' || method === 'POST') {
        try {
          const body = await request.json();
          if (!body || typeof body !== 'object') return json(400, { error: 'Invalid body' });
          const encrypted = await encryptQuestionnaire(env.DOC_ENC_KEY, email, new TextEncoder().encode(JSON.stringify(body)));
          await env.tideventure_documents.put(key, encrypted, { httpMetadata: { contentType: 'application/octet-stream' } });
          return json(200, { ok: true, year, saved: true });
        } catch (e) { return json(500, { error: 'Save failed: ' + e.message }); }
      }
    }
    // Admin: view a specific client's questionnaire response
    const adminViewMatch = url.pathname.match(/^\/api\/admin\/questionnaire\/view\/([^\/]+)\/(\d{4})$/);
    if (adminViewMatch && isAdmin(email)) {
      try {
        const viewEmail = decodeURIComponent(adminViewMatch[1]);
        const year = adminViewMatch[2];
        const obj = await env.tideventure_documents.get(`questionnaire/${viewEmail}/${year}`);
        if (!obj) return json(404, { error: 'Not found' });
        try {
          const encrypted = await obj.arrayBuffer();
          const decrypted = await decryptQuestionnaire(env.DOC_ENC_KEY, viewEmail, encrypted);
          return json(200, { email: viewEmail, year, answers: JSON.parse(new TextDecoder().decode(decrypted)) });
        } catch {
          return json(200, { email: viewEmail, year, answers: JSON.parse(await obj.text()) });
        }
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: list all questionnaire responses for a year
    if (url.pathname.match(/^\/api\/admin\/questionnaire\/\d{4}$/) && method === 'GET' && isAdmin(email)) {
      try {
        const year = url.pathname.split('/').pop();
        const results = [];
        const list = await listAll(env.tideventure_documents);
        for (const obj of list.objects) {
          const parts = obj.key.split('/');
          if (parts[0] === 'questionnaire' && parts[2] === year) {
            const data = await env.tideventure_documents.get(obj.key);
            if (data) {
              try {
                const buf = await data.arrayBuffer();
                const dec = await decryptQuestionnaire(env.DOC_ENC_KEY, parts[1], buf);
                results.push({ email: parts[1], answers: JSON.parse(new TextDecoder().decode(dec)) });
              } catch { results.push({ email: parts[1], answers: {} }); }
            }
          }
        }
        return json(200, { year, responses: results });
      } catch (e) { return json(500, { error: e.message }); }
    }
    // Admin: update questionnaire schema
    const schemaMatch = url.pathname.match(/^\/api\/questionnaire\/schema\/(\d{4})$/);
    if (schemaMatch) {
      const year = schemaMatch[1];
      const key = `questionnaire/schema/${year}`;
      if (method === 'GET') {
        try {
          const obj = await env.tideventure_documents.get(key);
          if (obj) return json(200, JSON.parse(await obj.text()));
          return json(200, DEFAULT_TQ_SCHEMA);
        } catch (e) { return json(500, { error: e.message }); }
      }
      if ((method === 'PUT' || method === 'POST') && isAdmin(email)) {
        try {
          await env.tideventure_documents.put(key, JSON.stringify(await request.json()), { httpMetadata: { contentType: 'application/json' } });
          return json(200, { ok: true });
        } catch (e) { return json(500, { error: e.message }); }
      }
    }

    const docMatch = url.pathname.match(/^\/api\/documents\/([^\/]+)$/);
    if (docMatch) {
      const docId = docMatch[1];
      // Auth via the session cookie (sent on top-level new-tab navigation) or
      // Bearer. No token in the URL — it would leak into browser history and
      // Cloudflare request logs, and this path also skipped the live-status check.
      const docEmail = email;
      if (!docEmail) return json(401, { error: 'Unauthorized' });
      if (method === 'GET') {
        try { return await handleDownloadDocument(env, docId, docEmail, isAdmin(docEmail), url.searchParams.has('view'), auditActor); } catch (e) { return json(500, { error: e.message }); }
      }
      if (method === 'DELETE') {
        try { return await handleDeleteDocument(env, docId, docEmail, isAdmin(docEmail), url.searchParams.get('purge') === '1', auditActor); } catch (e) { return json(500, { error: e.message }); }
      }
    }

    // ── Inject user data + key material into portal/admin pages ──
    const path = url.pathname.replace(/\.html$/, '');
    if (path === '/portal' || path === '/admin' || path === '/questionnaire' || path === '/admin-client' || url.pathname === '/portal.html' || url.pathname === '/admin.html' || url.pathname === '/questionnaire.html' || url.pathname === '/admin-client.html') {
      const response = await env.ASSETS.fetch(request);
      if (!email) return response;
      const keyMaterial = await deriveKeyMaterial(env.DOC_ENC_KEY, email);
      const html = await response.text();
      const data = { email, role: isAdmin(email) ? 'admin' : 'client', keyMaterial };
      const injected = html.replace('</head>', `<script>window.__PAGE_DATA__=${JSON.stringify(data)};</script></head>`);
      return new Response(injected, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/.git') || url.pathname.startsWith('/.wrangler') || url.pathname.startsWith('/node_modules')) {
      return new Response('Not found', { status: 404 });
    }

    // ── Admin: Regulatory updates ──
    if (url.pathname === '/api/admin/regulatory' && method === 'GET' && isAdmin(email)) {
      try { return await handleGetRegulatory(env); } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/regulatory/mark-read' && method === 'POST' && isAdmin(email)) {
      try { return await handleMarkRegulatoryRead(env); } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/regulatory/refresh' && method === 'POST' && isAdmin(email)) {
      try { return json(200, await fetchRegulatoryUpdates(env)); } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/regulatory/delete-item' && method === 'POST' && isAdmin(email)) {
      try {
        const { id } = await request.json();
        if (!id) return json(400, { error: 'id required' });
        await env.tideventure_documents.delete(`regulatory/items/${id}`);
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/regulatory/toggle-important' && method === 'POST' && isAdmin(email)) {
      try {
        const { id } = await request.json();
        if (!id) return json(400, { error: 'id required' });
        const key = `regulatory/items/${id}`;
        const obj = await env.tideventure_documents.get(key);
        if (!obj) return json(404, { error: 'Item not found' });
        const item = JSON.parse(await obj.text());
        item.important = !item.important;
        await env.tideventure_documents.put(key, JSON.stringify(item), { httpMetadata: { contentType: 'application/json' } });
        return json(200, { ok: true, important: item.important });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/regulatory/clear-source' && method === 'POST' && isAdmin(email)) {
      try {
        const { source } = await request.json();
        const list = await listAll(env.tideventure_documents, { prefix: 'regulatory/items/' });
        let deleted = 0;
        await Promise.all(list.objects.map(async obj => {
          try {
            const data = await env.tideventure_documents.get(obj.key);
            if (!data) return;
            const item = JSON.parse(await data.text());
            if (item.source === source) { await env.tideventure_documents.delete(obj.key); deleted++; }
          } catch {}
        }));
        return json(200, { ok: true, deleted });
      } catch (e) { return json(500, { error: e.message }); }
    }

    // ── Gmail OAuth (for MN regulatory emails) ──
    if (url.pathname === '/api/admin/gmail/auth' && method === 'GET') {
      // Auth via session cookie (sent on this top-level navigation) or Bearer —
      // no admin token in the URL.
      if (!isAdmin(email)) return json(403, { error: 'Admin access required' });
      return await handleGmailAuth(env);
    }
    // Reports which OAuth scopes are actually granted on the stored Gmail token —
    // useful because Google silently withholds scopes not registered on the
    // OAuth consent screen, even after a full reconnect.
    if (url.pathname === '/api/admin/gmail/status' && method === 'GET' && isAdmin(email)) {
      try {
        const tokens = await getGmailTokens(env);
        if (!tokens) return json(200, { connected: false });
        const refreshed = await refreshGmailTokenIfNeeded(env, tokens);
        const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(refreshed.access_token)}`);
        if (!info.ok) return json(200, { connected: true, scope: null, error: await info.text() });
        const data = await info.json();
        const scopes = (data.scope || '').split(' ').filter(Boolean);
        return json(200, {
          connected: true,
          scopes,
          hasReadonly: scopes.includes('https://www.googleapis.com/auth/gmail.readonly'),
          hasSend: scopes.includes('https://www.googleapis.com/auth/gmail.send'),
        });
      } catch (e) { return json(500, { error: e.message }); }
    }
    if (url.pathname === '/api/admin/gmail/callback' && method === 'GET') {
      return handleGmailCallback(request, env);
    }
    if (url.pathname === '/api/admin/gmail/disconnect' && method === 'POST' && isAdmin(email)) {
      await env.tideventure_documents.delete('gmail/tokens.json');
      return json(200, { ok: true });
    }

    return env.ASSETS.fetch(request);
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Regulatory update helpers ──

async function fetchRegulatoryUpdates(env) {
  const FETCHERS = [
    { key: 'irs-news', fn: fetchIrsNews },
    { key: 'irs-enews', fn: fetchIrsENews },
    { key: 'joa', fn: fetchJournalOfAccountancy },
    { key: 'mn-dor', fn: fetchMnDor },
    { key: 'tn-dor', fn: fetchTnDor },
    { key: 'ia-dor', fn: fetchIaDor },
  ];
  const sources = [];
  let totalStored = 0;
  // Always purge old website-scraped MN items before fetching fresh ones
  try {
    const allItems = await listAll(env.tideventure_documents, { prefix: 'regulatory/items/' });
    await Promise.all(allItems.objects.map(async obj => {
      try {
        const data = await env.tideventure_documents.get(obj.key);
        if (!data) return;
        const item = JSON.parse(await data.text());
        if (item.source === 'mn-dor' && !item.url.startsWith('https://mail.google.com')) {
          await env.tideventure_documents.delete(obj.key);
        }
        if (item.source === 'tn-dor' && !item.url.startsWith('https://tscpa.com')) {
          await env.tideventure_documents.delete(obj.key);
        }
        if (item.source === 'ia-dor' && !item.url.startsWith('https://mail.google.com')) {
          await env.tideventure_documents.delete(obj.key);
        }
      } catch {}
    }));
  } catch {}

  for (const { key, fn } of FETCHERS) {
    try {
      const items = await fn(env);
      let stored = 0;
      for (const item of items) {
        if (await storeRegulatoryItem(env, item)) stored++;
      }
      totalStored += stored;
      sources.push({ source: key, fetched: items.length, stored });
    } catch (e) {
      sources.push({ source: key, fetched: 0, stored: 0, error: e.message });
    }
  }
  return { ok: true, totalStored, sources };
}

async function storeRegulatoryItem(env, item) {
  if (!item.url) return false;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.url));
  const id = Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `regulatory/items/${id}`;
  if (await env.tideventure_documents.head(key)) return false;
  await env.tideventure_documents.put(key, JSON.stringify({ ...item, id, storedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return true;
}

async function handleGetRegulatory(env) {
  const list = await listAll(env.tideventure_documents, { prefix: 'regulatory/items/' });
  const items = [];
  await Promise.all(list.objects.map(async obj => {
    try {
      const data = await env.tideventure_documents.get(obj.key);
      if (data) items.push(JSON.parse(await data.text()));
    } catch {}
  }));
  items.sort((a, b) => new Date(b.date || b.storedAt) - new Date(a.date || a.storedAt));

  const seenObj = await env.tideventure_documents.get('regulatory/_seen.json');
  const seenIds = new Set(seenObj ? JSON.parse(await seenObj.text()) : []);
  const unseenCount = items.filter(i => !seenIds.has(i.id)).length;

  return json(200, { items, unseenCount });
}

async function handleMarkRegulatoryRead(env) {
  const list = await listAll(env.tideventure_documents, { prefix: 'regulatory/items/' });
  const ids = list.objects.map(o => o.key.split('/').pop());
  await env.tideventure_documents.put('regulatory/_seen.json', JSON.stringify(ids), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json(200, { ok: true });
}

async function fetchIrsNews(env) {
  try {
    const res = await fetch('https://www.irs.gov/rss-feeds/news-releases-for-current-month', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideVentureBot/1.0)' },
    });
    if (!res.ok) return [];
    return parseRSSItems(await res.text(), 'irs-news', 'IRS News Releases', null);
  } catch { return []; }
}

async function fetchJournalOfAccountancy(env) {
  try {
    const res = await fetch('https://www.journalofaccountancy.com/news/feed/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideVentureBot/1.0)' },
    });
    if (!res.ok) return [];
    return parseRSSItems(await res.text(), 'joa', 'Journal of Accountancy', null);
  } catch { return []; }
}

async function fetchIrsENews(env) {
  try {
    const res = await fetch('https://www.irs.gov/e-file-providers/e-news-for-tax-professionals', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideVentureBot/1.0)' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const items = [];
    const seen = new Set();
    // Look for links to individual newsletter issues
    const re = /<a\s[^>]*href="([^"]*(?:e-news|enews)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = m[1];
      const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 5 || seen.has(href)) continue;
      seen.add(href);
      const url = href.startsWith('http') ? href : `https://www.irs.gov${href}`;
      const dateMatch = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{1,2},?\s*20\d{2})/i.exec(text);
      const date = dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString();
      items.push({ source: 'irs-enews', sourceLabel: 'IRS e-News for Tax Professionals', state: null, title: text, url, date, summary: '' });
    }
    return items.slice(0, 15);
  } catch { return []; }
}

function parseRSSItems(xml, source, sourceLabel, state) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = rssTag(block, 'title');
    // Only accept http/https links — a feed value like javascript:… would
    // otherwise be rendered into an admin-page href.
    const link = safeHttpUrl(rssTag(block, 'link') || rssTag(block, 'guid'));
    const pubDate = rssTag(block, 'pubDate');
    const desc = rssTag(block, 'description').replace(/<[^>]+>/g, '').trim().slice(0, 400);
    if (title && link) {
      items.push({
        source, sourceLabel, state, title, url: link,
        date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        summary: desc,
      });
    }
  }
  return items;
}

function rssTag(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

async function fetchMnDor(env) {
  const tokens = await getGmailTokens(env);
  if (!tokens) return [];
  try {
    const refreshed = await refreshGmailTokenIfNeeded(env, tokens);
    const query = 'from:state.mn.us OR from:revenue.state.mn.us OR from:mnrevenue@public.govdelivery.com';
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`,
      { headers: { 'Authorization': `Bearer ${refreshed.access_token}` } }
    );
    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`Gmail list failed ${listRes.status}: ${errText.slice(0, 200)}`);
    }
    const { messages = [] } = await listRes.json();
    const items = [];
    for (const msg of messages) {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { 'Authorization': `Bearer ${refreshed.access_token}` } }
        );
        if (!msgRes.ok) continue;
        const data = await msgRes.json();
        const h = data.payload?.headers || [];
        const subject = h.find(x => x.name === 'Subject')?.value || '(no subject)';
        const from = h.find(x => x.name === 'From')?.value || '';
        const dateStr = h.find(x => x.name === 'Date')?.value || '';
        items.push({
          source: 'mn-dor',
          sourceLabel: 'MN Dept. of Revenue',
          state: 'MN',
          title: subject,
          url: `https://mail.google.com/mail/u/0/#all/${data.threadId}`,
          date: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
          summary: `From: ${from}${data.snippet ? ' — ' + data.snippet : ''}`.slice(0, 400),
        });
      } catch {}
    }
    return items;
  } catch (e) { return []; }
}

async function fetchTnDor(env) {
  try {
    const res = await fetch('https://tscpa.com/category/articles/tax-news/feed/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TideVentureBot/1.0)' },
    });
    if (!res.ok) return [];
    return parseRSSItems(await res.text(), 'tn-dor', 'TSCPA Tax News', 'TN');
  } catch (e) { return []; }
}

async function fetchIaDor(env) {
  const tokens = await getGmailTokens(env);
  if (!tokens) return [];
  try {
    const refreshed = await refreshGmailTokenIfNeeded(env, tokens);
    const query = 'from:iowa.gov OR from:public.govdelivery.com subject:"iowa"';
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`,
      { headers: { 'Authorization': `Bearer ${refreshed.access_token}` } }
    );
    if (!listRes.ok) return [];
    const { messages = [] } = await listRes.json();
    const items = [];
    for (const msg of messages) {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: { 'Authorization': `Bearer ${refreshed.access_token}` } }
        );
        if (!msgRes.ok) continue;
        const data = await msgRes.json();
        const h = data.payload?.headers || [];
        const subject = h.find(x => x.name === 'Subject')?.value || '(no subject)';
        const from = h.find(x => x.name === 'From')?.value || '';
        const dateStr = h.find(x => x.name === 'Date')?.value || '';
        items.push({
          source: 'ia-dor',
          sourceLabel: 'IA Dept. of Revenue',
          state: 'IA',
          title: subject,
          url: `https://mail.google.com/mail/u/0/#all/${data.threadId}`,
          date: dateStr ? new Date(dateStr).toISOString() : new Date().toISOString(),
          summary: `From: ${from}${data.snippet ? ' — ' + data.snippet : ''}`.slice(0, 400),
        });
      } catch {}
    }
    return items;
  } catch { return []; }
}

function scrapeNewsLinks(html, baseUrl, source, sourceLabel, state, patterns) {
  const items = [];
  const seen = new Set();
  const re = /<a\s[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 8 || text.length > 250) continue;
    if (!patterns.some(p => href.includes(p))) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const url = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
    // Extract year from URL for rough date ordering
    const yearMatch = /\/(20\d{2})\//.exec(href);
    const date = yearMatch ? new Date(parseInt(yearMatch[1]), 0, 1).toISOString() : new Date().toISOString();
    items.push({ source, sourceLabel, state, title: text, url, date, summary: '' });
  }
  return items.slice(0, 25);
}

// ── Gmail OAuth helpers ──

const GMAIL_REDIRECT_URI = 'https://tideventurecpa.com/api/admin/gmail/callback';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';

async function handleGmailAuth(env) {
  const state = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  // Persist state so the callback can verify the response is one we initiated
  // (CSRF protection). Mirrors the QuickBooks OAuth flow. Expires in 10 min.
  await env.tideventure_documents.put(`gmail/oauth/${state}`, JSON.stringify({ createdAt: Date.now() }), {
    httpMetadata: { contentType: 'application/json' },
  });
  const params = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    redirect_uri: GMAIL_REDIRECT_URI,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

async function handleGmailCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error || !code) {
    return new Response(`Gmail auth failed: ${error || 'no code'}`, { status: 400 });
  }
  // Verify state: it must match one we stored, and be under 10 minutes old.
  // Without this, anyone could POST an attacker-obtained code to this
  // unauthenticated callback and overwrite the firm's stored Gmail tokens.
  if (!state) return new Response('Missing OAuth state', { status: 400 });
  const stateKey = `gmail/oauth/${state}`;
  const storedState = await env.tideventure_documents.get(stateKey);
  if (!storedState) return new Response('OAuth state expired or invalid', { status: 400 });
  try {
    const { createdAt } = JSON.parse(await storedState.text());
    if (Date.now() - createdAt > 600000) {
      await env.tideventure_documents.delete(stateKey).catch(() => {});
      return new Response('OAuth state expired', { status: 400 });
    }
  } catch { return new Response('OAuth state invalid', { status: 400 }); }
  await env.tideventure_documents.delete(stateKey).catch(() => {});

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      redirect_uri: GMAIL_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return new Response(`Token exchange failed: ${await res.text()}`, { status: 500 });
  const tokens = await res.json();
  const encTokens = await encryptSecret(env, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry: Date.now() + (tokens.expires_in * 1000),
  }));
  await env.tideventure_documents.put('gmail/tokens.json', encTokens, { httpMetadata: { contentType: 'text/plain' } });
  return new Response('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="2;url=/admin"></head><body style="font-family:sans-serif;text-align:center;padding:3rem;"><h2>Gmail connected!</h2><p>Redirecting back to admin…</p></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
}

async function getGmailTokens(env) {
  const obj = await env.tideventure_documents.get('gmail/tokens.json');
  if (!obj) return null;
  const raw = await obj.text();
  try {
    // Try decrypting (new format); fall back to plaintext JSON for migration
    return JSON.parse(raw.startsWith('{') ? raw : await decryptSecret(env, raw));
  } catch { return null; }
}

async function refreshGmailTokenIfNeeded(env, tokens) {
  if (tokens.expiry && Date.now() < tokens.expiry - 60000) return tokens;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Gmail token refresh failed');
  const data = await res.json();
  const updated = { ...tokens, access_token: data.access_token, expiry: Date.now() + (data.expires_in * 1000) };
  const encUpdated = await encryptSecret(env, JSON.stringify(updated));
  await env.tideventure_documents.put('gmail/tokens.json', encUpdated, { httpMetadata: { contentType: 'text/plain' } });
  return updated;
}

// ── Master welcome-email template (editable from Admin → Settings) ──
const DEFAULT_WELCOME_TEMPLATE = {
  subject: 'Welcome to TideVenture CPA — Your Client Portal Is Ready',
  message: [
    'Dear {{firstName}},',
    '',
    "Welcome to TideVenture CPA. I'm glad you've chosen to work with us{{bizLine}}, and I look forward to serving as your trusted advisor.",
    '',
    'Your secure client portal is now ready. It will serve as our home base throughout the engagement — a private, encrypted space where you can share documents, complete your annual questionnaire, and review your services at any time.',
    '',
    'To activate your account, please use the link below:',
    '{{setupUrl}}',
    '',
    'A few things to note:',
    "  •  This activation link expires in 24 hours. If it lapses, just reply to this email and I'll send a new one.",
    "  •  After creating your password, you'll be asked to review and sign your engagement letter.",
    '  •  Everything you upload is encrypted and accessible only to you and our firm.',
    '',
    'If you have any questions at any point, reply directly to this email — it comes straight to my desk.',
  ].join('\n'),
};

function substituteTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

// ── Master engagement-letter template (editable from Admin → Settings) ──
const DEFAULT_ENGAGEMENT_TEMPLATE = {
  message: [
    'TideVenture CPA',
    'tideventurecpa.com  |  hello@tideventurecpa.com',
    '',
    'Date: {{date}}',
    'Client: {{businessName}}',
    '',
    'Re: Engagement Letter — Accounting, Tax, and Advisory Services',
    '',
    'Dear {{clientName}},',
    '',
    'We are pleased to confirm our engagement to provide accounting, tax preparation, and financial guidance services to you and/or your entity. This letter sets forth the terms and scope of our engagement. Please review it carefully and sign below.',
    '',
    'SCOPE OF SERVICES',
    'Our services will include, but are not limited to, the following:',
    '{{servicesList}}',
    '',
    'These services will be performed based solely on the information you provide to us. You represent that all information supplied is accurate, complete, and inclusive of all relevant facts. We will not independently verify the information you provide, though we may request additional clarification as needed. You are responsible for providing all information necessary for complete and accurate work product.',
    '',
    'FEE STRUCTURE',
    'In consideration of the services described above, the following fee schedule has been agreed upon:',
    '{{feeSchedule}}',
    '',
    'Please note that fees are subject to change in the event of a sizable increase in the volume, complexity, or scope of activity. We will provide you with reasonable advance written notice of any fee adjustment and will discuss the basis for such changes prior to implementation. Our goal is to ensure fees remain commensurate with the level of service and work required.',
    '',
    'CLIENT RESPONSIBILITIES',
    'To enable us to perform our services effectively, you agree to:',
    '  •  Provide all requested financial records, documents, and information in a timely manner',
    '  •  Retain all source documents, canceled checks, and supporting data that substantiate your income and deductions',
    '  •  Review all completed returns and financial reports carefully before signing or approving',
    '  •  Promptly inform us of any changes in your financial situation, ownership structure, or business operations that may affect our work',
    '',
    'For tax purposes, the standard filing deadline is April 15. To allow adequate time for preparation, please provide all tax-related information no later than March 25 each year. You bear final responsibility for your tax returns and should review them carefully before signing.',
    '',
    'TAX SERVICES: ADDITIONAL MATTERS',
    'Foreign Financial Accounts & Reporting. Any U.S. person or entity with a financial interest in, or signature authority over, foreign bank accounts, securities, or other financial accounts exceeding $10,000 must report these relationships to the U.S. Department of the Treasury. Failure to disclose may result in substantial civil and/or criminal penalties. If applicable, you may be required to file forms including Form 8938, FinCEN Form 114, Form 5471, Form 5472, Form 926, Forms 3520/3520-A, Form 8865, and others as necessary.',
    '',
    'IRS Audit Procedures. Your return may be selected for examination by tax authorities. In an audit, you may be required to produce documentation to substantiate income and deductions. Any proposed adjustments are subject to certain appeal rights. We are available to represent you in an audit upon request.',
    '',
    'Prior-Year Returns. If during our work we discover information that may affect prior-year tax returns, we will inform you. However, we cannot be responsible for identifying all such items. If you become aware of any such information, please contact us promptly.',
    '',
    'Tax Positions & Penalty Disclosure. We will discuss with you any tax positions that may carry increased penalty risk and any recommended disclosures prior to completing your return. If we conclude a disclosure is necessary and you refuse to permit it, we reserve the right to withdraw from the engagement.',
    '',
    'CONFIDENTIALITY',
    'We maintain internal policies, procedures, and safeguards to protect the confidentiality of your personal and financial information. In accordance with federal law, we will not disclose your information outside the United States, to another preparer for a second opinion, or to any third party for purposes other than performing our services, without first receiving your written consent.',
    '',
    'Certain tax-related communications may be legally privileged and not subject to IRS disclosure. By disclosing the contents of those communications to third parties or providing information about them to the government, you may waive that privilege. Please consult with us or your attorney before disclosing any information about our tax advice. If we receive a request for disclosure of privileged information — including a subpoena or IRS summons — we will notify you.',
    '',
    'ELECTRONIC COMMUNICATIONS',
    'We may communicate with you via email and through a secure web portal. Because emails can be intercepted or read by unintended third parties, we cannot guarantee delivery exclusively to the intended recipient. We specifically disclaim liability for any interception or unintentional disclosure of electronic communications in connection with this engagement, and you agree we have no liability for any resulting loss or damage, including consequential, incidental, direct, indirect, or special damages.',
    '',
    'Our use of a secure client portal is intended to reduce this risk. Your use of the portal must comply with our standards, and we reserve the right to limit or deny access for inappropriate use. While we make our best efforts to maintain security in accordance with applicable professional standards, you acknowledge and accept that we have no control over unauthorized interception of electronic communications once transmitted.',
    '',
    'RECORD RETENTION',
    'We retain records related to this engagement for three years. We do not retain your original source documents; these will be returned to you upon completion of each engagement. You are responsible for retaining and protecting your records thereafter for any future governmental or regulatory review. After our three-year retention period, we may destroy our engagement records.',
    '',
    'LIMITATIONS OF OUR SERVICES',
    'Our services do not include procedures designed to detect fraud, embezzlement, or other irregularities. We will prepare returns and financial information solely from the information you provide, without independent verification.',
    '',
    'We are not investment counselors or brokers. Any guidance we provide regarding a particular investment is limited to its tax implications and does not constitute advice on the economic viability of the investment or a recommendation to make it.',
    '',
    'Pursuant to Circular 230, any federal tax advice provided in this letter or arising from this engagement is not intended or written to be used, and cannot be used, to avoid penalties under the Internal Revenue Code or to promote, market, or recommend any plan or arrangement to another party.',
    '',
    'RIGHT TO WITHDRAW',
    'We reserve the right to withdraw from this engagement if you fail to provide requested information in a timely manner, refuse to cooperate with our reasonable requests, or misrepresent any material facts. Our withdrawal will release us from any obligation to complete work in progress and will constitute completion of our engagement.',
    '',
    'AGREEMENT',
    'By signing below, you acknowledge that you have read and agree to the terms of this engagement letter. This letter constitutes the entire agreement between us with respect to the services described herein.',
  ].join('\n'),
};

async function getEngagementTemplate(env) {
  try {
    const obj = await env.tideventure_documents.get('settings/engagement-letter.json');
    if (!obj) return DEFAULT_ENGAGEMENT_TEMPLATE;
    const saved = JSON.parse(await obj.text());
    if (!saved.message) return DEFAULT_ENGAGEMENT_TEMPLATE;
    return saved;
  } catch { return DEFAULT_ENGAGEMENT_TEMPLATE; }
}

const ENGAGEMENT_SERVICE_LINES = {
  tax: 'Preparation of your federal and applicable state business income tax returns',
  quarterly: 'Quarterly tax planning and estimated payment calculations',
  monthly: 'Monthly financial review and statements',
  bookkeeping: 'Monthly bookkeeping and financial statement maintenance',
  cfo: 'Fractional CFO advisory services as mutually agreed',
};

// Renders the engagement letter for a specific client from their user record.
async function renderEngagementLetter(env, email) {
  let user = {};
  const userObj = await env.tideventure_documents.get(`user/${email}`);
  if (userObj) { try { user = JSON.parse(await userObj.text()); } catch {} }
  const tmpl = await getEngagementTemplate(env);
  const services = user.services || [];
  const servicesList = (services.length
    ? services.map(s => `  •  ${ENGAGEMENT_SERVICE_LINES[s] || s}`)
    : ['  •  Accounting, tax, and advisory services as mutually agreed']
  ).concat('  •  Ongoing financial guidance and advisory services as mutually agreed').join('\n');
  const feeLines = [];
  if (user.monthlyPrice > 0) feeLines.push(`  •  Monthly fee: $${Number(user.monthlyPrice).toLocaleString('en-US')} per month`);
  if (user.yearlyPrice > 0) feeLines.push(`  •  Annual total: $${Number(user.yearlyPrice).toLocaleString('en-US')} per year`);
  if (!feeLines.length) feeLines.push('  •  Fees as separately agreed in writing');
  const letterText = substituteTemplate(tmpl.message, {
    date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    clientName: user.contactName || user.businessName || email.split('@')[0],
    businessName: user.businessName || email.split('@')[0],
    email,
    servicesList,
    feeSchedule: feeLines.join('\n'),
  });
  return letterText;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}

async function getWelcomeEmailTemplate(env) {
  try {
    const obj = await env.tideventure_documents.get('settings/welcome-email.json');
    if (!obj) return DEFAULT_WELCOME_TEMPLATE;
    const saved = JSON.parse(await obj.text());
    if (!saved.subject || !saved.message) return DEFAULT_WELCOME_TEMPLATE;
    return saved;
  } catch { return DEFAULT_WELCOME_TEMPLATE; }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Renders admin-edited plain text into the branded email shell (header + logo
// signature + footer are fixed; only the message body is caller-supplied).
// Labels for the machine-readable values the pricing tool stores on a lead, so
// the notification email reads like the admin panel rather than like a database row.
const ENTITY_LABELS = { scorp: 'S-Corp', ccorp: 'C-Corp', partnership: 'Partnership', mmllc: 'Multi-Member LLC', smllc: 'Single-Member LLC', soleprop: 'Sole Proprietor' };
const SERVICE_LABELS = { tax: 'Business Tax Return', quarterly: 'Quarterly Planning & Estimated Payments', cfo: 'Fractional CFO', bookkeeping: 'Bookkeeping & Financial Statements', monthly: 'Monthly Financial Review', other: 'Other / Custom' };
const REVENUE_LABELS = { under500k: 'Under $500,000', '500k1m': '$500,000 – $1,000,000', '1m5m': '$1,000,000 – $5,000,000', over5m: 'Over $5,000,000' };

// Email the firm when a lead comes in through the public form. Without this a
// submission lands in R2/D1 and nothing surfaces it until someone happens to
// open the Prospects tab — which is how a lead goes cold over a weekend.
async function sendProspectNotification(env, p) {
  const to = (env.NOTIFY_EMAIL || (env.ADMIN_EMAILS || 'isaac@tideventurecpa.com').split(',')[0] || '').trim();
  if (!to) return;
  const line = (label, value) => (value ? `${label}: ${value}\n` : '');
  const services = (p.services || []).map(s => SERVICE_LABELS[s] || s).join(', ');
  const cfo = (p.cfoServices || []).join(', ');
  const where = [p.city, p.state].filter(Boolean).join(', ');
  const text =
    `New lead from the website.\n\n` +
    (p.verified ? '' : 'NOTE: this submission did not pass the automated human check. It may be spam, or the visitor may simply have an ad blocker or privacy browser. Worth a look before you reply.\n\n') +
    line('Name', p.name) +
    line('Business', p.businessName) +
    line('Email', p.email) +
    line('Phone', p.phone) +
    line('Location', where) +
    line('Entity', ENTITY_LABELS[p.entityType] || p.entityType) +
    line('Revenue', REVENUE_LABELS[p.revenue] || p.revenue) +
    line('Owners/members', p.members) +
    line('Services', services) +
    line('CFO focus', cfo) +
    (p.notes ? `\nWhat they wrote:\n${p.notes}\n` : '') +
    `\nOpen the Prospects tab to respond:\nhttps://tideventurecpa.com/admin`;
  await sendGmailEmail(env, {
    to,
    subject: `${p.verified ? '' : '[unverified] '}New lead: ${p.name || p.email}${p.businessName ? ' — ' + p.businessName : ''}`,
    text: `${text}\n\nTideVenture CPA\ntideventurecpa.com`,
    html: renderWelcomeEmailHtml(text, to, 'You are receiving this because a visitor submitted the Get Started form on tideventurecpa.com.'),
  });
}

function renderWelcomeEmailHtml(messageText, toEmail, footerNote) {
  const bodyHtml = messageText.split(/\n\s*\n/).map(para => {
    const linked = escapeHtml(para).replace(/\n/g, '<br/>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#167f9e;">$1</a>');
    return `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:#42566a;margin:0 0 14px;">${linked}</p>`;
  }).join('\n');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e4e7eb;">
  <tr><td style="background-color:#0d3d5a;padding:26px 40px;">
    <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#ffffff;font-weight:bold;">Tide<span style="font-weight:normal;color:#7fc0d8;">Venture</span></span>
    <span style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#9db8c8;letter-spacing:3px;"> &nbsp;CPA</span>
  </td></tr>
  <tr><td style="padding:36px 40px 8px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:10px 40px 34px;">
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#42566a;margin:0 0 16px;">Warm regards,</p>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#152430;margin:0;font-weight:bold;">Isaac Frisch, CPA</p>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7b8b9a;margin:2px 0 14px;">TideVenture CPA &nbsp;&middot;&nbsp; <a href="https://tideventurecpa.com" style="color:#167f9e;text-decoration:none;">tideventurecpa.com</a></p>
    <img src="https://tideventurecpa.com/images/logo.png" alt="TideVenture CPA" width="150" style="display:block;width:150px;height:auto;border:0;" />
  </td></tr>
  <tr><td style="background-color:#f8f9fa;border-top:1px solid #edf0f2;padding:16px 40px;">
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#9aa8b5;margin:0;line-height:1.6;">${footerNote ? escapeHtml(footerNote) : `This message was sent to ${escapeHtml(toEmail)} because an account was created for you at TideVenture CPA. If you received it in error, please disregard it.`}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 encoded-word for non-ASCII header values (e.g. Subject). Plain
// UTF-8 bytes dropped straight into a header are only valid ASCII per RFC
// 2822; without this, an em dash (or any non-ASCII character) shows up as
// mojibake once any hop along the way assumes Latin-1/Windows-1252.
function encodeMimeHeader(str) {
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

// Sends an email from the connected Gmail account (requires gmail.send scope —
// throws if the current token was authorized before that scope was added).
// When html is provided the message is multipart/alternative with a plain-text fallback.
async function sendGmailEmail(env, { to, subject, text, html }) {
  const tokens = await getGmailTokens(env);
  if (!tokens) throw new Error('Gmail not connected');
  const refreshed = await refreshGmailTokenIfNeeded(env, tokens);
  const encodedSubject = encodeMimeHeader(subject);
  let message;
  if (html) {
    const boundary = 'tv-' + crypto.randomUUID();
    message = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      html,
      '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    message = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      text,
    ].join('\r\n');
  }
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${refreshed.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: toBase64Url(message) }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail send failed ${res.status}: ${errText.slice(0, 300)}`);
  }
  return true;
}

async function logAudit(env, action, email, detail) {
  const entry = { action, email, detail, timestamp: new Date().toISOString() };
  const key = `audit/${Date.now()}-${crypto.randomUUID()}`;
  await env.tideventure_documents.put(key, JSON.stringify(entry), { httpMetadata: { contentType: 'application/json' } });
  await insertAuditD1(env, entry); // dual-write to D1 (wrapped; failure is non-fatal)
}

// Turn a raw upload filename into a clean display label: drop the extension,
// underscores → spaces, and capitalize words — so "engagement_letter_signed.pdf"
// shows as "Engagement Letter Signed". Hyphens are kept so tax forms like W-2 and
// 1099-NEC aren't mangled, and existing capitals/acronyms are preserved. The real
// filename (with extension) is still used for the actual download.
function prettifyDocName(name) {
  if (!name) return 'Document';
  let n = String(name).replace(/\.(pdf|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|webp|heic|zip|html?)$/i, '');
  n = n.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/\b[a-z]/g, c => c.toUpperCase());
  // Restore common all-caps business/tax acronyms that title-casing lowercased.
  n = n.replace(/\b(llc|llp|pllc|ein|ssn|irs|ira|hsa|cpa)\b/gi, m => m.toUpperCase());
  return n || 'Document';
}

async function handleListDocuments(env, email, admin) {
  const objects = [];
  const result = await listAll(env.tideventure_documents, { include: ['customMetadata', 'httpMetadata'] });
  for (const obj of result.objects) {
    // A client document is EXACTLY `<email>/<uuid>`. This used to be a blocklist
    // of internal prefixes, which meant every new record type leaked into the
    // documents list until someone remembered to add it — taxproj/ and
    // taxentity/ both did. Testing the shape instead excludes anything new by
    // default, which is the right way round for a list of client files.
    const parts = obj.key.split('/');
    if (!(parts.length === 2 && parts[0].includes('@') && isDocId(parts[1]))) continue;
    if (admin || obj.customMetadata?.uploadedBy === email) {
      const storedName = obj.customMetadata?.originalName || obj.key;
      const name = storedName.replace(/\.enc$/, '');
      objects.push({
        id: parts[1],
        name,                              // real filename — used for downloads
        displayName: prettifyDocName(name), // clean label — used for display
        size: obj.size,
        uploaded: obj.uploaded,
        uploadedBy: obj.customMetadata?.uploadedBy,
        source: obj.customMetadata?.source || 'client',
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
        // Stated by the server from what is actually stored. The browser used to
        // infer this from the filename, but the name is stripped of .enc before
        // it is sent — so the check could never be true and every document was
        // labelled unencrypted, including the ones that had just been encrypted.
        encrypted: obj.customMetadata?.encrypted === 'true' || storedName.endsWith('.enc'),
        key: admin ? obj.key : undefined,
      });
    }
  }
  objects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return json(200, { documents: objects });
}

// ── Dashboard data for clients ──
// Known dashboard cards: taxStatus, deadlines, revenue. A client's visible set
// lives in user.dashboardCards; when unset it is derived from their services.
function defaultDashboardCards(services) {
  const s = services || [];
  const cards = [];
  if (s.includes('tax') || s.includes('quarterly')) cards.push('taxStatus', 'deadlines');
  if (s.includes('bookkeeping') || s.includes('cfo')) cards.push('revenue');
  return cards;
}

const ESTIMATED_PAYMENT_DATES = [
  { month: 4, day: 15, label: '1st Quarter Estimated Payment' },
  { month: 6, day: 15, label: '2nd Quarter Estimated Payment' },
  { month: 9, day: 15, label: '3rd Quarter Estimated Payment' },
  { month: 1, day: 15, label: '4th Quarter Estimated Payment (prior year)' },
];

function getNextEstimatedPayment() {
  const now = new Date();
  const currentYear = now.getFullYear();
  for (const ep of ESTIMATED_PAYMENT_DATES) {
    const year = ep.month >= 4 ? currentYear : currentYear + 1;
    const due = new Date(year, ep.month - 1, ep.day);
    if (due > now) return { date: due.toISOString().slice(0, 10), label: ep.label + ' due' };
  }
  return null;
}

async function handleDashboard(env, email) {
  // Load client profile
  let clientState = null;
  let profileData = {};
  const profileKey = `profile/${email}`;
  const profileObj = await env.tideventure_documents.get(profileKey);
  if (profileObj) {
    try { profileData = JSON.parse(await profileObj.text()); clientState = profileData.state; } catch {}
  }
  // The user record (written at conversion/settings-save) is authoritative for
  // services, pricing, and dashboard card visibility; profile/ may lag behind it.
  let userData = {};
  const userObj = await env.tideventure_documents.get(`user/${email}`);
  if (userObj) { try { userData = JSON.parse(await userObj.text()); } catch {} }
  // State can live on either record — conversion writes it to user/, manual
  // profile edits write it to profile/. Prefer whichever has it so the state
  // tax-deadline card actually shows for prospect-converted clients.
  clientState = userData.state || profileData.state || null;
  const services = userData.services || profileData.services || [];
  const cards = Array.isArray(userData.dashboardCards) ? userData.dashboardCards : defaultDashboardCards(services);

  const showDeadlines = cards.includes('deadlines');
  const stateDeadline = showDeadlines ? getStateDeadline(clientState) : null;
  const qbo = await getQboDashboardData(env, email);

  // Tax Savings Ledger — entries the firm logged for this client.
  const savingsEntries = [];
  try {
    const { objects } = await listAll(env.tideventure_documents, { prefix: `savings/${email}/` });
    for (const o of objects) { try { savingsEntries.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
    savingsEntries.sort((a, b) => new Date(b.entryDate || b.createdAt) - new Date(a.entryDate || a.createdAt));
  } catch {}
  const savingsTotal = savingsEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // Outstanding document requests (drives the checklist + action items).
  const docRequests = [];
  try {
    const { objects } = await listAll(env.tideventure_documents, { prefix: `docrequest/${email}/` });
    for (const o of objects) { try { docRequests.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
    docRequests.sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  } catch {}

  return json(200, {
    cards,
    // Real per-client statuses only — set by the firm on the user record; new clients start empty
    taxStatuses: cards.includes('taxStatus') ? (userData.taxStatuses || []) : [],
    deadlines: showDeadlines && getNextEstimatedPayment() ? [getNextEstimatedPayment()] : [],
    stateDeadline: stateDeadline ? [stateDeadline] : [],
    profile: {
      state: clientState,
      businessName: userData.businessName || profileData.businessName || '',
      services,
      monthlyPrice: userData.monthlyPrice ?? profileData.monthlyPrice ?? 0,
      yearlyPrice: userData.yearlyPrice ?? profileData.yearlyPrice ?? 0,
    },
    qbo,
    savings: { total: Math.round(savingsTotal * 100) / 100, entries: savingsEntries.slice(0, 25) },
    docRequests,
    questionnaireYear: CURRENT_TAX_YEAR,
    questionnaireOpensAt: new Date(QUESTIONNAIRE_OPENS_AT).toISOString(),
  });
}

// ── State estimated payment deadlines ──
const STATE_DEADLINES = {
  // Follows federal (4/15, 6/15, 9/15, 1/15)
  AL: 'federal', AR: 'federal', AZ: 'federal', CA: 'federal',
  CO: 'federal', CT: 'federal', DC: 'federal', DE: 'federal', GA: 'federal',
  HI: 'federal', IA: 'federal', ID: 'federal', IL: 'federal', IN: 'federal',
  KS: 'federal', KY: 'federal', LA: 'federal', MA: 'federal', MD: 'federal',
  ME: 'federal', MI: 'federal', MN: 'federal', MO: 'federal', MS: 'federal',
  MT: 'federal', NC: 'federal', ND: 'federal', NE: 'federal',
  NJ: 'federal', NM: 'federal', NY: 'federal', OH: 'federal', OK: 'federal',
  OR: 'federal', PA: 'federal', RI: 'federal', SC: 'federal', UT: 'federal',
  VA: 'federal', VT: 'federal', WI: 'federal', WV: 'federal',
  // No state income tax
  AK: 'none', FL: 'none', NV: 'none', SD: 'none', TN: 'none', TX: 'none',
  WA: 'none', WY: 'none', NH: 'none',
};

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

function getStateDeadline(state) {
  if (!state || !STATE_DEADLINES[state]) return null;
  const rule = STATE_DEADLINES[state];
  if (rule === 'none') return { label: `${STATE_NAMES[state]} has no state income tax`, noTax: true };
  if (rule === 'federal') {
    const fed = getNextEstimatedPayment();
    if (!fed) return null;
    return { ...fed, label: `${STATE_NAMES[state]} Estimated Payment — ` + fed.label };
  }
  return null;
}

// ── Client profile ──
async function handleGetProfile(env, email) {
  const key = `profile/${email}`;
  const obj = await env.tideventure_documents.get(key);
  if (!obj) return json(200, { state: null, businessName: email.split('@')[0], ein: '', customerType: null });
  const body = await obj.text();
  try { return json(200, JSON.parse(body)); } catch { return json(200, { state: null }); }
}

async function handleUpdateProfile(request, env, email, admin) {
  const data = await request.json();
  const targetEmail = (admin && data.email) ? data.email : email;
  const key = `profile/${targetEmail}`;
  // Only admin can change state and customerType
  if ((data.state || data.customerType) && !admin) return json(403, { error: 'Admin access required' });
  const existing = await env.tideventure_documents.get(key);
  let profile = {};
  if (existing) { try { profile = JSON.parse(await existing.text()); } catch {} }
  // Allowlist assignable fields — NOT Object.assign(profile, data). Firm-owned
  // fields (services, monthlyPrice, yearlyPrice, status, dashboardCards, role)
  // must never be settable here: a client could otherwise write a fake price
  // that syncClientToD1 merges into the D1 clients row and poisons firm MRR/ARR.
  const CLIENT_FIELDS = ['businessName', 'contactName', 'phone', 'ein', 'address'];
  const allowed = admin ? [...CLIENT_FIELDS, 'state', 'customerType'] : CLIENT_FIELDS;
  for (const f of allowed) { if (f in data) profile[f] = data[f]; }
  await env.tideventure_documents.put(key, JSON.stringify(profile), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json(200, profile);
}

async function handleUploadDocument(request, env, email, actor = email) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json(400, { error: 'No file provided' });
  const id = crypto.randomUUID();
  const key = `${email}/${id}`;
  await env.tideventure_documents.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name, uploadedBy: email, uploadedAt: new Date().toISOString() },
  });
  await logAudit(env, 'UPLOAD', actor, `${file.name} (${file.size} bytes)`);
  return json(201, { id, key, name: file.name });
}

// Client documents live at exactly `<email>/<uuid>`. These two helpers keep the
// document routes from ever resolving a docId to another namespace's object.
const DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isDocId(id) { return typeof id === 'string' && DOC_ID_RE.test(id); }
function isClientDocKey(key, docId) {
  const parts = key.split('/');
  return parts.length === 2 && parts[0].includes('@') && parts[1] === docId;
}

async function handleDownloadDocument(env, docId, email, admin, viewMode, actor = email) {
  // docId must be a UUID and the object must be a real client-document key
  // (exactly `<email>/<uuid>`). Without this, a docId of `victim@x.com` matched
  // `user/victim@x.com` / `profile/victim@x.com` on the suffix scan, turning this
  // into a raw cross-namespace read (plaintext PII, even the password hash).
  if (!isDocId(docId)) return json(404, { error: 'Document not found' });
  let found = null;
  const result = await listAll(env.tideventure_documents, { include: ['customMetadata', 'httpMetadata'] });
  for (const obj of result.objects) {
    if (!isClientDocKey(obj.key, docId)) continue;
    found = obj; break;
  }
  if (!found) return json(404, { error: 'Document not found' });

  const uploader = found.customMetadata?.uploadedBy;
  if (!admin && uploader !== email) return json(403, { error: 'Forbidden' });
  const object = await env.tideventure_documents.get(found.key);
  if (!object) return json(404, { error: 'Document not found' });
  await logAudit(env, 'DOWNLOAD', actor, found.customMetadata?.originalName || docId);
  const origName = (found.customMetadata?.originalName || docId).replace(/\.enc$/, '');
  const EXT_MAP = { 'pdf':'application/pdf','jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif','webp':'image/webp','mp4':'video/mp4','doc':'application/msword','docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','xls':'application/vnd.ms-excel','xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','txt':'text/plain','csv':'text/csv' };
  const fileExt = origName.split('.').pop().toLowerCase();
  const contentType = viewMode ? (EXT_MAP[fileExt] || 'application/octet-stream') : 'application/octet-stream';
  const disposition = viewMode ? 'inline' : `attachment`;
  const headers = { 'Content-Type': contentType, 'Content-Disposition': `${disposition}; filename="${origName}"`, 'Cache-Control': 'private, max-age=3600' };
  // Read body once, serve it whether decrypted or raw
  const rawBuf = await object.arrayBuffer();
  // Try to decrypt admin downloads, fall back to raw
  if (admin) {
    try {
      const plaintext = await decryptWithWorkerKey(env.DOC_ENC_KEY, uploader || email, rawBuf);
      return new Response(plaintext, { headers });
    } catch { /* serve raw */ }
  }
  // Whether a document is encrypted is a stored fact, not a guess from its
  // name. Files written before the flag existed still carry the .enc suffix,
  // so both are honoured — but a name alone must never be enough to decide to
  // serve bytes raw, which is how ciphertext ends up rendered as a page.
  const isEncrypted = object.customMetadata?.encrypted === 'true' || origName.endsWith('.enc');
  if (viewMode && !isEncrypted) {
    // Show inline if decrypted or unencrypted
    return new Response(rawBuf, { headers });
  }
  if (viewMode) {
    // Cannot preview encrypted document
    return new Response('This document is encrypted and cannot be previewed inline. Use Download instead.', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response(rawBuf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${origName}"`, 'Cache-Control': 'private, max-age=3600' } });
}

// Backups are additive on purpose: a deletion in the live bucket never
// propagates, so an accidental delete is recoverable. That protection has a
// cost — a document deleted after a backup has run is retained there
// indefinitely, and nothing in the app could remove it. Purging is therefore a
// SEPARATE, admin-only, explicitly-confirmed action rather than a change to how
// deletion works: the safety net stays, and there is now a deliberate way to
// cut it when deletion genuinely has to be final.
//
// Constrained to real client-document keys (`<email>/<uuid>`) so a purge can
// never reach settings, audit entries, or any other backed-up record.
async function purgeFromBackups(env, keys) {
  if (!env.tideventure_backups) return { purged: 0, skipped: keys.length, error: 'Backup bucket not bound' };
  let purged = 0, skipped = 0;
  for (const key of keys) {
    const parts = String(key).split('/');
    const looksLikeClientDoc = parts.length === 2 && parts[0].includes('@') && isDocId(parts[1]);
    if (!looksLikeClientDoc) { skipped++; continue; }
    try { await env.tideventure_backups.delete(key); purged++; } catch { skipped++; }
  }
  return { purged, skipped };
}

async function handleDeleteDocument(env, docId, email, admin, purge = false, actor = email) {
  if (!isDocId(docId)) return json(404, { error: 'Document not found' });
  let found = null;
  const listResult = await listAll(env.tideventure_documents, { include: ['customMetadata', 'httpMetadata'] });
  for (const obj of listResult.objects) {
    if (!isClientDocKey(obj.key, docId)) continue;
    found = obj; break;
  }
  if (!found) return json(404, { error: 'Document not found' });
  // Allow admin or the document owner to delete; firm-issued documents are admin-only
  const uploader = found.customMetadata?.uploadedBy;
  if (!admin && uploader !== email) return json(403, { error: 'Forbidden' });
  if (!admin && found.customMetadata?.source === 'firm') return json(403, { error: 'Documents from your CPA cannot be deleted' });
  const name = found.customMetadata?.originalName || docId;
  await env.tideventure_documents.delete(found.key);
  // Purging is admin-only even though a client may delete their own document:
  // reaching into the firm's backups is a different act from removing a file
  // from your own portal.
  let purged = null;
  if (purge && admin) {
    purged = await purgeFromBackups(env, [found.key]);
    await logAudit(env, 'PURGE', actor, `${name} removed from backups`);
  }
  await logAudit(env, 'DELETE', actor, name);
  return json(200, { success: true, purged });
}

async function handleAdminDashboard(env) {
  const clients = [];
  const adminEmail = 'admin@tideventurecpa.com';

  // Build the normalized client roster. D1 already holds the merged user+profile
  // row (rowToClient), so it's a single query; the R2 path reconstructs the same
  // shape by merging profile/ with the authoritative user/ record.
  let roster = null;
  if (env.D1_READS !== 'off') {
    try {
      roster = (await env.DB.prepare('SELECT * FROM clients').all()).results
        .map(rowToClient)
        .filter(c => c.email && c.email !== adminEmail);
    } catch { roster = null; }
  }
  // One list pass powers both the R2 fallback roster and the per-client doc counts.
  const listResult = await listAll(env.tideventure_documents);
  if (!roster) {
    const allEmails = new Set();
    for (const obj of listResult.objects) {
      if (obj.key.startsWith('user/')) {
        try { allEmails.add(JSON.parse(await (await env.tideventure_documents.get(obj.key)).text()).email); } catch {}
      }
    }
    if (!allEmails.size) {
      const legacy = JSON.parse(env.USERS_JSON || '{}');
      for (const email of Object.keys(legacy)) allEmails.add(email);
    }
    roster = [];
    for (const email of allEmails) {
      if (email === adminEmail) continue;
      let profile = {};
      const profileObj = await env.tideventure_documents.get(`profile/${email}`);
      if (profileObj) { try { profile = JSON.parse(await profileObj.text()); } catch {} }
      try {
        const uObj = await env.tideventure_documents.get(`user/${email}`);
        if (uObj) {
          const u = JSON.parse(await uObj.text());
          profile = {
            ...profile,
            businessName: u.businessName || profile.businessName,
            services: u.services || profile.services,
            state: u.state || profile.state,
            dashboardCards: Array.isArray(u.dashboardCards) ? u.dashboardCards : profile.dashboardCards,
            monthlyPrice: u.monthlyPrice ?? profile.monthlyPrice,
            yearlyPrice: u.yearlyPrice ?? profile.yearlyPrice,
            customerType: u.customerType || profile.customerType,
            status: u.status || profile.status,
            taxStatuses: Array.isArray(u.taxStatuses) ? u.taxStatuses : (profile.taxStatuses || []),
          };
        }
      } catch {}
      roster.push({
        email, businessName: profile.businessName, services: profile.services, state: profile.state,
        dashboardCards: profile.dashboardCards, monthlyPrice: profile.monthlyPrice, yearlyPrice: profile.yearlyPrice,
        customerType: profile.customerType, status: profile.status, taxStatuses: profile.taxStatuses,
      });
    }
  }

  // Doc counts: one pass over the already-fetched listing (no per-client listAll).
  const docCounts = {};
  for (const obj of listResult.objects) {
    const slash = obj.key.indexOf('/');
    if (slash > 0 && obj.key.slice(0, slash).includes('@')) {
      const owner = obj.key.slice(0, slash);
      docCounts[owner] = (docCounts[owner] || 0) + 1;
    }
  }

  // QBO outstanding balances: a single roll-up (email → balance) written by the
  // nightly sync (runQboSync). One GET for the whole roster.
  let qboBalances = {};
  try {
    const bObj = await env.tideventure_documents.get('qbo/balances');
    if (bObj) qboBalances = JSON.parse(await bObj.text());
  } catch {}

  for (const rec of roster) {
    const email = rec.email;
    if (email === adminEmail) continue;

    let qStatus = 'not_started';
    const qObj = await env.tideventure_documents.get(`questionnaire/${email}/${CURRENT_TAX_YEAR}`);
    if (qObj) {
      try {
        const answers = JSON.parse(await qObj.text());
        qStatus = answers.final_signature ? 'completed' : 'in_progress';
      } catch {}
    }

    const balance = Number(qboBalances[email] || qboBalances[email?.toLowerCase()] || 0);

    clients.push({
      email,
      name: rec.businessName || email.split('@')[0],
      state: rec.state || '',
      customerType: rec.customerType || '',
      status: rec.status || 'active',
      services: rec.services || [],
      taxStatuses: Array.isArray(rec.taxStatuses) ? rec.taxStatuses : [],
      dashboardCards: Array.isArray(rec.dashboardCards) ? rec.dashboardCards : null,
      monthlyPrice: rec.monthlyPrice || 0,
      yearlyPrice: rec.yearlyPrice || 0,
      businessName: rec.businessName || email.split('@')[0],
      questionnaire: qStatus,
      documents: docCounts[email] || 0,
      balance,
    });
  }

  const total = clients.length;
  const completed = clients.filter(c => c.questionnaire === 'completed').length;
  const inProgress = clients.filter(c => c.questionnaire === 'in_progress').length;
  const notStarted = clients.filter(c => c.questionnaire === 'not_started').length;
  const totalAR = clients.reduce((s, c) => s + c.balance, 0);
  const totalDocs = clients.reduce((s, c) => s + c.documents, 0);

  // Count prospects
  let prospectCount = 0;
  let newProspectCount = 0;
  let prospectsCounted = false;
  if (env.D1_READS !== 'off') {
    try {
      const row = (await env.DB.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN viewed = 0 THEN 1 ELSE 0 END) AS unseen FROM prospects').first());
      prospectCount = row?.total || 0;
      newProspectCount = row?.unseen || 0;
      prospectsCounted = true;
    } catch {}
  }
  if (!prospectsCounted) {
    const prospectList = await listAll(env.tideventure_documents);
    for (const obj of prospectList.objects) {
      if (obj.key.startsWith('prospect/')) {
        prospectCount++;
        try {
          const p = JSON.parse(await (await env.tideventure_documents.get(obj.key)).text());
          if (!p.viewed) newProspectCount++;
        } catch {}
      }
    }
  }

  return json(200, {
    stats: { total, completed, inProgress, notStarted, totalAR, totalDocs, prospects: prospectCount, newProspects: newProspectCount },
    clients,
  });
}

// Firm-wide KPIs computed live from the current data — two D1 table reads
// (clients + prospects) when D1 reads are enabled, with an R2 scan as fallback.
async function handleKpis(env) {
  // Read from D1 (fast SQL) unless reads are flagged off or D1 errors; the R2
  // scan is kept as the fallback path. Both feed the same computation.
  let clients = null, prospects = null;
  if (env.D1_READS !== 'off') {
    try {
      clients = (await env.DB.prepare('SELECT * FROM clients').all()).results.map(rowToClient);
      prospects = (await env.DB.prepare('SELECT * FROM prospects').all()).results.map(rowToProspect);
    } catch { clients = null; }
  }
  if (!clients) {
    const { objects } = await listAll(env.tideventure_documents);
    clients = []; prospects = [];
    for (const o of objects) {
      if (o.key.startsWith('user/')) { try { clients.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
      else if (o.key.startsWith('prospect/')) { try { prospects.push(JSON.parse(await (await env.tideventure_documents.get(o.key)).text())); } catch {} }
    }
  }

  let active = 0, deactivated = 0, pending = 0, mrr = 0, qEligible = 0, qCompleted = 0;
  const signLags = [];
  for (const u of clients) {
    if (!u.email || u.email.endsWith('@tideventurecpa.com')) continue; // skip firm/admin accounts
    const st = u.status || 'active';
    if (st === 'deactivated') { deactivated++; continue; }
    if (st === 'pending_setup' || st === 'pending_engagement') pending++; else active++;
    mrr += Number(u.monthlyPrice) || (Number(u.yearlyPrice) || 0) / 12;
    if (u.engagementAcceptedAt && u.createdAt) {
      const lag = (new Date(u.engagementAcceptedAt) - new Date(u.createdAt)) / 86400000;
      if (lag >= 0 && lag < 400) signLags.push(lag);
    }
    const svcs = u.services || [];
    if (svcs.includes('tax') || svcs.includes('quarterly')) {
      qEligible++;
      try {
        const q = await env.tideventure_documents.get(`questionnaire/${u.email}/${CURRENT_TAX_YEAR}`);
        if (q) { const a = JSON.parse(await q.text()); if (a.final_signature) qCompleted++; }
      } catch {}
    }
  }

  let pTotal = 0, pConverted = 0, byStage = { new: 0, contacted: 0, proposal: 0, lost: 0 };
  for (const p of prospects) {
    pTotal++;
    if (p.status === 'active' || p.status === 'converted') { pConverted++; continue; }
    const stage = ['new', 'contacted', 'proposal', 'lost'].includes(p.stage) ? p.stage : 'new';
    byStage[stage]++;
  }

  const median = arr => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const arr = Math.round(mrr * 12);

  return json(200, {
    clients: { active, deactivated, pending },
    revenue: { mrr: Math.round(mrr), arr, perClient: active ? Math.round(arr / active) : 0 },
    prospects: {
      total: pTotal, converted: pConverted,
      open: byStage.new + byStage.contacted + byStage.proposal, lost: byStage.lost,
      byStage, conversionRate: pTotal ? Math.round((pConverted / pTotal) * 100) : 0,
    },
    questionnaire: { eligible: qEligible, completed: qCompleted, rate: qEligible ? Math.round((qCompleted / qEligible) * 100) : 0 },
    signingLagDays: median(signLags) === null ? null : Math.round(median(signLags) * 10) / 10,
  });
}

async function handleAuditLog(env) {
  // D1: one indexed, ordered query instead of reading every audit object.
  if (env.D1_READS !== 'off') {
    try {
      const rows = (await env.DB.prepare('SELECT ts, action, actor_email, detail FROM audit_log ORDER BY ts DESC LIMIT 200').all()).results;
      return json(200, { audit: rows.map(r => ({ timestamp: r.ts, action: r.action, email: r.actor_email, detail: r.detail })) });
    } catch {}
  }
  const entries = [];
  const listResult = await listAll(env.tideventure_documents, { include: ['customMetadata', 'httpMetadata'] });
  for (const obj of listResult.objects) {
    if (!obj.key.startsWith('audit/')) continue;
    const data = await env.tideventure_documents.get(obj.key);
    if (data) {
      const body = await data.text();
      try { entries.push(JSON.parse(body)); } catch {}
    }
  }
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return json(200, { audit: entries.slice(0, 200) });
}

// ── QBO helpers (per-client tokens) ──
const QBO_SCOPES = 'com.intuit.quickbooks.accounting';

function qboEnv(env) {
  return {
    clientId: env.QBO_CLIENT_ID,
    clientSecret: env.QBO_CLIENT_SECRET,
    redirectUri: env.QBO_REDIRECT_URI || 'https://tideventurecpa.com/api/qbo/callback',
  };
}

function qboTokenKey(email) {
  return `qbo/tokens/${email}`;
}

async function getQboTokens(env, email) {
  const obj = await env.tideventure_documents.get(qboTokenKey(email));
  if (!obj) return null;
  const raw = await obj.text();
  try {
    return JSON.parse(raw.startsWith('{') ? raw : await decryptSecret(env, raw));
  } catch { return null; }
}

async function saveQboTokens(env, email, tokens) {
  const enc = await encryptSecret(env, JSON.stringify(tokens));
  await env.tideventure_documents.put(qboTokenKey(email), enc, { httpMetadata: { contentType: 'text/plain' } });
}

async function refreshQboTokens(env, email) {
  const tokens = await getQboTokens(env, email);
  if (!tokens?.refresh_token) return null;
  const { clientId, clientSecret } = qboEnv(env);
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) return null;
  const newTokens = await res.json();
  newTokens.realmId = tokens.realmId;
  await saveQboTokens(env, email, newTokens);
  return newTokens;
}

async function qboFetch(env, email, path) {
  let tokens = await getQboTokens(env, email);
  if (!tokens) throw new Error('QuickBooks not connected');
  // Production host first for real clients; QBO_ENV='sandbox' flips the order
  // for testing. The other host stays as a fallback so either mode still works.
  const PROD = 'quickbooks.api.intuit.com', SANDBOX = 'sandbox-quickbooks.api.intuit.com';
  const hosts = env.QBO_ENV === 'sandbox' ? [SANDBOX, PROD] : [PROD, SANDBOX];
  let lastErr;
  for (const host of hosts) {
    const url = `https://${host}/v3/company/${tokens.realmId}${path}`;
    let res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
    });
    if (res.status === 401) {
      tokens = await refreshQboTokens(env, email);
      if (!tokens) throw new Error('QBO token refresh failed');
      res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
    }
    if (res.ok) return res.json();
    lastErr = `QBO API ${res.status}: ${(await res.text()).slice(0, 200)}`;
  }
  throw new Error(lastErr);
}

async function handleQboAuth(request, env, email) {
  const { clientId, redirectUri } = qboEnv(env);
  const state = crypto.randomUUID();
  const verifier = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const verifierEncoder = new TextEncoder();
  const challengeBuf = await crypto.subtle.digest('SHA-256', verifierEncoder.encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Store verifier + email + state temporarily (expires in 5 min)
  await env.tideventure_documents.put(`qbo/oauth/${state}`, JSON.stringify({ verifier, email, createdAt: Date.now() }), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { expiresAt: Date.now() + 300000 },
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: QBO_SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return Response.redirect(`https://appcenter.intuit.com/connect/oauth2?${params}`, 302);
}

async function handleQboCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const realmId = url.searchParams.get('realmId');
  const error = url.searchParams.get('error');

  if (error) return new Response(`QBO auth error: ${error}`, { status: 400 });
  if (!code || !state || !realmId) return new Response('Missing OAuth parameters', { status: 400 });

  // Retrieve verifier + email from stored state. Consume it first (single-use),
  // then enforce a 10-minute expiry — mirrors the Gmail callback.
  const stored = await env.tideventure_documents.get(`qbo/oauth/${state}`);
  if (!stored) return new Response('OAuth state expired or invalid', { status: 400 });
  await env.tideventure_documents.delete(`qbo/oauth/${state}`);
  const { verifier, email, createdAt } = JSON.parse(await stored.text());
  if (!email) return new Response('No email in state', { status: 400 });
  if (!createdAt || Date.now() - createdAt > 600000) return new Response('OAuth state expired', { status: 400 });

  const { clientId, clientSecret, redirectUri } = qboEnv(env);
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    return new Response(`Token exchange failed: ${body}`, { status: 500 });
  }
  const tokens = await res.json();
  tokens.realmId = realmId;
  await saveQboTokens(env, email, tokens);

  return new Response('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="2;url=/portal"></head><body style="font-family:sans-serif;text-align:center;padding:3rem;"><h2>QuickBooks connected!</h2><p>Redirecting back to portal…</p><a href="/portal">Go to Portal</a></body></html>', {
    headers: { 'Content-Type': 'text/html' },
  });
}

async function getQboDataForClient(env, email) {
  const tokens = await getQboTokens(env, email);
  if (!tokens) return { qboConnected: false, needsReconnect: false, invoices: [], revenue: [] };

  try {
    const [invData, srData] = await Promise.all([
      qboFetch(env, email, '/query?query=select%20*%20from%20Invoice%20maxresults%201000'),
      qboFetch(env, email, '/query?query=select%20*%20from%20SalesReceipt%20maxresults%201000'),
    ]);


    const invoices = (invData.QueryResponse?.Invoice || []).filter(i => i.Balance > 0).map(i => ({
      docNumber: i.DocNumber,
      totalAmt: i.TotalAmt,
      balance: i.Balance,
      dueDate: i.DueDate,
      txnDate: i.TxnDate,
    }));

    // Calculate monthly revenue from invoices + sales receipts
    const allTxns = [
      ...(invData.QueryResponse?.Invoice || []),
      ...(srData.QueryResponse?.SalesReceipt || []),
    ];
    const revenue = [];
    const now = new Date();
    for (let m = 5; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const monthStr = `${y}-${mo}`;
      const total = allTxns
        .filter(t => t.TxnDate && t.TxnDate.startsWith(monthStr))
        .reduce((sum, t) => sum + (parseFloat(t.TotalAmt) || 0), 0);
      const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      revenue.push({ month: label, amount: total });
    }

    return { qboConnected: true, needsReconnect: false, invoices, revenue };
  } catch (e) {
    // Tokens exist but the fetch/refresh failed — the grant is expired or
    // revoked. Signal a distinct "reconnect" state (vs. never-connected) so the
    // portal can prompt the client instead of showing a bare Connect button.
    return { qboConnected: false, needsReconnect: true, invoices: [], revenue: [], error: String(e.message).slice(0, 160) };
  }
}

// Dashboard-facing QBO data. Serves the nightly snapshot (instant, and resilient
// to a momentary QBO outage); for a just-connected client with no snapshot yet
// it fetches live once and warms the snapshot. A cheap token-presence check
// means a disconnected client never sees stale cached data.
async function getQboDashboardData(env, email) {
  const tokens = await getQboTokens(env, email);
  if (!tokens) return { qboConnected: false, needsReconnect: false, invoices: [], revenue: [] };
  try {
    const snap = await env.tideventure_documents.get(`qbo/snapshot/${email}`);
    if (snap) return JSON.parse(await snap.text());
  } catch {}
  const live = await getQboDataForClient(env, email);
  if (live.qboConnected) {
    try {
      await env.tideventure_documents.put(`qbo/snapshot/${email}`, JSON.stringify({ ...live, syncedAt: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } });
    } catch {}
  }
  return live;
}

// Nightly QBO sync: for every connected client, refresh the token (keep-alive so
// a dormant client's ~100-day refresh token doesn't lapse), pull invoices +
// revenue once, and write a per-client snapshot the portal reads instantly. Also
// writes a single `qbo/balances` roll-up (email → outstanding balance) that the
// admin dashboard reads — previously it read `qbo/invoices`/`qbo/customers`
// objects that nothing ever wrote, so admin balances always showed $0.
async function runQboSync(env) {
  const { objects } = await listAll(env.tideventure_documents, { prefix: 'qbo/tokens/' });
  const balances = {};
  let synced = 0, reconnect = 0;
  for (const o of objects) {
    const email = o.key.slice('qbo/tokens/'.length);
    if (!email) continue;
    try { await refreshQboTokens(env, email); } catch {}
    const data = await getQboDataForClient(env, email);
    const snapshot = { ...data, syncedAt: new Date().toISOString() };
    try {
      await env.tideventure_documents.put(`qbo/snapshot/${email}`, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });
    } catch {}
    if (data.qboConnected) {
      balances[email] = (data.invoices || []).reduce((s, i) => s + (Number(i.balance) || 0), 0);
      synced++;
    } else if (data.needsReconnect) {
      reconnect++;
    }
  }
  try {
    await env.tideventure_documents.put('qbo/balances', JSON.stringify(balances), { httpMetadata: { contentType: 'application/json' } });
  } catch {}
  return { synced, reconnect };
}

// ── Password hashing ──
async function hashPassword(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password + env.DOC_ENC_KEY), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, baseKey, 256);
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return saltHex(salt) + ':' + hashHex;
}

// Constant-time compare of two equal-length hex strings, so password checking
// can't be turned into a timing oracle byte-by-byte.
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, stored, env) {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return password === stored; // legacy plaintext (pre-migration records only)
  const salt = hexToBytes(parts[0]);
  const storedHash = parts[1];
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password + env.DOC_ENC_KEY), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, baseKey, 256);
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(hashHex, storedHash);
}

function saltHex(bytes) { return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join(''); }

// ── Secret encryption (for OAuth tokens at rest in R2) ──
async function encryptSecret(env, plaintext) {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode('secret-store:' + env.DOC_ENC_KEY));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function decryptSecret(env, hex) {
  const bytes = new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const keyBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('secret-store:' + env.DOC_ENC_KEY));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(plain);
}

// ── Questionnaire encryption ──
async function encryptQuestionnaire(secret, email, plaintext) {
  const kmHex = await deriveKeyMaterial(secret, email);
  const kmBytes = hexToBytes(kmHex);
  const key = await crypto.subtle.importKey('raw', kmBytes.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const out = new Uint8Array(iv.length + encrypted.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(encrypted), iv.length);
  return out.buffer;
}

async function decryptQuestionnaire(secret, email, ciphertext) {
  const kmHex = await deriveKeyMaterial(secret, email);
  const kmBytes = hexToBytes(kmHex);
  const key = await crypto.subtle.importKey('raw', kmBytes.slice(0, 32), { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = new Uint8Array(ciphertext);
  const iv = bytes.slice(0, 12);
  const encrypted = bytes.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
}

// ── Encryption helpers (paired with browser-side Web Crypto) ──
async function deriveKeyMaterial(secret, userEmail) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(userEmail));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mirror of decryptWithWorkerKey. Used for documents the FIRM uploads into a
// client's portal: the browser cannot do it there, because the admin page holds
// the admin's key material and the file has to be readable by the client, whose
// key is derived from their own address.
//
// The byte layout must stay identical to the portal's encryptFile — salt(16) ||
// iv(12) || AES-GCM ciphertext, PBKDF2 at 100,000 iterations over the client's
// key material — or a document encrypted here cannot be opened there.
async function encryptWithWorkerKey(secret, ownerEmail, plaintext) {
  const kmHex = await deriveKeyMaterial(secret, ownerEmail);
  const km = hexToBytes(kmHex);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey('raw', km, 'PBKDF2', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);
  const out = new Uint8Array(16 + 12 + encrypted.byteLength);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(new Uint8Array(encrypted), 28);
  return out;
}

async function decryptWithWorkerKey(secret, uploaderEmail, ciphertext) {
  const kmHex = await deriveKeyMaterial(secret, uploaderEmail);
  const km = hexToBytes(kmHex);
  const bytes = new Uint8Array(ciphertext);
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const encrypted = bytes.slice(28);
  const baseKey = await crypto.subtle.importKey('raw', km, 'PBKDF2', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encrypted);
}

// Single source of truth for "which tax year is currently being collected."
// Bump CURRENT_TAX_YEAR once a year (and mirror it in questionnaire.html,
// admin.html's schema editor, and admin-client.html — those static pages
// can't import this constant directly). The questionnaire for that year can't
// be meaningfully completed until the year itself has ended, so it doesn't
// become "actionable" for clients until then.
const CURRENT_TAX_YEAR = 2026;
const PRIOR_TAX_YEAR = CURRENT_TAX_YEAR - 1;
const NEXT_TAX_YEAR = CURRENT_TAX_YEAR + 1;
const QUESTIONNAIRE_OPENS_AT = Date.UTC(NEXT_TAX_YEAR, 0, 1); // Jan 1 of the following year, UTC ms

const DEFAULT_TQ_SCHEMA = {
  year: CURRENT_TAX_YEAR, sections: [
    {title:'General Questions',questions:[
      ['marital_change','Did your marital status change during the year?'],
      ['separated','Did you live separately from your spouse during the last 6 months?'],
      ['separate_decree','Do you have a separate decree and not living in same household?'],
      ['address_change','Did your address change from last year?'],
      ['claimed_dependent','Can you be claimed as a dependent by another taxpayer?'],
      ['has_tin','Do all family members have SSN/ITIN/ATIN?'],
      ['ip_pin','Did you receive an IP PIN or been a victim of identity theft?'],
      ['disaster_area','Did you reside or operate a business in a disaster area?'],
      ['dep_changes','Were there any changes in dependents from the prior year?'],
      ['child_unearned','Any child under 19 or student under 24 with unearned income over $2,600?'],
      ['dep_must_file','Do any dependents need to file a tax return?'],
      ['support_others','Did you provide over half the support for any other person(s)?'],
      ['childcare','Did you pay for child care while working/looking for work/student?'],
      ['other_lived_with','Did any other person live with you more than half the year?'],
      ['adoption','Did you pay any adoption expenses?'],
      ['divorce_decree','If divorced/separated with children, do you have a separation agreement?'],
      ['dep_ip_pin','Did any dependents receive an IP PIN or been identity theft victims?'],
    ]},{title:'Income Information',questions:[
      ['foreign_income','Did you have any foreign income or pay foreign taxes?'],
      ['prior_property_income','Did you receive income from property sold prior to this year?'],
      ['unemployment','Did you receive any unemployment benefits?'],
      ['disability','Did you receive any disability income?'],
      ['medicaid_waiver','Did you receive Medicaid waiver payments?'],
      ['tip_income','Did you receive tip income not reported to employer?'],
      ['life_insurance','Did any life insurance policies mature or were surrendered?'],
      ['hobby_income','Did you receive awards, prizes, hobby income, gambling winnings?'],
      ['nonemployee_comp','Did you receive nonemployee compensation?'],
      ['gig_1099','Did you receive Form 1099-K/MISC/NEC for gig work?'],
      ['crowdfunding_1099k','Did you receive Form 1099-K for crowdfunding?'],
      ['erroneous_1099k','Do you believe any Form 1099-K is in error?'],
      ['income_fluctuation','Do you expect large fluctuation in income/deductions/withholding next year?'],
      ['digital_assets','Did you have any sales/exchanges of digital assets?'],
      ['social_security','Did you receive any Social Security benefits?'],
    ]},{title:'Purchases, Sales & Debt',questions:[
      ['new_business','Did you start a new business or purchase rental property?'],
      ['business_interest','Did you have ownership interest in any business?'],
      ['sold_biz_assets','Did you sell/exchange/purchase any business assets?'],
      ['new_partnership','Did you acquire interest in a partnership or S corp?'],
      ['real_estate','Did you sell/exchange/purchase any real estate?'],
      ['principal_residence','Did you purchase or sell a principal residence?'],
      ['foreclosure','Did you foreclose or abandon a principal residence or property?'],
      ['stock','Did you acquire or dispose of any stock?'],
      ['home_equity','Did you take out a home equity loan?'],
      ['refinance','Did you refinance a principal residence or second home?'],
      ['sold_business','Did you sell an existing business, rental, or other property?'],
      ['bad_debt','Did you lend money that became totally uncollectable?'],
      ['debt_forgiven','Did you have any debts canceled or forgiven?'],
      ['clean_vehicle','Did you purchase a clean vehicle eligible for the credit?'],
      ['personal_property_1099k','Did you receive Form 1099-K for sale of personal property?'],
      ['us_vehicle','Did you make loan payments on a US-assembled vehicle?'],
    ]},{title:'Retirement Information',questions:[
      ['retirement_participant','Are you an active participant in a pension or retirement plan?'],
      ['ira_withdrawal','Did you make any IRA, Roth, 401(k) or other retirement withdrawals?'],
      ['disaster_repayment','If you received qualified disaster distributions, did you repay any?'],
      ['lump_sum','Did you receive any lump-sum pension/401(k) distributions?'],
      ['ira_contribution','Did you make contributions to IRA, Roth, 401(k) or other retirement plan?'],
      ['birth_adoption_dist','Did you receive qualified birth/adoption or emergency distributions?'],
      ['qcd','Did you make any qualified charitable distributions (QCD)?'],
    ]},{title:'Education Information',questions:[
      ['post_secondary','Did you, spouse, or dependents attend post-secondary school?'],
      ['educational_expenses','Did you have educational expenses for yourself/spouse/dependent?'],
      ['scholarship','Did anyone in your family receive a scholarship?'],
      ['529_withdrawal','Did you make any 529 plan withdrawals?'],
      ['529_contribution','Did you make any 529 plan contributions?'],
      ['student_loan_interest','Did you pay any student loan interest?'],
      ['savings_bonds','Did you cash any Series EE or I savings bonds issued after 1989?'],
      ['fafsa_worksheet','Would you like a worksheet for FAFSA completion?'],
    ]},{title:'Health Care Information',questions:[
      ['health_coverage','Did you have qualifying health care coverage for your family?'],
      ['marketplace','Did you enroll in Marketplace coverage through healthcare.gov?'],
      ['shared_policy','Did you share a Marketplace policy with anyone not in your family?'],
      ['hsa_contribution','Did you make HSA or Archer MSA contributions?'],
      ['hsa_distribution','Did you receive HSA/MSA distributions?'],
      ['long_term_care_premiums','Did you pay long-term care premiums?'],
      ['able_contribution','Did you make ABLE account contributions?'],
      ['able_withdrawal','Did you receive ABLE account withdrawals?'],
      ['employer_health','If business owner, did you pay employee health insurance premiums?'],
    ]},{title:'Itemized Deductions',questions:[
      ['casualty_loss','Did you incur a casualty/theft loss or condemnation award?'],
      ['medical_expenses','Did you pay out-of-pocket medical expenses?'],
      ['cash_charity','Did you make any cash charitable contributions?'],
      ['noncash_charity','Did you make any noncash charitable contributions?'],
      ['vehicle_donation','Did you donate a vehicle or boat?'],
      ['real_estate_tax','Did you pay real estate taxes?'],
      ['mortgage_interest','Did you pay mortgage interest?'],
      ['investment_interest','Did you incur investment interest expenses?'],
      ['major_purchases','Did you make any major purchases (cars, boats, etc.)?'],
      ['out_of_state_tax','Did you make out-of-state purchases where seller did not collect sales/use tax?'],
    ]},{title:'Miscellaneous Information',questions:[
      ['gifts','Did you make gifts of more than $18,000 to any individual?'],
      ['bartering','Did you engage in any bartering transactions?'],
      ['retired_or_job_change','Did you retire or change jobs this year?'],
      ['moving_armed_forces','Did you incur moving costs as a member of the Armed Forces?'],
      ['household_employee','Did you pay any individual as a household employee?'],
      ['energy_improvements','Did you make energy efficient home improvements?'],
      ['foreign_trust','Did you receive a distribution from or were you grantor of a foreign trust?'],
      ['foreign_account','Did you have financial interest/signature authority over a foreign account?'],
      ['foreign_financial_assets','Do you have foreign financial assets or interest in a foreign entity?'],
      ['boir_owner','Are you an owner or control 25% of a company registered before Jan 1, 2026?'],
      ['boir_changed','If required to file BOIR, has any previously reported information changed?'],
      ['irs_correspondence','Did you receive correspondence from the State or IRS?'],
      ['unfiled_years','Do you have prior years unfiled or with unpaid balances?'],
      ['presidential_fund','Do you want to designate $3 to the Presidential Election Campaign Fund?'],
    ]},{title:'Estimated Taxes',questions:[
      ['overpayment_refund','If overpaid, do you want refund or applied to 2027 estimated?'],
      ['income_change_2026','Do you expect considerable change in 2027 income?'],
      ['deduction_change_2026','Do you expect considerable change in 2027 deductions?'],
      ['withholding_change_2026','Do you expect considerable change in 2027 withholding?'],
      ['dependents_change_2026','Do you expect a change in dependents claimed for 2027?'],
      ['fed_estimated_payments','Did you make federal estimated tax payments for 2026?'],
      ['fed_prior_overpayment','Was any 2025 overpayment applied to 2026 estimated?'],
      ['state_estimated_payments','Did you make state estimated tax payments for 2026?'],
      ['state_prior_overpayment','Was any state 2025 overpayment applied to 2026 estimated?'],
    ]},{title:'Traditional IRA',questions:[
      ['employer_retirement_plan','Are you or spouse covered by an employer retirement plan?'],
      ['trad_ira_contribution','Did you make traditional IRA contributions for 2026?'],
    ]},{title:'Roth IRA',questions:[
      ['roth_ira_contribution','Did you make Roth IRA contributions for 2026?'],
      ['roth_conversion','Did you make a 2026 Roth IRA conversion?'],
      ['roth_recharacterization','Did you make total Roth IRA contribution recharacterizations?'],
    ]},{title:'Sales of Stocks & Securities',questions:[
      ['worthless_securities','Did any securities become worthless during 2026?'],
      ['uncollectible_debts','Did any debts become uncollectible during 2026?'],
      ['commodity_sales','Did you have commodity sales, short sales, or straddles?'],
      ['noncash_exchange','Did you exchange securities/investments for something other than cash?'],
      ['virtual_assets','Did you receive, sell, exchange, or dispose of any virtual assets?'],
    ]},{title:'Other Income',questions:[
      ['state_refund','Did you receive state/local income tax refunds during 2026?'],
      ['alimony_received','Did you receive alimony during 2026?'],
      ['unemployment_comp','Did you receive unemployment compensation during 2026?'],
      ['other_income','Did you have other income (commissions, jury pay, director fees, etc.)?'],
    ]},{title:'Other Adjustments',questions:[
      ['alimony_paid','Did you pay alimony during 2026?'],
      ['educator_expenses','Did you have educator expenses (K-12 teacher, counselor, etc.)?'],
      ['other_adjustments','Did you have any other adjustments to income?'],
    ]},{title:'Schedule A - Medical & Dental',questions:[
      ['medical_expenses_itemized','Did you have medical/dental expenses?'],
      ['medical_insurance','Did you pay medical insurance premiums?'],
      ['long_term_care_premiums_itemized','Did you pay long-term care premiums?'],
      ['prescription_drugs','Did you have prescription medicine expenses?'],
      ['medical_mileage','Did you drive tax miles for medical (21¢/mile)?'],
    ]},{title:'Schedule A - Tax Expenses',questions:[
      ['state_local_income_tax','Did you pay state/local income taxes in 2026?'],
      ['state_local_2025_tax','Did you pay 2026 state/local income taxes in 2026?'],
      ['real_estate_taxes','Did you pay real estate taxes?'],
      ['personal_property_tax','Did you pay personal property taxes?'],
      ['other_taxes','Did you pay foreign taxes or state disability taxes?'],
      ['sales_tax_major','Did you pay sales tax on major purchases?'],
      ['sales_tax_actual','Did you pay sales tax on actual expenses?'],
    ]},{title:'Interest Expenses',questions:[
      ['mortgage_interest_1098','Pay home mortgage interest on Form 1098?'],
      ['mortgage_interest_individual','Pay other mortgage interest to individuals?'],
      ['refinance_points','Refinance and pay points in 2026?'],
      ['investment_interest_expense','Investment interest other than Schedule K-1?'],
    ]},{title:'Charitable Contributions',questions:[
      ['charity_cash','Charitable contributions by cash or check?'],
      ['charity_mileage','Volunteer miles for charity?'],
      ['charity_noncash','Noncash donations (clothing, household, etc.)?'],
    ]},{title:'Miscellaneous Deductions',questions:[
      ['other_expenses','Other expenses not listed elsewhere?'],
      ['gambling_losses','Gambling losses (only if you have gambling income)?'],
    ]},{title:'Misc. Itemized Deductions (State)',questions:[
      ['unreimbursed_expenses','Unreimbursed employee expenses (uniforms, dues, etc.)?'],
      ['union_dues','Union dues not on W-2?'],
      ['tax_prep_fees','Tax preparation fees?'],
      ['other_2pct_expenses','Other expenses subject to 2% AGI limit?'],
      ['safe_deposit','Safe deposit box rental?'],
      ['investment_expenses','Investment expenses other than K-1/1099?'],
    ]},{title:'Health Care Coverage',questions:[
      ['self_employed_health','Self-employed health insurance premiums?'],
      ['self_employed_ltc','Self-employed long-term care premiums?'],
    ]},
  ]
};

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
