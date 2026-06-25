import { jwtVerify, createRemoteJWKSet } from 'jose';

const TEAM_DOMAIN = 'https://tideventure.cloudflareaccess.com';
const CERTS_URL = `${TEAM_DOMAIN}/cdn-cgi/access/certs`;
const JWKS = createRemoteJWKSet(new URL(CERTS_URL));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    async function getAuthUser() {
      const token = request.headers.get('cf-access-jwt-assertion');
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, JWKS, {
          issuer: TEAM_DOMAIN,
          audience: env.AUD_TAG,
        });
        return payload.email || null;
      } catch {
        return null;
      }
    }

    function isAdmin(email) {
      return email && email.endsWith('@tideventurecpa.com');
    }

    const email = await getAuthUser();
    if (!email) return json(401, { error: 'Unauthorized' });

    if (url.pathname === '/api/documents' && method === 'GET') {
      return handleListDocuments(env, email, isAdmin(email));
    }

    if (url.pathname === '/api/documents/upload' && method === 'POST') {
      return handleUploadDocument(request, env, email);
    }

    if (url.pathname === '/api/audit' && method === 'GET') {
      if (!isAdmin(email)) return json(403, { error: 'Admin access required' });
      return handleAuditLog(env);
    }

    if (url.pathname === '/api/key-material' && method === 'GET') {
      return handleKeyMaterial(env, email);
    }

    const docMatch = url.pathname.match(/^\/api\/documents\/([^\/]+)$/);
    if (docMatch) {
      const docId = docMatch[1];
      if (method === 'GET') {
        return handleDownloadDocument(env, docId, email, isAdmin(email));
      }
      if (method === 'DELETE') {
        return handleDeleteDocument(env, docId, email, isAdmin(email));
      }
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
    action,
    email,
    detail,
    timestamp: new Date().toISOString(),
  }), { httpMetadata: { contentType: 'application/json' } });
}

async function listAllDocs(env) {
  const objects = [];
  for await (const obj of env.tideventure_documents.list()) {
    if (!obj.key.startsWith('audit/')) {
      objects.push(obj);
    }
  }
  return objects;
}

async function handleListDocuments(env, email, admin) {
  const objects = [];
  for await (const obj of env.tideventure_documents.list()) {
    if (obj.key.startsWith('audit/')) continue;
    if (admin || obj.customMetadata?.uploadedBy === email) {
      objects.push({
        id: obj.key.split('/').pop(),
        name: obj.customMetadata?.originalName || obj.key,
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

async function handleUploadDocument(request, env, email) {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file) return json(400, { error: 'No file provided' });

  const id = crypto.randomUUID();
  const key = `${email}/${id}`;

  await env.tideventure_documents.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: {
      originalName: file.name,
      uploadedBy: email,
      uploadedAt: new Date().toISOString(),
    },
  });

  await logAudit(env, 'UPLOAD', email, `${file.name} (${file.size} bytes)`);

  return json(201, { id, key, name: file.name });
}

async function handleDownloadDocument(env, docId, email, admin) {
  let found = null;
  for await (const obj of env.tideventure_documents.list()) {
    if (obj.key.startsWith('audit/')) continue;
    if (obj.key.endsWith(`/${docId}`)) {
      found = obj;
      break;
    }
  }
  if (!found) return json(404, { error: 'Document not found' });

  const uploader = found.customMetadata?.uploadedBy;
  if (!admin && uploader !== email) {
    return json(403, { error: 'Forbidden' });
  }

  const object = await env.tideventure_documents.get(found.key);
  if (!object) return json(404, { error: 'Document not found' });

  await logAudit(env, 'DOWNLOAD', email, found.customMetadata?.originalName || docId);
  const origName = found.customMetadata?.originalName || docId;

  // Admin downloads: decrypt server-side and serve plaintext
  if (admin) {
    const ciphertext = await object.arrayBuffer();
    try {
      const plaintext = await decryptWithKey(env.DOC_ENC_KEY, uploader || email, ciphertext);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${origName}"`,
        'Cache-Control': 'private, max-age=3600',
      };
      return new Response(plaintext, { headers });
    } catch {
      // If decryption fails, serve raw
      const headers = {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${origName}"`,
        'Cache-Control': 'private, max-age=3600',
      };
      return new Response(object.body, { headers });
    }
  }

  // Regular user download: serve encrypted blob for client-side decryption
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `inline; filename="${origName}.enc"`,
    'Cache-Control': 'private, max-age=3600',
  };
  return new Response(object.body, { headers });
}

async function handleDeleteDocument(env, docId, email, admin) {
  if (!admin) return json(403, { error: 'Admin access required' });

  let found = null;
  for await (const obj of env.tideventure_documents.list()) {
    if (obj.key.startsWith('audit/')) continue;
    if (obj.key.endsWith(`/${docId}`)) {
      found = obj;
      break;
    }
  }
  if (!found) return json(404, { error: 'Document not found' });

  const name = found.customMetadata?.originalName || docId;
  await env.tideventure_documents.delete(found.key);

  await logAudit(env, 'DELETE', email, name);

  return json(200, { success: true });
}

async function handleAuditLog(env) {
  const entries = [];
  for await (const obj of env.tideventure_documents.list()) {
    if (!obj.key.startsWith('audit/')) continue;
    const data = await env.tideventure_documents.get(obj.key);
    if (data) {
      const body = await data.text();
      try {
        entries.push(JSON.parse(body));
      } catch {}
    }
  }
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return json(200, { audit: entries.slice(0, 200) });
}

// ── Client-side encryption key material ──
async function handleKeyMaterial(env, email) {
  const raw = await deriveKeyMaterial(env.DOC_ENC_KEY, email);
  return json(200, { keyMaterial: raw });
}

// ── Encryption helpers (used server-side for admin downloads) ──
async function deriveKeyMaterial(secret, userEmail) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(userEmail));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function decryptWithKey(secret, userEmail, ciphertext) {
  const enc = new TextEncoder();
  const keyMaterialHex = await deriveKeyMaterial(secret, userEmail);
  const keyMaterial = hexToBytes(keyMaterialHex);
  const bytes = new Uint8Array(ciphertext);
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const encrypted = bytes.slice(28);

  const baseKey = await crypto.subtle.importKey('raw', keyMaterial, 'PBKDF2', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encrypted);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}
