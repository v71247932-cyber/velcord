// Velcord on its own machine: runs the same worker code as Cloudflare, with SQLite instead of D1 and
// files on disk instead of Workers KV. Clips are kept 24 hours and then deleted.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.VELCORD_DATA || path.join(HERE, 'data');
const PORT = parseInt(process.env.PORT || '8790');
const DIST = path.join(HERE, 'dist');
fs.mkdirSync(path.join(DATA, 'media'), { recursive: true });

// ---------- D1 look-alike over SQLite ----------
const sql = new Database(path.join(DATA, 'velcord.db'));
sql.pragma('journal_mode = WAL');
sql.pragma('foreign_keys = ON');
sql.pragma('busy_timeout = 5000');
const hasUsers = sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!hasUsers) sql.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));

const clean = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof ArrayBuffer ? Buffer.from(v) : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
const OK_META = (changes = 0, id = 0) => ({ changes, last_row_id: id, duration: 0, rows_read: 0, rows_written: 0 });

class Stmt {
  constructor(text, params = []) { this.text = text; this.params = params; }
  bind(...p) {
    p = p.map(clean);
    // D1 allows ?1, ?2 used several times; better-sqlite3 does not, so turn them into plain ? with the values repeated
    if (/\?\d/.test(this.text)) {
      const order = [];
      const text = this.text.replace(/\?(\d+)/g, (_m, n) => { order.push(p[parseInt(n) - 1]); return '?'; });
      return new Stmt(text, order);
    }
    return new Stmt(this.text, p);
  }
  _exec() {
    const st = sql.prepare(this.text);
    if (st.reader) return { results: st.all(...this.params), meta: OK_META() };
    const r = st.run(...this.params);
    return { results: [], meta: OK_META(r.changes, Number(r.lastInsertRowid)) };
  }
  async first(col) { const st = sql.prepare(this.text); if (!st.reader) { st.run(...this.params); return null; } const row = st.get(...this.params); if (!row) return null; return col ? row[col] : row; }
  async all() { const r = this._exec(); return { success: true, ...r }; }
  async run() { const r = this._exec(); return { success: true, ...r }; }
  async raw() { const st = sql.prepare(this.text); return st.raw().all(...this.params); }
}
const DB = {
  prepare: text => new Stmt(text),
  async exec(text) { sql.exec(text); return { count: 1, duration: 0 }; },
  async batch(list) {
    const out = [];
    sql.transaction(() => { for (const s of list) out.push({ success: true, ...s._exec() }); })();
    return out;
  },
};

// ---------- KV look-alike: values are files, an index says when each one expires ----------
const kvdb = new Database(path.join(DATA, 'media.db'));
kvdb.pragma('journal_mode = WAL');
kvdb.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, file TEXT NOT NULL, expires INTEGER)');
const fileFor = key => crypto.createHash('sha1').update(key).digest('hex');
const MEDIA = {
  async put(key, value, opts = {}) {
    const buf = typeof value === 'string' ? Buffer.from(value) : value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(await new Response(value).arrayBuffer());
    const file = fileFor(key);
    const tmp = path.join(DATA, 'media', file + '.tmp');
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(DATA, 'media', file));
    const expires = opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : null;
    kvdb.prepare('INSERT INTO kv (key, file, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET file = excluded.file, expires = excluded.expires').run(key, file, expires);
  },
  async get(key, type) {
    const row = kvdb.prepare('SELECT file, expires FROM kv WHERE key = ?').get(key);
    if (!row || (row.expires && row.expires < Date.now() / 1000)) return null;
    let b;
    try { b = fs.readFileSync(path.join(DATA, 'media', row.file)); } catch { return null; }
    if (type === 'arrayBuffer') return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    if (type === 'text' || type === undefined) return b.toString('utf8');
    return b;
  },
  async delete(key) {
    const row = kvdb.prepare('SELECT file FROM kv WHERE key = ?').get(key);
    kvdb.prepare('DELETE FROM kv WHERE key = ?').run(key);
    if (row) fs.rm(path.join(DATA, 'media', row.file), () => {});
  },
};
function purgeExpired() {
  const rows = kvdb.prepare('SELECT key, file FROM kv WHERE expires IS NOT NULL AND expires < ?').all(Math.floor(Date.now() / 1000));
  for (const r of rows) { kvdb.prepare('DELETE FROM kv WHERE key = ?').run(r.key); fs.rm(path.join(DATA, 'media', r.file), () => {}); }
  // files nobody points to (a half-written upload)
  const known = new Set(kvdb.prepare('SELECT file FROM kv').all().map(r => r.file));
  for (const f of fs.readdirSync(path.join(DATA, 'media'))) {
    const p = path.join(DATA, 'media', f);
    if (!known.has(f.replace(/\.tmp$/, '')) && Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rm(p, () => {});
  }
  if (rows.length) console.log(`purged ${rows.length} expired media files`);
}
setInterval(() => { try { purgeExpired(); } catch (e) { console.error('purge failed', e); } }, 10 * 60 * 1000);

// ---------- static files (what Pages serves on Cloudflare) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.sh': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.zip': 'application/zip', '.gz': 'application/gzip' };
const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.join(DIST, rel);
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (!path.extname(rel)) file = path.join(DIST, 'index.html'); // single-page app: any page path shows the app
      else return new Response('Not found', { status: 404 });
    }
    const ext = path.extname(file);
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
    return new Response(request.method === 'HEAD' ? null : fs.readFileSync(file), { headers });
  },
};

// ---------- the worker itself ----------
const worker = (await import(path.join(HERE, 'worker.mjs'))).default;
const env = { DB, MEDIA, ASSETS, JWT_SECRET: process.env.JWT_SECRET, SYSTEM_KEY: process.env.SYSTEM_KEY };
if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not set');

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || 'localhost';
    const url = `https://${host}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await worker.fetch(request, env, { waitUntil: p => { Promise.resolve(p).catch(e => console.error('waitUntil', e)); } });
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(response.status, headers);
    if (!response.body) return res.end();
    const stream = Readable.fromWeb(response.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    console.error('request failed', req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, '127.0.0.1', () => console.log(`velcord listening on 127.0.0.1:${PORT}`));
