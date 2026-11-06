// Region VII Scene Guide comment server (Cloudflare Worker + D1).
//
// Who can do what:
//   Anyone      POST /api/comments              leave a comment (checked, size-limited, rate-limited)
//   Anyone      GET  /api/comments?protocol=ID  read the comments the owner has approved for one protocol
//   Owner only  GET    /api/admin/comments      read every comment          (needs the admin key)
//   Owner only  PATCH  /api/admin/comments/:id  approve / resolve a comment (needs the admin key)
//   Owner only  DELETE /api/admin/comments/:id  delete a comment            (needs the admin key)
//
// Settings (wrangler.toml [vars] and `wrangler secret put`):
//   ADMIN_KEY        secret. The owner's key for the review page. Never put it in the page or the repo.
//   ALLOWED_ORIGINS  comma-separated web addresses allowed to call this server (the page's address).
//   AUTO_APPROVE     "false" (default): new comments wait for the owner before anyone else sees them.
//                    "true": new comments show on the page straight away (the owner can still hide them).

const LIMITS = {
  bodyBytes: 8 * 1024,
  name: 60,
  text: 1000,
  title: 200,
  perVisitorPer10Min: 5,
  waitingForReview: 500,
  publicList: 200,
  adminList: 1000,
};

const PROTOCOL_ID = /^[A-Za-z0-9]{1,8}$/;
const COMMENT_ID = /^[a-f0-9]{32}$/;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      return json({ error: 'server error' }, 500, request, env);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (request.method === 'OPTIONS') return preflight(request, env);

  if (path === '/api/comments') {
    if (request.method === 'GET') return listPublic(url, request, env);
    if (request.method === 'POST') return createComment(request, env);
    return json({ error: 'method not allowed' }, 405, request, env);
  }

  if (path === '/api/admin/comments' || path.startsWith('/api/admin/comments/')) {
    if (!(await isOwner(request, env))) return json({ error: 'admin key required' }, 401, request, env);
    if (path === '/api/admin/comments' && request.method === 'GET') return listAdmin(url, request, env);
    const id = path.slice('/api/admin/comments/'.length);
    if (!COMMENT_ID.test(id)) return json({ error: 'not found' }, 404, request, env);
    if (request.method === 'PATCH') return updateComment(id, request, env);
    if (request.method === 'DELETE') return deleteComment(id, request, env);
    return json({ error: 'method not allowed' }, 405, request, env);
  }

  return json({ error: 'not found' }, 404, request, env);
}

// ---------- public ----------

async function listPublic(url, request, env) {
  const protocol = url.searchParams.get('protocol') || '';
  if (!PROTOCOL_ID.test(protocol)) return json({ error: 'protocol required' }, 400, request, env);
  const { results } = await env.DB.prepare(
    `SELECT name, text, created_at FROM comments
     WHERE protocol_id = ?1 AND approved = 1 AND resolved = 0
     ORDER BY created_at DESC LIMIT ?2`
  ).bind(protocol, LIMITS.publicList).all();
  const items = (results || []).map(r => ({ name: r.name, text: r.text, createdAt: r.created_at }));
  return json({ items }, 200, request, env);
}

