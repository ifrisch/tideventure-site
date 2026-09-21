# TideVenture CPA — Claude Code Reference

## Stack
- **Runtime:** Cloudflare Worker (`src/index.js`) — single ESM fetch handler, no framework
- **Frontend:** Static HTML pages in `public/` served via `ASSETS` binding
- **Storage:** Cloudflare R2 (`tideventure_documents` binding) is the system of record. Cloudflare D1 (`DB` binding, `tideventure-db`) is a queryable mirror — see **D1 layer** below.
- **Auth:** JWT via `jose`, signed with mandatory `env.JWT_SECRET` (`jwtKey(env)` throws if unset — no DOC_ENC_KEY fallback). The JWT is returned in the login JSON (SPA uses it as a Bearer token) **and** set as an `HttpOnly; Secure; SameSite=Lax` `tv_session` cookie so top-level navigations (doc view-in-new-tab, OAuth connect) authenticate without a token in the URL. Admin = email in the `env.ADMIN_EMAILS` allowlist (comma-separated; defaults to `isaac@`/`admin@tideventurecpa.com`) — **not** the email suffix. `isAdmin` also gates `getAuthUser`'s live-deactivation-skip.
- **Routing:** Manual `url.pathname ===` checks inside the fetch handler. No router library.
- **Cron:** Daily at noon UTC via `triggers.crons` in `wrangler.jsonc`

## Key files
- `src/index.js` — entire backend (1600+ lines). All API routes, scheduled handler, helpers
- `public/admin.html` — admin SPA (all tabs in one file, toggled by `data-page`)
- `public/admin-client.html` — separate page for individual client detail
- `wrangler.jsonc` — Cloudflare config (routes, R2 bindings, cron trigger)

## R2 key schema
| Prefix | Content |
|---|---|
| `user/<email>` | User record (role, password hash, services, pricing, status) |
| `profile/<email>` | Profile data |
| `prospect/<uuid>` | Prospect from pricing tool |
| `setup/<token>` | One-time account setup tokens |
| `questionnaire/<email>/<year>` | Encrypted questionnaire responses |
| `questionnaire/schema/<year>` | Questionnaire schema |
| `<email>/<uuid>` | Client documents (encrypted) |
| `audit/<timestamp>-<uuid>` | Audit log entries |
| `regulatory/items/<hash>` | Regulatory update items (news/press releases) |
| `regulatory/_seen.json` | Array of seen item IDs (badge tracking) |
| `pandadoc/<email>/<id>` | PandaDoc document references |
| `ratelimit/login/<email>` | Login rate limit counters (also `ratelimit/prospect/<ip>`) |
| `qbo/tokens/<email>` | QuickBooks Online OAuth tokens (encrypted at rest) |
| `qbo/snapshot/<email>` | Cached per-client QBO financials incl. YTD P&L (written nightly by `runQboSync`) |
| `qbo/balances` | Roll-up map `{email: outstandingBalance}` for the admin dashboard |
| `savings/<email>/<id>` | Tax Savings Ledger entries (drive the portal "Your Tax Savings" card) |
| `docrequest/<email>/<id>` | Document requests (portal checklist; requested → submitted → received/waived) |

## D1 layer (`DB` binding)
R2 stays authoritative; D1 is a mirror kept in sync so admin-side aggregations are one SQL query instead of a full-bucket scan. Schema in `migrations/` (13 tables: `clients` = merged `user/`+`profile/` incl. `est_tax_rate`, `prospects`, `messages`, `documents`, `audit_log`, `engagement_records`, `questionnaires`, `settings`, `setup_tokens`, `reset_tokens`, `rate_limits`, `savings_entries`, `doc_requests`).

- **Dual-write:** every R2 write to a mirrored entity also calls its D1 sync helper (`syncClientToD1`, `syncProspectToD1`, `insertMessageD1`, `insertAuditD1` (append-only), `insertEngagementD1`, plus token/rate helpers). Row↔object mapping via `rowToClient` / `rowToProspect`.
- **Reads flipped to D1** (behind `env.D1_READS !== 'off'`, R2 fallback on any error): `handleKpis`, `handleAdminDashboard`, `handleAuditLog`, and `/api/admin/prospects`. Per-client portal reads still hit R2. Set the `D1_READS` var to `off` to instantly revert all reads to R2.
- **Self-heal:** nightly cron runs `backfillAllToD1(env)` (excludes audit) to correct any drift. `backfillAllToD1(env, {includeAudit:true})` is the full one-time backfill form.
- To flip a new read to D1, add the `env.D1_READS !== 'off'` guarded branch with the existing R2 code as the `catch`/fallback, and verify parity with `wrangler d1 execute tideventure-db --remote`.

## Admin panel tabs (`public/admin.html`)
`dashboard` · `clients` · `prospects` · `documents` · `questionnaire` · `audit` · `regulatory`

Each tab = `<div class="page" id="page-<name>">` toggled via JS. Sidebar badge pattern: amber pill with count, hidden when zero. Active sidebar link gets `border-left-color: #6bb4d0`.

## Auth pattern (all protected routes)
```js
const user = await getAuthUser(); // reads Bearer token or cookie
const email = user?.email;
if (!isAdmin(email)) return json(403, ...);
```

## API conventions
- All routes are `if (url.pathname === '/api/...' && method === 'GET/POST/PUT' && isAdmin(email))`
- Responses via `json(status, data)` helper
- Admin routes live between the auth setup (~line 155) and the ASSETS fallback (~line 795)

## Encryption
Documents and questionnaires encrypted AES-GCM. Key derived from `env.DOC_ENC_KEY` + user email via HMAC-SHA256 (`deriveKeyMaterial`). The worker sends `keyMaterial` to the browser so JS can also encrypt/decrypt.

## Page data injection
For `/portal`, `/admin`, `/questionnaire`, `/admin-client` — worker intercepts HTML response and injects `window.__PAGE_DATA__ = {email, role, keyMaterial}` before `</head>`.

## External integrations
- **PandaDoc** — e-signature via `POST /api/admin/pandadoc-send` (API key in env). The old in-app DIY signing flow was removed; no UI currently invokes PandaDoc, but the route is kept for re-wiring.
- **QuickBooks Online** — per-client OAuth2 (PKCE). Tokens at `qbo/tokens/<email>`. The nightly `runQboSync` refreshes tokens (keep-alive), caches each connected client's invoices+revenue to `qbo/snapshot/<email>` (served instantly by `handleDashboard` via `getQboDashboardData`), and writes the `qbo/balances` roll-up the admin dashboard reads. `qboFetch` hits the production host first; set `QBO_ENV=sandbox` to flip. `getQboDataForClient` returns `needsReconnect:true` when a stored grant is expired/revoked, which the portal surfaces as a Reconnect prompt.
- **Regulatory feeds** — IRS RSS, IRS e-News, MN/TN/IA DOR (scraped daily by cron)

## Nightly cron (`runNightlyJobs`, noon UTC)
Sequential, each isolated in try/catch: `fetchRegulatoryUpdates` → `runBackup` → `pruneAuditLog` → `pruneD1Transients` → `runQboSync` → `backfillAllToD1` (D1 self-heal + orphan reconciliation).

## Deploy
```bash
npx wrangler deploy
```
