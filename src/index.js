import { SignJWT, jwtVerify } from 'jose';

const USERS = {
  'admin@tideventurecpa.com': 'admin123',
  'isaac@tideventure.com': 'test123',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    async function getAuthUser() {
      let token = null;
      // Try Authorization header first (used by JS-based clients)
      const auth = request.headers.get('authorization') || '';
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (match) token = match[1];
      // Fallback to cookie
      if (!token) {
        const cookie = request.headers.get('cookie') || '';
        const cmatch = cookie.match(/(?:^|;\s*)tv_session=([^;]+)/);
        if (cmatch) token = cmatch[1];
      }
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(env.DOC_ENC_KEY));
        return payload;
      } catch {
        return null;
      }
    }

    function isAdmin(email) {
      return email && email.endsWith('@tideventurecpa.com');
    }

    // ── QBO OAuth ──
    if (url.pathname === '/api/qbo/auth' && method === 'GET') {
      let u = await getAuthUser();
      if (!u?.email) {
        const queryToken = url.searchParams.get('token');
        if (queryToken) {
          try {
            const { payload } = await jwtVerify(queryToken, new TextEncoder().encode(env.DOC_ENC_KEY));
            u = payload;
          } catch (e) {
            return json(401, { error: 'Token invalid: ' + e.message.slice(0, 60) });
          }
        }
      }
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
      let email, password;
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        ({ email, password } = await request.json());
      } else {
        const fd = await request.formData();
        email = fd.get('email');
        password = fd.get('password');
      }
      if (USERS[email] && USERS[email] === password) {
        const token = await new SignJWT({ email, role: isAdmin(email) ? 'admin' : 'client' })
          .setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime('24h')
          .sign(new TextEncoder().encode(env.DOC_ENC_KEY));
        const keyMaterial = await deriveKeyMaterial(env.DOC_ENC_KEY, email);
        return json(200, { token, keyMaterial, email, role: isAdmin(email) ? 'admin' : 'client' });
      }
      return json(401, { error: 'Invalid credentials' });
    }

    // ── Check session ──
    if (url.pathname === '/api/session' && method === 'GET') {
      const user = await getAuthUser();
      if (!user) return json(401, { error: 'Not authenticated' });
      const keyMaterial = await deriveKeyMaterial(env.DOC_ENC_KEY, user.email);
      return json(200, { email: user.email, role: user.role, keyMaterial });
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

    if (url.pathname === '/api/profile' && method === 'GET') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try { return await handleGetProfile(env, email); } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/profile' && method === 'PUT') {
      if (!email) return json(401, { error: 'Unauthorized' });
      try { return await handleUpdateProfile(request, env, email, isAdmin(email)); } catch (e) { return json(500, { error: e.message }); }
    }

    if (url.pathname === '/api/documents/upload' && method === 'POST') {
      if (!email) return json(401, { error: 'Unauthorized' });
      return handleUploadDocument(request, env, email);
    }

    if (url.pathname === '/api/audit' && method === 'GET') {
      if (!isAdmin(email)) return json(403, { error: 'Admin access required' });
      try { return await handleAuditLog(env); } catch (e) { return json(500, { error: e.message }); }
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
          return json(200, { year, saved: true, data: JSON.parse(await obj.text()) });
        } catch (e) { return json(500, { error: e.message }); }
      }
      if (method === 'PUT' || method === 'POST') {
        try {
          const body = await request.json();
          if (!body || typeof body !== 'object') return json(400, { error: 'Invalid body' });
          const text = JSON.stringify(body);
          await env.tideventure_documents.put(key, text, { httpMetadata: { contentType: 'application/json' } });
          return json(200, { ok: true, year, saved: true });
        } catch (e) { return json(500, { error: 'Save failed: ' + e.message }); }
      }
    }
    // Admin: list all questionnaire responses for a year
    if (url.pathname.match(/^\/api\/admin\/questionnaire\/\d{4}$/) && method === 'GET' && isAdmin(email)) {
      try {
        const year = url.pathname.split('/').pop();
        const results = [];
        const list = await env.tideventure_documents.list();
        for (const obj of list.objects) {
          const parts = obj.key.split('/');
          if (parts[0] === 'questionnaire' && parts[2] === year) {
            const data = await env.tideventure_documents.get(obj.key);
            if (data) results.push({ email: parts[1], answers: JSON.parse(await data.text()) });
          }
        }
        return json(200, { year, responses: results });
      } catch (e) { return json(500, { error: e.message }); }
    }

    const docMatch = url.pathname.match(/^\/api\/documents\/([^\/]+)$/);
    if (docMatch) {
      if (!email) return json(401, { error: 'Unauthorized' });
      const docId = docMatch[1];
      if (method === 'GET') {
        try { return await handleDownloadDocument(env, docId, email, isAdmin(email)); } catch (e) { return json(500, { error: e.message }); }
      }
      if (method === 'DELETE') {
        try { return await handleDeleteDocument(env, docId, email, isAdmin(email)); } catch (e) { return json(500, { error: e.message }); }
      }
    }

    // ── Inject user data + key material into portal/admin pages ──
    const path = url.pathname.replace(/\.html$/, '');
    if (path === '/portal' || path === '/admin' || path === '/questionnaire' || url.pathname === '/portal.html' || url.pathname === '/admin.html' || url.pathname === '/questionnaire.html') {
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

    return env.ASSETS.fetch(request);
  },
};

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function logAudit(env, action, email, detail) {
  const key = `audit/${Date.now()}-${crypto.randomUUID()}`;
  await env.tideventure_documents.put(key, JSON.stringify({
    action, email, detail, timestamp: new Date().toISOString(),
  }), { httpMetadata: { contentType: 'application/json' } });
}