async function createComment(request, env) {
  if (!originAllowed(request, env)) return json({ error: 'origin not allowed' }, 403, request, env);
  const body = await readJson(request);
  if (!body) return json({ error: 'bad request' }, 400, request, env);

  // Hidden form field that people never see; simple bots fill it in.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return json({ status: 'received' }, 201, request, env);
  }

  const protocolId = String(body.protocolId || '');
  const name = clean(body.name, LIMITS.name);
  const text = clean(body.text, LIMITS.text, true);
  const title = clean(body.protocolTitle, LIMITS.title);
  if (!PROTOCOL_ID.test(protocolId)) return json({ error: 'unknown protocol' }, 400, request, env);
  if (!name || !text) return json({ error: 'name and comment are required' }, 400, request, env);

  const visitor = await visitorTag(request, env);
  const now = new Date();
  const since = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM comments WHERE visitor = ?1 AND created_at > ?2'
  ).bind(visitor, since).first();
  if (recent && recent.n >= LIMITS.perVisitorPer10Min) {
    return json({ error: 'too many comments, try again in a few minutes' }, 429, request, env);
  }
  const waiting = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM comments WHERE approved = 0 AND resolved = 0'
  ).first();
  if (waiting && waiting.n >= LIMITS.waitingForReview) {
    return json({ error: 'comments are paused, try again later' }, 503, request, env);
  }

  const approved = String(env.AUTO_APPROVE || 'false').toLowerCase() === 'true' ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO comments (id, protocol_id, protocol_title, name, text, created_at, approved, resolved, visitor)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)`
  ).bind(newId(), protocolId, title, name, text, now.toISOString(), approved, visitor).run();

  return json({ status: approved ? 'shown' : 'waiting for review' }, 201, request, env);
}

// ---------- owner ----------

async function listAdmin(url, request, env) {
  const resolved = url.searchParams.get('resolved') === '1' ? 1 : 0;
  const { results } = await env.DB.prepare(
    `SELECT id, protocol_id, protocol_title, name, text, created_at, approved, resolved, resolved_at
     FROM comments WHERE resolved = ?1 ORDER BY created_at DESC LIMIT ?2`
  ).bind(resolved, LIMITS.adminList).all();
  const items = (results || []).map(r => ({
    id: r.id,
    protocolId: r.protocol_id,
    protocolTitle: r.protocol_title,
    name: r.name,
    text: r.text,
    createdAt: r.created_at,
    approved: r.approved === 1,
    resolved: r.resolved === 1,
    resolvedAt: r.resolved_at,
  }));
  return json({ items }, 200, request, env);
}

async function updateComment(id, request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad request' }, 400, request, env);
  const sets = [];
  const args = [];
  if (typeof body.approved === 'boolean') {
    sets.push(`approved = ?${args.length + 1}`);
    args.push(body.approved ? 1 : 0);
  }
  if (typeof body.resolved === 'boolean') {
    sets.push(`resolved = ?${args.length + 1}`);
    args.push(body.resolved ? 1 : 0);
    sets.push(`resolved_at = ?${args.length + 1}`);
    args.push(body.resolved ? new Date().toISOString() : null);
  }
  if (!sets.length) return json({ error: 'nothing to change' }, 400, request, env);
  args.push(id);
  const res = await env.DB.prepare(
    `UPDATE comments SET ${sets.join(', ')} WHERE id = ?${args.length}`
  ).bind(...args).run();
  if (!res.meta || !res.meta.changes) return json({ error: 'not found' }, 404, request, env);
  return json({ status: 'updated' }, 200, request, env);
}

async function deleteComment(id, request, env) {
  const res = await env.DB.prepare('DELETE FROM comments WHERE id = ?1').bind(id).run();
  if (!res.meta || !res.meta.changes) return json({ error: 'not found' }, 404, request, env);
  return json({ status: 'deleted' }, 200, request, env);
}

async function isOwner(request, env) {
  const key = env.ADMIN_KEY || '';
  if (key.length < 24) return false; // refuse to work with a missing or weak key
  const header = request.headers.get('Authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given) return false;
  return sameSecret(given, key);
}

// ---------- helpers ----------

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  return Boolean(origin) && allowedOrigins(env).includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (origin && allowedOrigins(env).includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function preflight(request, env) {
  return new Response(null, { status: originAllowed(request, env) ? 204 : 403, headers: corsHeaders(request, env) });
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      corsHeaders(request, env)
    ),
  });
}

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) return null;
  const raw = await request.text();
  if (raw.length > LIMITS.bodyBytes) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

// Trims, removes control characters (keeps line breaks in comments) and caps the length.
function clean(value, max, keepNewlines = false) {
  if (typeof value !== 'string') return '';
  const pattern = keepNewlines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g;
  return value.replace(pattern, '').trim().slice(0, max);
}

function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(keyText, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Stores a keyed hash of the visitor's network address, never the address itself; used only for rate limits.
async function visitorTag(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return (await hmacHex(env.ADMIN_KEY || 'no-key', 'visitor:' + ip)).slice(0, 32);
}

// Compares two secrets without leaking how many characters matched.
async function sameSecret(a, b) {
  const salt = newId();
  const [x, y] = await Promise.all([hmacHex(salt, a), hmacHex(salt, b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
