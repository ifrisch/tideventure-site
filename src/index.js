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

const DEFAULT_TQ_SCHEMA = {
  year: 2025, sections: [
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
      ['boir_owner','Are you an owner or control 25% of a company registered before Jan 1, 2025?'],
      ['boir_changed','If required to file BOIR, has any previously reported information changed?'],
      ['irs_correspondence','Did you receive correspondence from the State or IRS?'],
      ['unfiled_years','Do you have prior years unfiled or with unpaid balances?'],
      ['presidential_fund','Do you want to designate $3 to the Presidential Election Campaign Fund?'],
    ]},{title:'Estimated Taxes',questions:[
      ['overpayment_refund','If overpaid, do you want refund or applied to 2026 estimated?'],
      ['income_change_2026','Do you expect considerable change in 2026 income?'],
      ['deduction_change_2026','Do you expect considerable change in 2026 deductions?'],
      ['withholding_change_2026','Do you expect considerable change in 2026 withholding?'],
      ['dependents_change_2026','Do you expect a change in dependents claimed for 2026?'],
      ['fed_estimated_payments','Did you make federal estimated tax payments for 2025?'],
      ['fed_prior_overpayment','Was any 2024 overpayment applied to 2025 estimated?'],
      ['state_estimated_payments','Did you make state estimated tax payments for 2025?'],
      ['state_prior_overpayment','Was any state 2024 overpayment applied to 2025 estimated?'],
    ]},{title:'Traditional IRA',questions:[
      ['employer_retirement_plan','Are you or spouse covered by an employer retirement plan?'],
      ['trad_ira_contribution','Did you make traditional IRA contributions for 2025?'],
    ]},{title:'Roth IRA',questions:[
      ['roth_ira_contribution','Did you make Roth IRA contributions for 2025?'],
      ['roth_conversion','Did you make a 2025 Roth IRA conversion?'],
      ['roth_recharacterization','Did you make total Roth IRA contribution recharacterizations?'],
    ]},{title:'Sales of Stocks & Securities',questions:[
      ['worthless_securities','Did any securities become worthless during 2025?'],
      ['uncollectible_debts','Did any debts become uncollectible during 2025?'],
      ['commodity_sales','Did you have commodity sales, short sales, or straddles?'],
      ['noncash_exchange','Did you exchange securities/investments for something other than cash?'],
      ['virtual_assets','Did you receive, sell, exchange, or dispose of any virtual assets?'],
    ]},{title:'Other Income',questions:[
      ['state_refund','Did you receive state/local income tax refunds during 2025?'],
      ['alimony_received','Did you receive alimony during 2025?'],
      ['unemployment_comp','Did you receive unemployment compensation during 2025?'],
      ['other_income','Did you have other income (commissions, jury pay, director fees, etc.)?'],
    ]},{title:'Other Adjustments',questions:[
      ['alimony_paid','Did you pay alimony during 2025?'],
      ['educator_expenses','Did you have educator expenses (K-12 teacher, counselor, etc.)?'],
      ['other_adjustments','Did you have any other adjustments to income?'],
    ]},{title:'Schedule A - Medical & Dental',questions:[
      ['medical_expenses_itemized','Did you have medical/dental expenses?'],
      ['medical_insurance','Did you pay medical insurance premiums?'],
      ['long_term_care_premiums_itemized','Did you pay long-term care premiums?'],
      ['prescription_drugs','Did you have prescription medicine expenses?'],
      ['medical_mileage','Did you drive tax miles for medical (21¢/mile)?'],
    ]},{title:'Schedule A - Tax Expenses',questions:[
      ['state_local_income_tax','Did you pay state/local income taxes in 2025?'],
      ['state_local_2025_tax','Did you pay 2025 state/local income taxes in 2025?'],
      ['real_estate_taxes','Did you pay real estate taxes?'],
      ['personal_property_tax','Did you pay personal property taxes?'],
      ['other_taxes','Did you pay foreign taxes or state disability taxes?'],
      ['sales_tax_major','Did you pay sales tax on major purchases?'],
      ['sales_tax_actual','Did you pay sales tax on actual expenses?'],
    ]},{title:'Interest Expenses',questions:[
      ['mortgage_interest_1098','Pay home mortgage interest on Form 1098?'],
      ['mortgage_interest_individual','Pay other mortgage interest to individuals?'],
      ['refinance_points','Refinance and pay points in 2025?'],
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