async function handleListDocuments(env, email, admin) {
  const objects = [];
  const result = await env.tideventure_documents.list({ include: ['customMetadata', 'httpMetadata'] });
  for (const obj of result.objects) {
    if (obj.key.startsWith('audit/')) continue;
    if (admin || obj.customMetadata?.uploadedBy === email) {
      objects.push({
        id: obj.key.split('/').pop(),
        name: (obj.customMetadata?.originalName || obj.key).replace(/\.enc$/, ''),
        size: obj.size,
        uploaded: obj.uploaded,
        uploadedBy: obj.customMetadata?.uploadedBy,
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
      });
    }
  }
  objects.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
  return json(200, { documents: objects });
}

// ── Dashboard data for clients ──
const TAX_STATUSES = [
  { year: 2026, label: '2025 Business Return', status: 'in_review' },
  { year: 2025, label: '2024 Business Return', status: 'filed' },
  { year: 2024, label: '2023 Business Return', status: 'filed' },
];

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
  // Load client profile for state
  let clientState = null;
  const profileKey = `profile/${email}`;
  const profileObj = await env.tideventure_documents.get(profileKey);
  if (profileObj) {
    try { const p = JSON.parse(await profileObj.text()); clientState = p.state; } catch {}
  }

  // Recent activity from audit log
  const activities = [];
  const listResult = await env.tideventure_documents.list({ include: ['customMetadata', 'httpMetadata'] });
  for (const obj of listResult.objects) {
    if (!obj.key.startsWith('audit/')) continue;
    const data = await env.tideventure_documents.get(obj.key);
    if (data) {
      const body = await data.text();
      try {
        const entry = JSON.parse(body);
        if (entry.email === email || entry.email?.endsWith('@tideventurecpa.com')) {
          activities.push(entry);
        }
      } catch {}
    }
  }
  activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const stateDeadline = getStateDeadline(clientState);
  const qbo = await getQboDataForClient(env, email);

  return json(200, {
    taxStatuses: TAX_STATUSES,
    deadlines: getNextEstimatedPayment() ? [getNextEstimatedPayment()] : [],
    stateDeadline: stateDeadline ? [stateDeadline] : [],
    recentActivity: activities.slice(0, 10),
    profile: { state: clientState },
    qbo,
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
  if (!obj) return json(200, { state: null, businessName: email.split('@')[0], ein: '' });
  const body = await obj.text();
  try { return json(200, JSON.parse(body)); } catch { return json(200, { state: null }); }
}

async function handleUpdateProfile(request, env, email, admin) {
  const data = await request.json();
  const targetEmail = (admin && data.email) ? data.email : email;
  const key = `profile/${targetEmail}`;
  // Only admin can change state for now
  if (data.state && !admin) return json(403, { error: 'Admin access required' });
  const existing = await env.tideventure_documents.get(key);
  let profile = {};
  if (existing) { try { profile = JSON.parse(await existing.text()); } catch {} }
  Object.assign(profile, data);
  await env.tideventure_documents.put(key, JSON.stringify(profile), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json(200, profile);
}

async function handleUploadDocument(request, env, email) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json(400, { error: 'No file provided' });
  const id = crypto.randomUUID();
  const key = `${email}/${id}`;
  await env.tideventure_documents.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName: file.name, uploadedBy: email, uploadedAt: new Date().toISOString() },
  });
  await logAudit(env, 'UPLOAD', email, `${file.name} (${file.size} bytes)`);
  return json(201, { id, key, name: file.name });
}

