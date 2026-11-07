// Run with: npm test  (inside comments-server/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ORIGIN = 'https://xarendovich.github.io';
const KEY = 'test-admin-key-0123456789abcdef';
let mf;

async function call(path, { method = 'GET', body, key, origin = ORIGIN, ip = '1.1.1.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await mf.dispatchFetch('http://local' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
}
const post = (b, o = {}) => call('/api/comments', Object.assign({ method: 'POST', body: b }, o));
const comment = (extra = {}) => Object.assign({ protocolId: '6', protocolTitle: 'Cardiac Arrest', name: 'Sam', text: 'Check the dose' }, extra);

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: here('../src/worker.js'),
    d1Databases: ['DB'],
    bindings: { ADMIN_KEY: KEY, ALLOWED_ORIGINS: ORIGIN, AUTO_APPROVE: 'false' },
  });
  const db = await mf.getD1Database('DB');
  for (const stmt of readFileSync(here('../schema.sql'), 'utf8').split(';').map(s => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
});
after(async () => { await mf.dispose(); });

test('a new comment is held for review and not shown publicly', async () => {
  const r = await post(comment());
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'waiting for review');
  const pub = await call('/api/comments?protocol=6');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.items.length, 0);
});

test('the public cannot read the review list, change or delete comments', async () => {
  assert.equal((await call('/api/admin/comments')).status, 401);
  assert.equal((await call('/api/admin/comments', { key: 'wrong-key-wrong-key-wrong-key' })).status, 401);
  const list = await call('/api/admin/comments', { key: KEY });
  const id = list.data.items[0].id;
  assert.equal((await call('/api/admin/comments/' + id, { method: 'PATCH', body: { approved: true } })).status, 401);
  assert.equal((await call('/api/admin/comments/' + id, { method: 'DELETE' })).status, 401);
});

test('the owner approves, the comment shows, resolving hides it again', async () => {
  const list = await call('/api/admin/comments', { key: KEY });
  const item = list.data.items.find(c => c.text === 'Check the dose');
  assert.equal(item.approved, false);
  assert.equal((await call('/api/admin/comments/' + item.id, { method: 'PATCH', key: KEY, body: { approved: true } })).status, 200);
  let pub = await call('/api/comments?protocol=6');
  assert.deepEqual(Object.keys(pub.data.items[0]).sort(), ['createdAt', 'name', 'text']);
  assert.equal(pub.data.items[0].text, 'Check the dose');
  await call('/api/admin/comments/' + item.id, { method: 'PATCH', key: KEY, body: { resolved: true } });
  pub = await call('/api/comments?protocol=6');
  assert.equal(pub.data.items.length, 0);
  const done = await call('/api/admin/comments?resolved=1', { key: KEY });
  assert.ok(done.data.items.some(c => c.id === item.id && c.resolved && c.resolvedAt));
});

test('the owner can delete a comment', async () => {
  await post(comment({ text: 'spam spam', ip: '2.2.2.2' }), { ip: '2.2.2.2' });
  const list = await call('/api/admin/comments', { key: KEY });
  const item = list.data.items.find(c => c.text === 'spam spam');
  assert.equal((await call('/api/admin/comments/' + item.id, { method: 'DELETE', key: KEY })).status, 200);
  assert.equal((await call('/api/admin/comments/' + item.id, { method: 'DELETE', key: KEY })).status, 404);
});

test('bad input is refused', async () => {
  assert.equal((await post(comment({ protocolId: '../x' }))).status, 400);
  assert.equal((await post(comment({ name: '   ' }))).status, 400);
  assert.equal((await post(comment({ text: '' }))).status, 400);
  assert.equal((await post(comment({ text: 'x'.repeat(9000) }))).status, 400);
  assert.equal((await call('/api/comments?protocol=<script>')).status, 400);
});

test('long text is cut to the limit and markup is stored as plain text', async () => {
  await post(comment({ protocolId: '7', text: '<img src=x onerror=alert(1)>' + 'y'.repeat(1500) }), { ip: '3.3.3.3' });
  const list = await call('/api/admin/comments', { key: KEY });
  const item = list.data.items.find(c => c.protocolId === '7');
  assert.equal(item.text.length, 1000);
  assert.ok(item.text.startsWith('<img'));
});

test('other websites cannot post, and get no CORS permission', async () => {
  const r = await post(comment(), { origin: 'https://evil.example', ip: '4.4.4.4' });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  const ok = await call('/api/comments?protocol=6');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('the hidden bot field silently drops the comment', async () => {
  const r = await post(comment({ text: 'bot text', website: 'http://spam' }), { ip: '5.5.5.5' });
  assert.equal(r.status, 201);
  const list = await call('/api/admin/comments', { key: KEY });
  assert.ok(!list.data.items.some(c => c.text === 'bot text'));
});

test('one visitor is limited to 5 comments per 10 minutes', async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(comment({ text: 'n' + i }), { ip: '6.6.6.6' })).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429, 429]);
  assert.equal((await post(comment({ text: 'other' }), { ip: '7.7.7.7' })).status, 201);
});

test('the review list does not work if the admin key was never set', async () => {
  const weak = new Miniflare({
    modules: true, scriptPath: here('../src/worker.js'), d1Databases: ['DB'],
    bindings: { ADMIN_KEY: '', ALLOWED_ORIGINS: ORIGIN },
  });
  const r = await weak.dispatchFetch('http://local/api/admin/comments', { headers: { Authorization: 'Bearer ' } });
  assert.equal(r.status, 401);
  await weak.dispose();
});
