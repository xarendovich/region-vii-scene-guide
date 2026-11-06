// Local copy of the comment server for trying the page (not used in production).
// Usage: node test/serve-local.mjs <page origin> <admin key>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const [origin = 'http://127.0.0.1:8000', key = 'local-admin-key-0123456789abcdef'] = process.argv.slice(2);
const mf = new Miniflare({
  modules: true, scriptPath: here('../src/worker.js'), d1Databases: ['DB'], port: 8787, host: '127.0.0.1',
  bindings: { ADMIN_KEY: key, ALLOWED_ORIGINS: origin, AUTO_APPROVE: 'false' },
});
const db = await mf.getD1Database('DB');
for (const s of readFileSync(here('../schema.sql'), 'utf8').split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(s).run();
console.log('comment server on http://127.0.0.1:8787 for', origin);