async function handleDownloadDocument(env, docId, email, admin) {
  let found = null;
  const result = await env.tideventure_documents.list({ include: ['customMetadata', 'httpMetadata'] });
  for (const obj of result.objects) {
    if (obj.key.startsWith('audit/')) continue;
    if (obj.key.endsWith(`/${docId}`)) { found = obj; break; }
  }
  if (!found) return json(404, { error: 'Document not found' });

  const uploader = found.customMetadata?.uploadedBy;
  if (!admin && uploader !== email) return json(403, { error: 'Forbidden' });
  const object = await env.tideventure_documents.get(found.key);
  if (!object) return json(404, { error: 'Document not found' });
  await logAudit(env, 'DOWNLOAD', email, found.customMetadata?.originalName || docId);
  const origName = (found.customMetadata?.originalName || docId).replace(/\.enc$/, '');
  // Try to decrypt admin downloads, fall back to raw
  if (admin) {
    try {
      const plaintext = await decryptWithWorkerKey(env.DOC_ENC_KEY, uploader || email, await object.arrayBuffer());
      return new Response(plaintext, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${origName}"`, 'Cache-Control': 'private, max-age=3600' },
      });
    } catch { /* fall through to serve raw */ }
  }
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${origName}"`, 'Cache-Control': 'private, max-age=3600' },
  });
}

async function handleDeleteDocument(env, docId, email, admin) {
  let found = null;
  const listResult = await env.tideventure_documents.list({ include: ['customMetadata', 'httpMetadata'] });
  for (const obj of listResult.objects) {
    if (obj.key.startsWith('audit/')) continue;
    if (obj.key.endsWith(`/${docId}`)) { found = obj; break; }
  }
  if (!found) return json(404, { error: 'Document not found' });
  // Allow admin or the document owner to delete
  const uploader = found.customMetadata?.uploadedBy;
  if (!admin && uploader !== email) return json(403, { error: 'Forbidden' });
  const name = found.customMetadata?.originalName || docId;
  await env.tideventure_documents.delete(found.key);
  await logAudit(env, 'DELETE', email, name);
  return json(200, { success: true });
}

async function handleAuditLog(env) {
  const entries = [];
  const listResult = await env.tideventure_documents.list({ include: ['customMetadata', 'httpMetadata'] });
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
  return JSON.parse(await obj.text());
}

async function saveQboTokens(env, email, tokens) {
  await env.tideventure_documents.put(qboTokenKey(email), JSON.stringify(tokens), {
    httpMetadata: { contentType: 'application/json' },
  });
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
  const hosts = ['sandbox-quickbooks.api.intuit.com', 'quickbooks.api.intuit.com'];
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

  // Retrieve verifier + email from stored state
  const stored = await env.tideventure_documents.get(`qbo/oauth/${state}`);
  if (!stored) return new Response('OAuth state expired or invalid', { status: 400 });
  const { verifier, email } = JSON.parse(await stored.text());
  if (!email) return new Response('No email in state', { status: 400 });
  await env.tideventure_documents.delete(`qbo/oauth/${state}`);

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
  if (!tokens) return { qboConnected: false, invoices: [], revenue: [] };

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

    return { qboConnected: true, invoices, revenue };
  } catch (e) {
    return { qboConnected: false, invoices: [], revenue: [] };
  }
}

// ── Encryption helpers (paired with browser-side Web Crypto) ──
async function deriveKeyMaterial(secret, userEmail) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(userEmail));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
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
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encrypted);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
