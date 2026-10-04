/// <reference types="@cloudflare/workers-types" />
// Velcord - Cloudflare Worker Backend
// Handles all API requests for auth, friends, and messages

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ASSETS: Fetcher;
  /** Workers KV: holds the video chunks, which expire on their own */
  MEDIA?: KVNamespace;
  /** Secret that lets the owner post official notifications as the Velcord account */
  SYSTEM_KEY?: string;
}

// --- Simple JWT implementation using Web Crypto ---
async function signJWT(payload: object, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${data}.${sigB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<{ userId: number; username: string } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    return JSON.parse(atob(body));
  } catch {
    return null;
  }
}

// --- Password hashing using PBKDF2 ---
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  const derived = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return derived === hashHex;
}

// --- Message retention: messages are kept 5 days, then deleted ---
const MESSAGE_TTL = 5 * 24 * 60 * 60;
const NOT_EXPIRED = (col: string) => `${col} >= unixepoch() - ${MESSAGE_TTL}`;
let lastPurge = 0;

async function purgeRemovedGifs(env: Env) {
  if (!env.MEDIA) return;
  const gone = await env.DB.prepare(`SELECT id FROM gifs WHERE removed_at IS NOT NULL AND removed_at < unixepoch() - ${MESSAGE_TTL} LIMIT 50`).all();
  for (const g of gone.results as { id: string }[]) {
    await env.MEDIA.delete(`gif:${g.id}`);
    await env.DB.prepare('DELETE FROM gifs WHERE id = ?').bind(g.id).run();
  }
}

async function purgeOldMessages(env: Env) {
  await purgeRemovedGifs(env);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM direct_messages WHERE created_at < unixepoch() - ${MESSAGE_TTL}`),
    env.DB.prepare(`DELETE FROM group_messages WHERE created_at < unixepoch() - ${MESSAGE_TTL}`),
    env.DB.prepare('DELETE FROM uploads WHERE expires_at <= unixepoch()'),
    env.DB.prepare('DELETE FROM videos WHERE expires_at <= unixepoch()'), // the KV chunks expire by themselves
    env.DB.prepare('DELETE FROM typing WHERE at < (unixepoch() - 60) * 1000'),
  ]);
}

// --- Official "Velcord" account: verified tick, read-only for users, posts notifications ---
const SYSTEM_NAME = 'Velcord';
const SYSTEM_RECIPIENTS = ['idk123idk123dasa']; // only these accounts get Velcord in their friend list
const isVerified = (username: string | null | undefined) => !!username && username.toLowerCase() === SYSTEM_NAME.toLowerCase();
const isReservedName = (username: string) => /velcord/i.test(username) || username.trim().toLowerCase() === 'test';
// The blue check also marks the test account. Unlike Velcord it is an ordinary account: it can write, call and be called.
const TICK_NAMES = ['test'];
const hasTick = (username: string | null | undefined) => isVerified(username) || (!!username && TICK_NAMES.includes(username.toLowerCase()));

async function ensureSystemUser(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(SYSTEM_NAME).first() as { id: number } | null;
  if (row) return row.id;
  // Nobody can log in to this account: the stored hash is random and the password is never known
  const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
  const created = await env.DB.prepare("INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, '#5865f2') RETURNING id")
    .bind(SYSTEM_NAME, `${hex(16)}:${hex(32)}`).first() as { id: number };
  return created.id;
}

async function isSystemUserId(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first() as { username: string } | null;
  return isVerified(row?.username);
}

async function handleSystemNotify(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-System-Key');
  if (!env.SYSTEM_KEY || !key || key !== env.SYSTEM_KEY) return err('Not found', 404);
  const { to, text } = await request.json() as { to?: string; text?: string };
  if (!to || !text?.trim()) return err('Missing recipient or text');
  if (text.length > 2000) return err('Text too long (max 2000 chars)');
  const target = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?').bind(to).first() as { id: number; username: string } | null;
  if (!target) return err('No such user', 404);

  const sys = await ensureSystemUser(env);
  const pair = "(requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)";
  let fr = await env.DB.prepare(`SELECT id, status FROM friendships WHERE ${pair}`).bind(sys, target.id, target.id, sys).first() as { id: number; status: string } | null;
  if (!fr && SYSTEM_RECIPIENTS.includes(target.username.toLowerCase())) {
    await env.DB.prepare("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'accepted')").bind(sys, target.id).run();
    fr = { id: 0, status: 'accepted' };
  } else if (fr && fr.status !== 'accepted' && SYSTEM_RECIPIENTS.includes(target.username.toLowerCase())) {
    await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").bind(fr.id).run();
  }
  if (!fr) return err('Velcord is only in the friend list of approved accounts', 403);

  const msg = await env.DB.prepare('INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES (?, ?, ?) RETURNING id, created_at')
    .bind(sys, target.id, text.trim()).first() as { id: number; created_at: number };
  return json({ id: msg.id, createdAt: msg.created_at, to: target.username }, 201);
}

// Delivery/read state of the notifications Velcord sent to one user (needs the secret key)
async function handleSystemStatus(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-System-Key');
  if (!env.SYSTEM_KEY || !key || key !== env.SYSTEM_KEY) return err('Not found', 404);
  const { to } = await request.json() as { to?: string };
  const target = to ? await env.DB.prepare('SELECT id, username, last_seen FROM users WHERE username = ?').bind(to).first() as { id: number; username: string; last_seen: number | null } | null : null;
  if (!target) return err('No such user', 404);
  const sys = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(SYSTEM_NAME).first() as { id: number } | null;
  if (!sys) return json({ user: target.username, messages: [] });
  const rows = await env.DB.prepare(`SELECT id, content, created_at, delivered_at, read_at FROM direct_messages
    WHERE sender_id = ? AND receiver_id = ? ORDER BY id DESC LIMIT 20`).bind(sys.id, target.id).all();
  return json({
    user: target.username,
    onlineNow: isOnline(target.last_seen),
    lastSeen: target.last_seen,
    messages: rows.results.map((r: any) => ({ id: r.id, text: String(r.content).slice(0, 80), sentAt: r.created_at, deliveredAt: r.delivered_at, readAt: r.read_at })),
  });
}

// Removes the friendship between two accounts; needs the secret key
async function handleSystemUnfriend(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-System-Key');
  if (!env.SYSTEM_KEY || !key || key !== env.SYSTEM_KEY) return err('Not found', 404);
  const { a, b } = await request.json() as { a?: string; b?: string };
  const ua = a ? await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(a).first() as { id: number } | null : null;
  const ub = b ? await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(b).first() as { id: number } | null : null;
  if (!ua || !ub) return err('No such user', 404);
  const r = await env.DB.prepare('DELETE FROM friendships WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)').bind(ua.id, ub.id).run();
  return json({ removed: r.meta.changes });
}

// Recent video clips (to diagnose playback problems); needs the secret key
async function handleSystemVideos(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-System-Key');
  if (!env.SYSTEM_KEY || !key || key !== env.SYSTEM_KEY) return err('Not found', 404);
  const rows = await env.DB.prepare(`SELECT v.id, u.username, v.mime, v.size, v.chunks, v.ready, v.created_at, v.expires_at
    FROM videos v JOIN users u ON u.id = v.owner_id ORDER BY v.created_at DESC LIMIT 15`).all();
  return json(rows.results);
}

// --- Personal GIF list ---
// Each person keeps a list of GIFs (.gif, animated .webp or .png) and sends them from the GIF button.
// The files live in Workers KV without expiry. Removing one only hides it from the list; the file stays
// for as long as messages are kept (5 days), so GIFs already sent do not break.
const GIF_PER_USER = 40;

// GIFs are added from a link only; no file is stored for them any more (older stored GIFs are still served)
async function handleGifUpload(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  return err('GIFs are added from a link now. Paste the link of a .gif.', 410);
}

async function handleGifList(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const rows = await env.DB.prepare('SELECT id, name, mime, size, created_at, url, origin FROM gifs WHERE owner_id = ? AND removed_at IS NULL ORDER BY created_at DESC, rowid DESC').bind(auth.userId).all();
  return json({ max: GIF_PER_USER, gifs: rows.results.map((r: any) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, createdAt: r.created_at, url: r.url ?? null, origin: r.origin ?? r.id })) });
}

// Put a GIF that someone else sent into my own list. A GIF from the library is copied, so it stays even if
// the sender removes theirs. A GIF from a link is saved as its address (nothing is downloaded here).
// A person can protect their GIFs. Then nobody else can copy them into their own list, whether the GIF is
// theirs, or a copy they hold of somebody else's (the first uploader decides too).
// Only this account may use "Protect my GIFs"
const GIF_PROTECT_USER = 'idk';
async function gifProtectedFor(env: Env, requesterId: number, gifIds: string[]): Promise<boolean> {
  const ids = Array.from(new Set(gifIds));
  const row = await env.DB.prepare(`SELECT 1 FROM gifs g JOIN users u ON u.id = g.owner_id
    WHERE u.gifs_protected = 1 AND u.username = ? COLLATE NOCASE AND g.owner_id != ? AND g.id IN (${ids.map(() => '?').join(',')})`).bind(GIF_PROTECT_USER, requesterId, ...ids).first();
  return !!row;
}

async function handleGifSave(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { url } = await request.json() as { gifId?: string; url?: string };

  const mine = await env.DB.prepare('SELECT COUNT(*) as c FROM gifs WHERE owner_id = ? AND removed_at IS NULL').bind(auth.userId).first() as { c: number };
  const newId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');

  if (url !== undefined) {
    let u: URL;
    try { u = new URL(url); } catch { return err('Not a GIF link'); }
    if (u.protocol !== 'https:' || url.length > 600 || !/\.(gif|webp|apng)$/i.test(u.pathname)) return err('Not a GIF link');
    const have = await env.DB.prepare('SELECT id FROM gifs WHERE owner_id = ? AND url = ? AND removed_at IS NULL').bind(auth.userId, url).first() as { id: string } | null;
    if (have) return json({ id: have.id, name: 'GIF', mime: 'image/gif', size: 0, url, origin: have.id, createdAt: Math.floor(Date.now() / 1000) });
    if (mine.c >= GIF_PER_USER) return err(`Your list is full (${GIF_PER_USER} GIFs). Remove one first.`, 429);
    const name = decodeURIComponent(u.pathname.split('/').pop() || 'GIF').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60) || 'GIF';
    await env.DB.prepare('INSERT INTO gifs (id, owner_id, name, mime, size, url, origin) VALUES (?, ?, ?, ?, 0, ?, ?)').bind(newId, auth.userId, name, /\.webp$/i.test(u.pathname) ? 'image/webp' : 'image/gif', url, newId).run();
    return json({ id: newId, name, mime: 'image/gif', size: 0, url, origin: newId, createdAt: Math.floor(Date.now() / 1000) }, 201);
  }

  // A GIF stored here (from before links only) is not copied any more; only links are saved
  return err('This GIF cannot be copied. Save it from its link instead.', 410);
}

// Which original GIF each id in a message is a copy of (so the star can tell it is already in my list)
async function handleGifOrigins(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { ids } = await request.json() as { ids?: string[] };
  const list = (Array.isArray(ids) ? ids : []).filter(i => typeof i === 'string' && /^[a-f0-9]{32}$/.test(i)).slice(0, 50);
  const out: Record<string, string | null> = {};
  for (const i of list) out[i] = null;
  if (list.length > 0) {
    const rows = await env.DB.prepare(`SELECT id, origin FROM gifs WHERE id IN (${list.map(() => '?').join(',')})`).bind(...list).all();
    for (const r of rows.results as { id: string; origin: string | null }[]) out[r.id] = r.origin ?? r.id;
    // Which of them cannot be copied by this person (an extra key, so older pages keep working)
    const locked: string[] = [];
    for (const r of rows.results as { id: string; origin: string | null }[]) {
      if (await gifProtectedFor(env, auth.userId, [r.id, r.origin ?? r.id])) locked.push(r.id);
    }
    (out as Record<string, unknown>).__protected = locked;
  }
  return json(out);
}

async function handleGifFile(env: Env, id: string): Promise<Response> {
  if (!env.MEDIA) return err('Storage is not configured', 503);
  const row = await env.DB.prepare('SELECT mime FROM gifs WHERE id = ?').bind(id).first() as { mime: string } | null;
  if (!row) return err('Not found', 404);
  const buf = await env.MEDIA.get(`gif:${id}`, 'arrayBuffer');
  if (!buf) return err('Not found', 404);
  return new Response(buf, {
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': 'public, max-age=31536000, immutable', // the id never points at another file
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
    },
  });
}

async function handleGifRemove(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const res = await env.DB.prepare('UPDATE gifs SET removed_at = unixepoch() WHERE id = ? AND owner_id = ? AND removed_at IS NULL').bind(id, auth.userId).run() as any;
  if (!res?.meta?.changes) return err('Not found', 404);
  return json({ success: true });
}

// --- GIF behind a link ---
// A Tenor link is a web page, not a picture. The page names the real GIF in its og:image tag, so we read
// that. Only tenor.com/view/<slug>-<id> pages are fetched, built here from a checked slug, so this cannot
// be used to reach any other address.
async function handleGifLink(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const m = /^\/view\/([a-z0-9-]{1,200})$/i.exec((() => { try { return new URL(url.searchParams.get('url') || '').pathname; } catch { return ''; } })());
  let host = '';
  try { host = new URL(url.searchParams.get('url') || '').hostname.replace(/^www\./, ''); } catch { /* handled below */ }
  if (host !== 'tenor.com' || !m || !/-\d{6,25}$/.test(m[1])) return err('Not a Tenor link', 400);
  try {
    const res = await fetch(`https://tenor.com/view/${m[1]}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return err('Link not found', 404);
    const html = (await res.text()).slice(0, 600_000);
    const og = (prop: string) => new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html)?.[1];
    const src = og('og:image');
    if (!src || !/^https:\/\/media\d*\.tenor\.(com|co)\/[^\s"'<>]+$/i.test(src)) return err('No GIF found', 404);
    return new Response(JSON.stringify({ src, width: parseInt(og('og:image:width') || '0') || null, height: parseInt(og('og:image:height') || '0') || null }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=86400', ...CORS },
    });
  } catch {
    return err('Could not load the link', 502);
  }
}

// Turns GIF protection on or off for one account and reports how many copies of its GIFs others already hold
// (needs the secret key)
async function handleSystemGifProtect(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-System-Key');
  if (!env.SYSTEM_KEY || !key || key !== env.SYSTEM_KEY) return err('Not found', 404);
  const { username, on } = await request.json() as { username?: string; on?: boolean };
  const u = username ? await env.DB.prepare('SELECT id, username FROM users WHERE username = ?').bind(username).first() as { id: number; username: string } | null : null;
  if (!u) return err('No such user', 404);
  if (typeof on === 'boolean') await env.DB.prepare('UPDATE users SET gifs_protected = ? WHERE id = ?').bind(on ? 1 : 0, u.id).run();
  const state = await env.DB.prepare('SELECT gifs_protected FROM users WHERE id = ?').bind(u.id).first() as { gifs_protected: number };
  const own = await env.DB.prepare('SELECT COUNT(*) as c FROM gifs WHERE owner_id = ? AND url IS NULL AND removed_at IS NULL').bind(u.id).first() as { c: number };
  const copies = await env.DB.prepare(`SELECT COUNT(*) as c FROM gifs c WHERE c.owner_id != ? AND c.removed_at IS NULL AND c.url IS NULL
    AND c.origin IN (SELECT COALESCE(o.origin, o.id) FROM gifs o WHERE o.owner_id = ? AND o.url IS NULL)`).bind(u.id, u.id).first() as { c: number };
  return json({ user: u.username, protected: !!state.gifs_protected, ownGifs: own.c, copiesInOthersLists: copies.c });
}

// --- Switching between two linked accounts (for testing) ---
// Only accounts joined by the app owner (with the secret key) can switch, and only to each other.
async function linkedAccount(env: Env, userId: number): Promise<{ id: number; username: string } | null> {
  return await env.DB.prepare('SELECT u.id, u.username FROM account_links l JOIN users u ON u.id = l.linked_id WHERE l.user_id = ? LIMIT 1')
    .bind(userId).first() as { id: number; username: string } | null;
}

async function handleSwitchAccount(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const other = await linkedAccount(env, auth.userId);
  if (!other) return err('This account has nothing to switch to', 403);
  const user = await env.DB.prepare(`SELECT id, username, avatar_color, ${AV('users')} as avatar_url, ${BANNER_COLS('users')}, gifs_protected FROM users WHERE id = ?`)
    .bind(other.id).first() as any;
  if (!user) return err('Account not found', 404);
  const token = await signJWT({ userId: user.id, username: user.username }, env.JWT_SECRET);
  return json({ token, user: { id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url), ...bannerFields(user), gifsProtected: !!user.gifs_protected, tick: hasTick(user.username), canSwitch: true } });
}

// Makes (or finds) the "test" account, friends it with the owner and links the two so they can switch (needs the secret key)
async function handleSystemTestAccount(request: Request, env: Env): Promise<Response> {
  const key = request.headers.get('X-System-Key');
  if (!env.SYSTEM_KEY || !key || key !== env.SYSTEM_KEY) return err('Not found', 404);
  const { owner } = await request.json() as { owner?: string };
  const o = owner ? await env.DB.prepare('SELECT id, username FROM users WHERE username = ?').bind(owner).first() as { id: number; username: string } | null : null;
  if (!o) return err('No such user', 404);
  let t = await env.DB.prepare("SELECT id, username FROM users WHERE username = 'test'").first() as { id: number; username: string } | null;
  if (!t) {
    // Nobody can log in with a password: the account is reached only through the switch button
    const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, '0')).join('');
    t = await env.DB.prepare("INSERT INTO users (username, password_hash, avatar_color) VALUES ('test', ?, '#23a55a') RETURNING id, username").bind(`${hex(16)}:${hex(32)}`).first() as { id: number; username: string };
  }
  const pair = '(requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)';
  const fr = await env.DB.prepare(`SELECT id, status FROM friendships WHERE ${pair}`).bind(o.id, t.id, t.id, o.id).first() as { id: number; status: string } | null;
  if (!fr) await env.DB.prepare("INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'accepted')").bind(o.id, t.id).run();
  else if (fr.status !== 'accepted') await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").bind(fr.id).run();
  await env.DB.prepare('DELETE FROM account_links WHERE user_id IN (?, ?) OR linked_id IN (?, ?)').bind(o.id, t.id, o.id, t.id).run();
  await env.DB.prepare('INSERT INTO account_links (user_id, linked_id) VALUES (?, ?), (?, ?)').bind(o.id, t.id, t.id, o.id).run();
  return json({ owner: o.username, test: t.username, friends: true, linked: true });
}

// --- Avatars ---
// Pictures are stored as data URLs. API responses never carry them: queries return a short
// version token and the client loads /api/avatars/<id>?v=<token>, which the browser caches.
const AV = (alias: string, col = 'avatar_url') =>
  `CASE WHEN ${alias}.${col} IS NULL THEN NULL ELSE length(${alias}.${col}) || '-' || substr(${alias}.${col}, -12) END`;

function avatarPath(kind: 'avatars' | 'group-avatars' | 'banners' | 'group-banners', id: number, token: string | null | undefined): string | null {
  return token ? `/api/${kind}/${id}?v=${encodeURIComponent(token)}` : null;
}

async function handleGetAvatar(env: Env, kind: 'avatars' | 'group-avatars' | 'banners' | 'group-banners', id: number): Promise<Response> {
  const table = kind.startsWith('group-') ? 'groups' : 'users';
  const col = kind.endsWith('banners') ? 'banner_url' : 'avatar_url';
  const row = await env.DB.prepare(`SELECT ${col} as pic FROM ${table} WHERE id = ?`).bind(id).first() as { pic: string | null } | null;
  const m = row?.pic ? /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(row.pic) : null;
  if (!m) return new Response('Not found', { status: 404, headers: CORS });
  const bin = atob(m[2]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Response(out, {
    headers: {
      'Content-Type': m[1],
      'Cache-Control': 'public, max-age=31536000, immutable', // the ?v= token changes with the picture
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
    },
  });
}

const BANNER_COLS = (alias: string) => `${AV(alias, 'banner_url')} as banner_url, ${alias}.banner_c1 as banner_c1, ${alias}.banner_c2 as banner_c2`;
function bannerFields(r: any) {
  return { bannerUrl: avatarPath('banners', r.id, r.banner_url), bannerColor1: r.banner_c1 ?? null, bannerColor2: r.banner_c2 ?? null };
}

// --- Auth middleware ---
async function getAuth(request: Request, env: Env): Promise<{ userId: number; username: string } | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

// --- CORS helpers ---
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-System-Key,X-Name',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// Avatar colors palette
const AVATAR_COLORS = ['#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#ffa500', '#00bcd4', '#9c27b0'];

// --- Route handlers ---

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const { username, password } = await request.json() as { username: string; password: string };
  if (!username || !password) return err('Username and password are required');
  if (username.length < 2 || username.length > 32) return err('Username must be 2-32 characters');
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) return err('Username can only contain letters, numbers, dots, underscores, hyphens');
  if (password.length < 6) return err('Password must be at least 6 characters');
  if (isReservedName(username)) return err('This name is reserved');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) return err('Username already taken');

  const hash = await hashPassword(password);
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const result = await env.DB.prepare(
    'INSERT INTO users (username, password_hash, avatar_color) VALUES (?, ?, ?) RETURNING id'
  ).bind(username, hash, color).first() as { id: number };

  return json({ success: true, userId: result.id }, 201);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const { username, password } = await request.json() as { username: string; password: string };
  if (!username || !password) return err('Username and password are required');

  const user = await env.DB.prepare(
    `SELECT id, username, password_hash, avatar_color, ${AV('users')} as avatar_url, ${BANNER_COLS('users')}, gifs_protected FROM users WHERE username = ?`
  ).bind(username).first() as { id: number; username: string; password_hash: string; avatar_color: string; avatar_url: string | null; gifs_protected?: number } | null;

  if (!user) return err('Invalid username or password', 401);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return err('Invalid username or password', 401);

  const token = await signJWT({ userId: user.id, username: user.username }, env.JWT_SECRET);
  return json({ token, user: { id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url), ...bannerFields(user), gifsProtected: !!user.gifs_protected, tick: hasTick(user.username), canSwitch: !!(await linkedAccount(env, user.id)) } });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const user = await env.DB.prepare(`SELECT id, username, avatar_color, ${AV('users')} as avatar_url, ${BANNER_COLS('users')}, gifs_protected FROM users WHERE id = ?`)
    .bind(auth.userId).first() as { id: number; username: string; avatar_color: string; avatar_url: string | null; gifs_protected?: number } | null;
  if (!user) return err('User not found', 404);
  return json({ id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url), ...bannerFields(user), gifsProtected: !!user.gifs_protected, tick: hasTick(user.username), canSwitch: !!(await linkedAccount(env, user.id)) });
}

async function handleUpdateProfile(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { username, avatarUrl, bannerUrl, bannerColors, gifsProtected } = await request.json() as { username?: string; avatarUrl?: string | null; bannerUrl?: string | null; bannerColors?: [string, string] | null; gifsProtected?: boolean };
  if (gifsProtected !== undefined) {
    const me = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(auth.userId).first() as { username: string } | null;
    if (me?.username.toLowerCase() !== GIF_PROTECT_USER) return err('Only the idk account can protect GIFs', 403);
    await env.DB.prepare('UPDATE users SET gifs_protected = ? WHERE id = ?').bind(gifsProtected ? 1 : 0, auth.userId).run();
  }

  if (username) {
    if (username.length < 2 || username.length > 32) return err('Username must be 2-32 characters');
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return err('Username can only contain letters, numbers, dots, underscores, hyphens');
    if (isReservedName(username)) return err('This name is reserved');
    const current = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(auth.userId).first() as { username: string } | null;
    if (hasTick(current?.username)) return err('This account cannot be renamed');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(username, auth.userId).first();
    if (existing) return err('Username already taken');
    await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, auth.userId).run();
  }

  if (avatarUrl !== undefined) {
    if (avatarUrl !== null && (typeof avatarUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(avatarUrl) || avatarUrl.length > 700000)) {
      return err('Invalid avatar image');
    }
    await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(avatarUrl, auth.userId).run();
  }

  // Banner: a picture, or two colours blended into a gradient. Choosing one clears the other.
  if (bannerUrl !== undefined) {
    if (bannerUrl !== null && (typeof bannerUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(bannerUrl) || bannerUrl.length > 900000)) {
      return err('Invalid banner image');
    }
    await env.DB.prepare('UPDATE users SET banner_url = ? WHERE id = ?').bind(bannerUrl, auth.userId).run();
    if (bannerUrl !== null) await env.DB.prepare('UPDATE users SET banner_c1 = NULL, banner_c2 = NULL WHERE id = ?').bind(auth.userId).run();
  }
  if (bannerColors !== undefined) {
    if (bannerColors === null) {
      await env.DB.prepare('UPDATE users SET banner_c1 = NULL, banner_c2 = NULL WHERE id = ?').bind(auth.userId).run();
    } else {
      const ok = Array.isArray(bannerColors) && bannerColors.length === 2 && bannerColors.every(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
      if (!ok) return err('Invalid banner colours');
      await env.DB.prepare('UPDATE users SET banner_c1 = ?, banner_c2 = ?, banner_url = NULL WHERE id = ?').bind(bannerColors[0], bannerColors[1], auth.userId).run();
    }
  }

  const user = await env.DB.prepare(`SELECT id, username, avatar_color, ${AV('users')} as avatar_url, ${BANNER_COLS('users')}, gifs_protected FROM users WHERE id = ?`)
    .bind(auth.userId).first() as any;

  if (!user) return err('User not found', 404);
  return json({ id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url), ...bannerFields(user), gifsProtected: !!user.gifs_protected, tick: hasTick(user.username), canSwitch: !!(await linkedAccount(env, user.id)) });
}

function previewOf(content: string | null): string | null {
  if (!content) return null;
  if (/^\[img:[a-f0-9]{32}\]$/.test(content)) return 'Sent an image';
  if (/^\[vid:[a-f0-9]{32}\]$/.test(content)) return 'Sent a video';
  if (/^\[gif:[a-f0-9]{32}\]$/.test(content)) return 'Sent a GIF';
  if (/^https:\/\/\S+\.(gif|webp|apng)$/i.test(content.trim()) || /^https:\/\/(www\.)?(tenor\.com\/view|giphy\.com\/gifs)\/\S+$/i.test(content.trim())) return 'Sent a GIF';
  return content.length > 120 ? content.slice(0, 117) + '...' : content;
}

const ONLINE_WINDOW = 20; // seconds since the last heartbeat
function isOnline(lastSeen: number | null): boolean {
  return !!lastSeen && Math.floor(Date.now() / 1000) - lastSeen < ONLINE_WINDOW;
}

async function handleGetFriends(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const me = auth.userId;

  // One round trip. The app polls this endpoint while open, so it also marks messages as
  // delivered and acts as the presence heartbeat.
  const [, , friends, sent, received] = await env.DB.batch([
    env.DB.prepare('UPDATE direct_messages SET delivered_at = unixepoch() WHERE receiver_id = ? AND delivered_at IS NULL').bind(me),
    env.DB.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').bind(me),
    env.DB.prepare(`
      SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, ${BANNER_COLS('u')}, u.last_seen, f.id as friendship_id,
             (SELECT COUNT(*) FROM direct_messages dm WHERE dm.sender_id = u.id AND dm.receiver_id = ? AND dm.read_at IS NULL AND ${NOT_EXPIRED('dm.created_at')}) as unread,
             (SELECT MAX(dm.id) FROM direct_messages dm WHERE dm.sender_id = u.id AND dm.receiver_id = ? AND dm.read_at IS NULL AND ${NOT_EXPIRED('dm.created_at')}) as last_unread_id,
             (SELECT dm.content FROM direct_messages dm WHERE dm.sender_id = u.id AND dm.receiver_id = ? AND dm.read_at IS NULL AND ${NOT_EXPIRED('dm.created_at')} ORDER BY dm.id DESC LIMIT 1) as preview,
             (SELECT MAX(dm.id) FROM direct_messages dm WHERE ((dm.sender_id = u.id AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = u.id)) AND ${NOT_EXPIRED('dm.created_at')}) as last_msg_id
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
    `).bind(me, me, me, me, me, me, me, me),
    env.DB.prepare(`
      SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, ${BANNER_COLS('u')}, u.last_seen, f.id as friendship_id
      FROM friendships f JOIN users u ON u.id = f.addressee_id
      WHERE f.requester_id = ? AND f.status = 'pending'
    `).bind(me),
    env.DB.prepare(`
      SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, ${BANNER_COLS('u')}, u.last_seen, f.id as friendship_id
      FROM friendships f JOIN users u ON u.id = f.requester_id
      WHERE f.addressee_id = ? AND f.status = 'pending'
    `).bind(me),
  ]);

  const person = (r: any) => ({
    id: r.id, username: r.username, avatarColor: r.avatar_color,
    avatarUrl: avatarPath('avatars', r.id, r.avatar_url),
    ...bannerFields(r),
    verified: isVerified(r.username), tick: hasTick(r.username),
    online: isVerified(r.username) || isOnline(r.last_seen), friendshipId: r.friendship_id,
  });
  return json({
    friends: friends.results.map((r: any) => ({ ...person(r), unread: r.unread || 0, lastUnreadId: r.last_unread_id || 0, preview: previewOf(r.preview), lastMessageId: r.last_msg_id || 0 })),
    pendingSent: sent.results.map(person),
    pendingReceived: received.results.map(person),
  });
}

// Everything the profile window shows about one person, as seen by the requester
async function handleUserProfile(request: Request, env: Env, targetId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const me = auth.userId;
  const u = await env.DB.prepare(`SELECT id, username, avatar_color, ${AV('u')} as avatar_url, ${BANNER_COLS('u')}, u.last_seen, u.created_at FROM users u WHERE u.id = ?`)
    .bind(targetId).first() as any;
  if (!u) return err('User not found', 404);
  const FRIENDS_OF = `SELECT CASE WHEN requester_id = ?1 THEN addressee_id ELSE requester_id END AS fid FROM friendships WHERE status = 'accepted' AND (requester_id = ?1 OR addressee_id = ?1)`;
  const [fr, note, mutualFriends, mutualGroups] = await env.DB.batch([
    env.DB.prepare(`SELECT id, status, created_at FROM friendships WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`).bind(me, targetId),
    env.DB.prepare('SELECT note FROM user_notes WHERE owner_id = ? AND target_id = ?').bind(me, targetId),
    env.DB.prepare(`SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url FROM users u
      WHERE u.id IN (${FRIENDS_OF}) AND u.id IN (SELECT CASE WHEN requester_id = ?2 THEN addressee_id ELSE requester_id END FROM friendships WHERE status = 'accepted' AND (requester_id = ?2 OR addressee_id = ?2))
      ORDER BY u.username COLLATE NOCASE`).bind(me, targetId),
    env.DB.prepare(`SELECT g.id, g.name, ${AV('g')} as avatar_url FROM groups g
      WHERE g.id IN (SELECT group_id FROM group_members WHERE user_id = ?1) AND g.id IN (SELECT group_id FROM group_members WHERE user_id = ?2)
      ORDER BY g.name COLLATE NOCASE`).bind(me, targetId),
  ]);
  const f = fr.results[0] as any;
  return json({
    id: u.id, username: u.username, avatarColor: u.avatar_color,
    avatarUrl: avatarPath('avatars', u.id, u.avatar_url),
    ...bannerFields(u),
    verified: isVerified(u.username),
    tick: hasTick(u.username),
    online: isVerified(u.username) || isOnline(u.last_seen),
    memberSince: u.created_at,
    friendship: f ? { id: f.id, status: f.status, since: f.created_at } : null,
    note: (note.results[0] as any)?.note ?? '',
    mutualFriends: mutualFriends.results.map((r: any) => ({ id: r.id, username: r.username, avatarColor: r.avatar_color, avatarUrl: avatarPath('avatars', r.id, r.avatar_url) })),
    mutualGroups: mutualGroups.results.map((r: any) => ({ id: r.id, name: r.name, avatarUrl: avatarPath('group-avatars', r.id, r.avatar_url) })),
  });
}

async function handleSetNote(request: Request, env: Env, targetId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { note } = await request.json() as { note?: string };
  const text = (note ?? '').slice(0, 256);
  if (text.trim()) await env.DB.prepare('INSERT INTO user_notes (owner_id, target_id, note) VALUES (?, ?, ?) ON CONFLICT(owner_id, target_id) DO UPDATE SET note = excluded.note').bind(auth.userId, targetId, text).run();
  else await env.DB.prepare('DELETE FROM user_notes WHERE owner_id = ? AND target_id = ?').bind(auth.userId, targetId).run();
  return json({ success: true });
}

async function handleAddFriend(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { username } = await request.json() as { username: string };
  if (!username) return err('Username is required');

  const target = await env.DB.prepare('SELECT id, username FROM users WHERE username = ?')
    .bind(username).first() as { id: number; username: string } | null;
  if (!target) return err('User not found');
  if (target.id === auth.userId) return err("You can't add yourself");

  const existing = await env.DB.prepare(
    'SELECT id, status FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)'
  ).bind(auth.userId, target.id, target.id, auth.userId).first() as { id: number; status: string } | null;

  if (existing) {
    if (existing.status === 'accepted') return err('Already friends');
    return err('Friend request already pending');
  }

  await env.DB.prepare('INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, ?)')
    .bind(auth.userId, target.id, 'pending').run();

  return json({ success: true, message: `Friend request sent to ${target.username}` }, 201);
}

async function handleAcceptFriend(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { friendshipId } = await request.json() as { friendshipId: number };

  const friendship = await env.DB.prepare(
    'SELECT id, requester_id, addressee_id FROM friendships WHERE id = ? AND addressee_id = ? AND status = ?'
  ).bind(friendshipId, auth.userId, 'pending').first() as { id: number } | null;

  if (!friendship) return err('Friend request not found', 404);
  await env.DB.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").bind(friendshipId).run();
  return json({ success: true });
}

async function handleRejectFriend(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { friendshipId } = await request.json() as { friendshipId: number };

  const friendship = await env.DB.prepare(
    'SELECT id FROM friendships WHERE id = ? AND (addressee_id = ? OR requester_id = ?)'
  ).bind(friendshipId, auth.userId, auth.userId).first() as { id: number } | null;

  if (!friendship) return err('Friend request not found', 404);
  const sysRow = await env.DB.prepare(`SELECT 1 FROM friendships f JOIN users u ON u.id IN (f.requester_id, f.addressee_id)
    WHERE f.id = ? AND u.username = ?`).bind(friendshipId, SYSTEM_NAME).first();
  if (sysRow) return err('You cannot remove Velcord', 403);
  await env.DB.prepare('DELETE FROM friendships WHERE id = ?').bind(friendshipId).run();
  return json({ success: true });
}

const PAGE_FIRST = 60;

async function handleGetMessages(request: Request, env: Env, otherUserId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const me = auth.userId;
  const url = new URL(request.url);
  const afterParam = url.searchParams.get('after');
  const initial = afterParam === '0';
  const afterId = parseInt(afterParam || '0') || 0;
  const legacySince = afterParam === null ? (url.searchParams.get('since') || '0') : null; // older open tabs

  const pair = `((dm.sender_id = ? AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = ?)) AND ${NOT_EXPIRED('dm.created_at')}`;
  const select = `SELECT dm.id, dm.content, dm.created_at, dm.delivered_at, dm.read_at,
           u.id as sender_id, u.username as sender_username, u.avatar_color as sender_avatar_color, ${AV('u')} as sender_avatar_url
    FROM direct_messages dm JOIN users u ON u.id = dm.sender_id`;
  const messagesStmt = legacySince !== null
    ? env.DB.prepare(`${select} WHERE ${pair} AND dm.created_at > ? ORDER BY dm.created_at ASC, dm.id ASC LIMIT 100`).bind(me, otherUserId, otherUserId, me, legacySince)
    : initial
      ? env.DB.prepare(`${select} WHERE ${pair} ORDER BY dm.id DESC LIMIT ${PAGE_FIRST}`).bind(me, otherUserId, otherUserId, me)
      : env.DB.prepare(`${select} WHERE ${pair} AND dm.id > ? ORDER BY dm.id ASC LIMIT 100`).bind(me, otherUserId, otherUserId, me, afterId);

  // Fetching = delivered; fetching while the chat is visible (seen=1) = seen. All in one round trip.
  const markStmt = url.searchParams.get('seen') === '1'
    ? env.DB.prepare('UPDATE direct_messages SET read_at = unixepoch(), delivered_at = COALESCE(delivered_at, unixepoch()) WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL').bind(me, otherUserId)
    : env.DB.prepare('UPDATE direct_messages SET delivered_at = unixepoch() WHERE receiver_id = ? AND sender_id = ? AND delivered_at IS NULL').bind(me, otherUserId);

  const [friendship, , messages] = await env.DB.batch([
    env.DB.prepare("SELECT id FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))").bind(me, otherUserId, otherUserId, me),
    markStmt,
    messagesStmt,
  ]);
  if (friendship.results.length === 0) return err('You are not friends with this user yet', 403);

  const rows = initial ? [...messages.results].reverse() : messages.results;
  return json(rows.map((m: any) => ({
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    deliveredAt: m.delivered_at,
    readAt: m.read_at,
    sender: { id: m.sender_id, username: m.sender_username, verified: isVerified(m.sender_username), tick: hasTick(m.sender_username), avatarColor: m.sender_avatar_color, avatarUrl: avatarPath('avatars', m.sender_id, m.sender_avatar_url) },
  })));
}

async function handleDeleteMessage(request: Request, env: Env, messageId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const msg = await env.DB.prepare('SELECT id, sender_id FROM direct_messages WHERE id = ?')
    .bind(messageId).first() as { id: number; sender_id: number } | null;

  if (!msg) return err('Message not found', 404);
  if (msg.sender_id !== auth.userId) return err('Cannot delete someone else\'s message', 403);

  await env.DB.prepare('DELETE FROM direct_messages WHERE id = ?').bind(messageId).run();
  return json({ success: true });
}

async function handleSendMessage(request: Request, env: Env, otherUserId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { content } = await request.json() as { content: string };
  if (!content?.trim()) return err('Message cannot be empty');
  if (content.length > 2000) return err('Message too long (max 2000 chars)');

  if (await isSystemUserId(env, otherUserId)) return err('Velcord is an official account. You cannot reply to it.', 403);

  // Friendship check and insert in one statement
  const result = await env.DB.prepare(`
    INSERT INTO direct_messages (sender_id, receiver_id, content)
    SELECT ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
                  AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)))
    RETURNING id, created_at
  `).bind(auth.userId, otherUserId, content.trim(), auth.userId, otherUserId, otherUserId, auth.userId).first() as { id: number; created_at: number } | null;
  if (!result) return err('You are not friends with this user yet', 403);
  await env.DB.prepare('DELETE FROM typing WHERE k = ?').bind(`d:${auth.userId}:${otherUserId}`).run(); // the "typing" line disappears when the message arrives

  return json({ id: result.id, content: content.trim(), createdAt: result.created_at, senderId: auth.userId }, 201);
}

async function handleCreateGroup(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { name, members } = await request.json() as { name: string; members: number[] };
  if (!name?.trim()) return err('Group name is required');
  if (!members || !Array.isArray(members) || members.length === 0) return err('Select at least one friend');

  // Verify all members are friends of the creator
  for (const memberId of members) {
    const friendship = await env.DB.prepare(
      "SELECT id FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
    ).bind(auth.userId, memberId, memberId, auth.userId).first();
    if (!friendship) return err(`User ${memberId} is not your friend`);
  }

  const res = await env.DB.prepare(
    'INSERT INTO groups (name, owner_id) VALUES (?, ?) RETURNING id'
  ).bind(name.trim(), auth.userId).first() as { id: number };

  // Add owner and members to group_members
  const allMembers = [auth.userId, ...members];
  const stmt = env.DB.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)');
  await env.DB.batch(allMembers.map(id => stmt.bind(res.id, id)));

  return json({ id: res.id, name: name.trim(), ownerId: auth.userId }, 201);
}

async function handleGetGroups(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const groups = await env.DB.prepare(`
    SELECT g.id, g.name, g.owner_id, g.created_at, ${AV('g')} as avatar_url, ${BANNER_COLS('g')},
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as memberCount,
           (SELECT COUNT(*) FROM voice_participants vp JOIN channels vc ON vc.id = vp.channel_id WHERE vc.group_id = g.id AND vp.last_seen > unixepoch() - ${CONF_ALIVE}) as callCount,
           (SELECT COUNT(*) FROM voice_participants vp JOIN channels vc ON vc.id = vp.channel_id WHERE vc.group_id = g.id AND vp.sharing = 1 AND vp.last_seen > unixepoch() - ${CONF_ALIVE}) as sharingCount
    FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `).bind(auth.userId).all();

  return json(groups.results.map((g: any) => ({
    id: g.id,
    name: g.name,
    ownerId: g.owner_id,
    createdAt: g.created_at,
    avatarUrl: avatarPath('group-avatars', g.id, g.avatar_url),
    bannerUrl: avatarPath('group-banners', g.id, g.banner_url),
    bannerColor1: g.banner_c1 ?? null,
    bannerColor2: g.banner_c2 ?? null,
    memberCount: g.memberCount,
    callCount: g.callCount || 0,
    sharingCount: g.sharingCount || 0,
  })));
}

async function handleGroupMembers(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const isMember = await env.DB.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, auth.userId).first();
  if (!isMember) return err('Not a member of this group', 403);
  const rows = await env.DB.prepare(`
    SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, u.last_seen, g.owner_id
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.group_id = ?
    ORDER BY u.username COLLATE NOCASE
  `).bind(groupId).all();
  return json(rows.results.map((r: any) => ({
    id: r.id,
    username: r.username,
    avatarColor: r.avatar_color,
    avatarUrl: avatarPath('avatars', r.id, r.avatar_url),
    online: r.id === auth.userId || isVerified(r.username) || isOnline(r.last_seen),
    isOwner: r.id === r.owner_id,
    verified: isVerified(r.username), tick: hasTick(r.username),
  })));
}

function validAvatar(v: unknown): boolean {
  return v === null || (typeof v === 'string' && v.length <= 700000 && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v));
}

// Only the group owner can change the photo or the name
async function handleUpdateGroup(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const group = await env.DB.prepare('SELECT id, owner_id FROM groups WHERE id = ?').bind(groupId).first() as { id: number; owner_id: number } | null;
  if (!group) return err('Group not found', 404);
  if (group.owner_id !== auth.userId) return err('Only the group owner can change this', 403);
  const { name, avatarUrl, bannerUrl, bannerColors } = await request.json() as { name?: string; avatarUrl?: string | null; bannerUrl?: string | null; bannerColors?: [string, string] | null };
  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 1 || n.length > 50) return err('Group name must be 1-50 characters');
    await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(n, groupId).run();
  }
  if (avatarUrl !== undefined) {
    if (!validAvatar(avatarUrl)) return err('Invalid group image');
    await env.DB.prepare('UPDATE groups SET avatar_url = ? WHERE id = ?').bind(avatarUrl, groupId).run();
  }
  // Banner: a picture, or two colours blended. Choosing one clears the other.
  if (bannerUrl !== undefined) {
    if (bannerUrl !== null && (typeof bannerUrl !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(bannerUrl) || bannerUrl.length > 900000)) {
      return err('Invalid banner image');
    }
    await env.DB.prepare('UPDATE groups SET banner_url = ? WHERE id = ?').bind(bannerUrl, groupId).run();
    if (bannerUrl !== null) await env.DB.prepare('UPDATE groups SET banner_c1 = NULL, banner_c2 = NULL WHERE id = ?').bind(groupId).run();
  }
  if (bannerColors !== undefined) {
    if (bannerColors === null) {
      await env.DB.prepare('UPDATE groups SET banner_c1 = NULL, banner_c2 = NULL WHERE id = ?').bind(groupId).run();
    } else {
      const ok = Array.isArray(bannerColors) && bannerColors.length === 2 && bannerColors.every(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
      if (!ok) return err('Invalid banner colours');
      await env.DB.prepare('UPDATE groups SET banner_c1 = ?, banner_c2 = ?, banner_url = NULL WHERE id = ?').bind(bannerColors[0], bannerColors[1], groupId).run();
    }
  }
  return json({ success: true });
}

// Any member can add their own (accepted) friends to the group
async function handleAddGroupMembers(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const isMember = await env.DB.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, auth.userId).first();
  if (!isMember) return err('Not a member of this group', 403);
  const { userIds } = await request.json() as { userIds: number[] };
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > 50) return err('Select at least one friend');
  let added = 0;
  for (const uid of userIds) {
    if (!Number.isInteger(uid)) continue;
    const friend = await env.DB.prepare(
      "SELECT id FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
    ).bind(auth.userId, uid, uid, auth.userId).first();
    if (!friend) continue;
    const res = await env.DB.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').bind(groupId, uid).run() as any;
    if (res?.meta?.changes) added++;
  }
  return json({ success: true, added });
}

async function handleDeleteGroup(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const group = await env.DB.prepare('SELECT id, owner_id FROM groups WHERE id = ?')
    .bind(groupId).first() as { id: number; owner_id: number } | null;

  if (!group) return err('Group not found', 404);
  if (group.owner_id !== auth.userId) return err('Only the owner can delete the group', 403);

  await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId).run();
  return json({ success: true });
}

async function handleGetGroupMessages(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  if (!(await isGroupMember(env, groupId, auth.userId))) return err('Not a member of this group', 403);
  const url = new URL(request.url);
  const afterParam = url.searchParams.get('after');
  const initial = afterParam === '0';
  const afterId = parseInt(afterParam || '0') || 0;
  const legacySince = afterParam === null ? (url.searchParams.get('since') || '0') : null; // older open tabs

  // Which channel: the one asked for (rows are filtered by group_id too, so a foreign id just shows nothing), else the first text channel, which also holds every old message
  const asked = parseInt(url.searchParams.get('channel') || '');
  const generalId = Number.isInteger(asked) ? 0 : await defaultTextChannel(env, groupId);
  const channelId = Number.isInteger(asked) ? asked : generalId;
  const inChannel = `(gm.channel_id = ? OR (gm.channel_id IS NULL AND ? = ?))`; // pages from before channels left it empty: that is "general"
  const chBind = [channelId, channelId, generalId];

  const select = `SELECT gm.id, gm.content, gm.created_at,
           u.id as sender_id, u.username as sender_username, u.avatar_color as sender_avatar_color, ${AV('u')} as sender_avatar_url
    FROM group_messages gm JOIN users u ON u.id = gm.sender_id`;
  const messages = legacySince !== null
    ? await env.DB.prepare(`${select} WHERE gm.group_id = ? AND ${inChannel} AND ${NOT_EXPIRED('gm.created_at')} AND gm.created_at > ? ORDER BY gm.created_at ASC, gm.id ASC LIMIT 100`).bind(groupId, ...chBind, legacySince).all()
    : initial
      ? await env.DB.prepare(`${select} WHERE gm.group_id = ? AND ${inChannel} AND ${NOT_EXPIRED('gm.created_at')} ORDER BY gm.id DESC LIMIT ${PAGE_FIRST}`).bind(groupId, ...chBind).all()
      : await env.DB.prepare(`${select} WHERE gm.group_id = ? AND ${inChannel} AND ${NOT_EXPIRED('gm.created_at')} AND gm.id > ? ORDER BY gm.id ASC LIMIT 100`).bind(groupId, ...chBind, afterId).all();

  const rows = initial ? [...messages.results].reverse() : messages.results;
  return json(rows.map((m: any) => ({
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    sender: { id: m.sender_id, username: m.sender_username, verified: isVerified(m.sender_username), tick: hasTick(m.sender_username), avatarColor: m.sender_avatar_color, avatarUrl: avatarPath('avatars', m.sender_id, m.sender_avatar_url) },
  })));
}
async function handleDeleteGroupMessage(request: Request, env: Env, messageId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  const msg = await env.DB.prepare('SELECT id, sender_id FROM group_messages WHERE id = ?')
    .bind(messageId).first() as { id: number; sender_id: number } | null;

  if (!msg) return err('Message not found', 404);
  if (msg.sender_id !== auth.userId) return err('Cannot delete someone else\'s message', 403);

  await env.DB.prepare('DELETE FROM group_messages WHERE id = ?').bind(messageId).run();
  return json({ success: true });
}

async function handleSendGroupMessage(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { content, channelId: asked } = await request.json() as { content: string; channelId?: number };
  if (!content?.trim()) return err('Message cannot be empty');
  if (!(await isGroupMember(env, groupId, auth.userId))) return err('Not a member of this group', 403);

  let channelId = await defaultTextChannel(env, groupId);
  if (Number.isInteger(asked) && asked !== channelId) {
    const ch = await env.DB.prepare("SELECT id FROM channels WHERE id = ? AND group_id = ? AND kind = 'text'").bind(asked, groupId).first();
    if (!ch) return err('Channel not found', 404);
    channelId = asked as number;
  }
  const result = await env.DB.prepare(`
    INSERT INTO group_messages (group_id, sender_id, content, channel_id)
    VALUES (?, ?, ?, ?)
    RETURNING id, created_at
  `).bind(groupId, auth.userId, content.trim(), channelId).first() as { id: number; created_at: number };
  await env.DB.prepare('DELETE FROM typing WHERE k = ?').bind(`g:${auth.userId}:${groupId}`).run();

  return json({ id: result.id, content: content.trim(), createdAt: result.created_at, senderId: auth.userId }, 201);
}

// --- Runtime schema migration (D1 is only reachable from the worker) ---
let schemaReady: Promise<void> | null = null;
function ensureSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const col of ['delivered_at', 'read_at']) {
        try { await env.DB.prepare(`ALTER TABLE direct_messages ADD COLUMN ${col} INTEGER`).run(); } catch { /* already exists */ }
      }
      try { await env.DB.prepare('ALTER TABLE users ADD COLUMN last_seen INTEGER').run(); } catch { /* already exists */ }
      try { await env.DB.prepare('ALTER TABLE groups ADD COLUMN avatar_url TEXT').run(); } catch { /* already exists */ }
      try { await env.DB.prepare('ALTER TABLE users ADD COLUMN gifs_protected INTEGER NOT NULL DEFAULT 0').run(); } catch { /* already exists */ }
      try { await env.DB.prepare('ALTER TABLE voice_participants ADD COLUMN sharing INTEGER NOT NULL DEFAULT 0').run(); } catch { /* already exists, or the table is created below */ }
      for (const col of ['banner_url TEXT', 'banner_c1 TEXT', 'banner_c2 TEXT']) {
        try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
        try { await env.DB.prepare(`ALTER TABLE groups ADD COLUMN ${col}`).run(); } catch { /* already exists */ }
      }
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS uploads (
          id TEXT PRIMARY KEY,
          owner_id INTEGER NOT NULL,
          mime TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploads(expires_at)'),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS videos (
          id TEXT PRIMARY KEY,
          owner_id INTEGER NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL,
          chunks INTEGER NOT NULL,
          ready INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_videos_expires ON videos(expires_at)'),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS gifs (
          id TEXT PRIMARY KEY,
          owner_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          removed_at INTEGER,
          url TEXT,
          origin TEXT
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_gifs_owner ON gifs(owner_id, removed_at)'),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_notes (
          owner_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL,
          note TEXT NOT NULL,
          PRIMARY KEY (owner_id, target_id)
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS call_signals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id INTEGER NOT NULL,
          to_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_call_signals_to ON call_signals(to_id, id)'),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS account_links (
          user_id INTEGER NOT NULL,
          linked_id INTEGER NOT NULL,
          PRIMARY KEY (user_id, linked_id)
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id, kind, position)'),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS voice_participants (
          channel_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          joined_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (channel_id, user_id)
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS conf_participants (
          group_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          joined_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (group_id, user_id)
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dm_receiver ON direct_messages(receiver_id, id)'),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_id, id)'),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS typing (
          k TEXT PRIMARY KEY,
          from_id INTEGER NOT NULL,
          to_id INTEGER,
          group_id INTEGER,
          at INTEGER NOT NULL
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_typing_to ON typing(to_id)'),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_typing_group ON typing(group_id)'),
      ]);
      // Databases created before GIFs could be saved from others get the two new columns here
      for (const col of ['url TEXT', 'origin TEXT']) {
        try { await env.DB.prepare(`ALTER TABLE gifs ADD COLUMN ${col}`).run(); } catch { /* already there */ }
      }
      // Older databases: signals gained the group id of a conference call
      try { await env.DB.prepare('ALTER TABLE call_signals ADD COLUMN conf INTEGER').run(); } catch { /* already exists */ }
      // Messages now belong to a channel of the group
      try { await env.DB.prepare('ALTER TABLE group_messages ADD COLUMN channel_id INTEGER').run(); } catch { /* already exists */ }
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// --- Image uploads (kept 2 days, then deleted) ---
const UPLOAD_TTL = 2 * 24 * 60 * 60;
const UPLOAD_MAX_BYTES = 1_300_000;
const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function purgeExpiredUploads(env: Env) {
  await env.DB.prepare('DELETE FROM uploads WHERE expires_at <= unixepoch()').run();
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const mime = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!UPLOAD_MIMES.includes(mime)) return err('Unsupported image type');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return err('Empty file');
  if (bytes.length > UPLOAD_MAX_BYTES) return err('Image too large after processing');

  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TTL;
  await env.DB.prepare('INSERT INTO uploads (id, owner_id, mime, data, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, auth.userId, mime, btoa(bin), expiresAt).run();
  await purgeExpiredUploads(env);
  return json({ id, expiresAt }, 201);
}

async function handleGetUpload(env: Env, id: string): Promise<Response> {
  if (!/^[a-f0-9]{32}$/.test(id)) return err('Not found', 404);
  const row = await env.DB.prepare('SELECT mime, data, expires_at FROM uploads WHERE id = ?')
    .bind(id).first() as { mime: string; data: string; expires_at: number } | null;
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_at <= now) {
    if (row) await purgeExpiredUploads(env);
    return err('Image expired', 404);
  }
  const bin = atob(row.data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Response(out, {
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': `private, max-age=${Math.min(row.expires_at - now, 86400)}`,
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
    },
  });
}

// --- Video clips: up to 200 MB, kept 1 day ---
// A clip is uploaded in 5 MB chunks into Workers KV (each chunk expires by itself) and
// described by one small row in D1. Playback supports Range requests so the video can be seeked.
const VIDEO_TTL = 24 * 60 * 60;
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const VIDEO_CHUNK = 5 * 1024 * 1024;
const VIDEO_POOL_MAX = 800 * 1024 * 1024; // KV on the free plan stores 1 GB in total
const VIDEO_PER_USER = 4; // clips a person can have at the same time
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'];
const videoKey = (id: string, n: number) => `v:${id}:${n}`;

type VideoRow = { id: string; owner_id: number; mime: string; size: number; chunks: number; ready: number; expires_at: number };

async function loadVideo(env: Env, id: string): Promise<VideoRow | null> {
  return await env.DB.prepare('SELECT id, owner_id, mime, size, chunks, ready, expires_at FROM videos WHERE id = ?').bind(id).first() as VideoRow | null;
}

async function handleVideoInit(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  if (!env.MEDIA) return err('Video storage is not configured', 503);
  const { size, mime } = await request.json() as { size: number; mime: string };
  if (!Number.isInteger(size) || size <= 0) return err('Invalid file size');
  if (size > VIDEO_MAX_BYTES) return err('Video too large (max 200 MB)');
  if (!VIDEO_MIMES.includes(mime)) return err('Unsupported video type (use MP4, MOV or WebM)');

  const now = Math.floor(Date.now() / 1000);
  const mine = await env.DB.prepare('SELECT COUNT(*) as c FROM videos WHERE owner_id = ? AND expires_at > ?').bind(auth.userId, now).first() as { c: number };
  if (mine.c >= VIDEO_PER_USER) return err(`You already have ${VIDEO_PER_USER} clips online. They are deleted after 1 day.`, 429);
  const pool = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) as s FROM videos WHERE expires_at > ?').bind(now).first() as { s: number };
  if (pool.s + size > VIDEO_POOL_MAX) return err('Video storage is full right now. Try again later.', 507);

  const id = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
  const chunks = Math.ceil(size / VIDEO_CHUNK);
  await env.DB.prepare('INSERT INTO videos (id, owner_id, mime, size, chunks, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, auth.userId, mime, size, chunks, now + VIDEO_TTL).run();
  return json({ id, chunkSize: VIDEO_CHUNK, chunks }, 201);
}

async function handleVideoChunk(request: Request, env: Env, id: string, n: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  if (!env.MEDIA) return err('Video storage is not configured', 503);
  const row = await loadVideo(env, id);
  if (!row || row.owner_id !== auth.userId) return err('Not found', 404);
  if (row.ready) return err('Upload already finished');
  if (!Number.isInteger(n) || n < 0 || n >= row.chunks) return err('Invalid chunk');
  const body = await request.arrayBuffer();
  const expected = n === row.chunks - 1 ? row.size - n * VIDEO_CHUNK : VIDEO_CHUNK;
  if (body.byteLength !== expected) return err(`Chunk must be ${expected} bytes`);
  await env.MEDIA.put(videoKey(id, n), body, { expirationTtl: VIDEO_TTL });
  return json({ ok: true });
}

async function handleVideoComplete(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const row = await loadVideo(env, id);
  if (!row || row.owner_id !== auth.userId) return err('Not found', 404);
  await env.DB.prepare('UPDATE videos SET ready = 1 WHERE id = ?').bind(id).run();
  return json({ id, expiresAt: row.expires_at });
}

// "bytes=0-99", "bytes=500-" or "bytes=-200"
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number, end: number;
  if (m[1] === '') { const suffix = parseInt(m[2]); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = parseInt(m[1]); end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2]), size - 1); }
  if (start > end || start >= size) return null;
  return { start, end };
}

async function handleGetVideo(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.MEDIA) return err('Video storage is not configured', 503);
  const row = await loadVideo(env, id);
  const now = Math.floor(Date.now() / 1000);
  if (!row || !row.ready || row.expires_at <= now) return err('Video expired', 404);

  const rangeHeader = request.headers.get('Range');
  let start = 0, end = row.size - 1, status = 200;
  if (rangeHeader) {
    const r = parseRange(rangeHeader, row.size);
    if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${row.size}`, ...CORS } });
    start = r.start; end = r.end; status = 206;
  }
  const headers: Record<string, string> = {
    'Content-Type': row.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Cache-Control': `private, max-age=${Math.min(row.expires_at - now, 3600)}`,
    'X-Content-Type-Options': 'nosniff',
    ...CORS,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${row.size}`;
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  let i = Math.floor(start / VIDEO_CHUNK);
  const last = Math.floor(end / VIDEO_CHUNK);
  const media = env.MEDIA;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i > last) { controller.close(); return; }
      let buf: ArrayBuffer | null = null;
      // A chunk written a moment ago may need a short while to appear in other regions
      for (let attempt = 0; attempt < 4 && !buf; attempt++) {
        buf = await media.get(videoKey(id, i), 'arrayBuffer');
        if (!buf) await new Promise(r => setTimeout(r, 300));
      }
      if (!buf) { controller.error(new Error('Video chunk missing')); return; }
      const chunkStart = i * VIDEO_CHUNK;
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkStart + buf.byteLength - 1) - chunkStart + 1;
      controller.enqueue(new Uint8Array(buf, from, to - from));
      i++;
    },
  });
  return new Response(body, { status, headers });
}

// --- Live updates: one request that waits until something new happens for this user ---
// The app calls this in a loop. It answers at once when a message, a call signal or a tick
// changed, otherwise after ~12 seconds. This replaces waiting for the next periodic poll.
const TYPING_TTL_MS = 5000;

async function readMarks(env: Env, me: number): Promise<{ core: string; ty: number }> {
  const cutoff = Date.now() - TYPING_TTL_MS;
  const r = await env.DB.prepare(`SELECT
    (SELECT COALESCE(MAX(id), 0) FROM direct_messages WHERE receiver_id = ?) AS dm,
    (SELECT COALESCE(MAX(gm.id), 0) FROM group_messages gm WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)) AS grp,
    (SELECT COALESCE(MAX(id), 0) FROM call_signals WHERE to_id = ?) AS sig,
    (SELECT COALESCE(MAX(MAX(COALESCE(delivered_at, 0), COALESCE(read_at, 0))), 0) FROM (SELECT delivered_at, read_at FROM direct_messages WHERE sender_id = ? ORDER BY id DESC LIMIT 30)) AS st,
    (SELECT COALESCE(MAX(at), 0) FROM typing WHERE at > ? AND from_id != ?
       AND (to_id = ? OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))) AS ty
  `).bind(me, me, me, me, cutoff, me, me, me).first() as { dm: number; grp: number; sig: number; st: number; ty: number };
  return { core: `${r.dm}.${r.grp}.${r.sig}.${r.st}`, ty: r.ty };
}

async function handleWait(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const me = auth.userId;
  const params = new URL(request.url).searchParams;
  const known = params.get('m');
  const knownTy = params.get('t');

  const answer = async (cur: { core: string; ty: number }) => {
    const rows = await env.DB.prepare(`SELECT t.from_id, u.username, t.to_id, t.group_id
      FROM typing t JOIN users u ON u.id = t.from_id
      WHERE t.at > ? AND t.from_id != ? AND (t.to_id = ? OR t.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`)
      .bind(Date.now() - TYPING_TTL_MS, me, me, me).all();
    return json({
      marks: cur.core,
      tmark: String(cur.ty),
      typing: rows.results.map((r: any) => ({ userId: r.from_id, username: r.username, toId: r.to_id, groupId: r.group_id })),
    });
  };

  let cur = await readMarks(env, me);
  const valid = !!known && /^\d+\.\d+\.\d+\.\d+$/.test(known) && !!knownTy && /^\d+$/.test(knownTy);
  if (!valid || known !== cur.core || knownTy !== String(cur.ty)) return answer(cur);
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 2000));
    cur = await readMarks(env, me);
    if (cur.core !== known || String(cur.ty) !== knownTy) break;
  }
  return answer(cur);
}

// Someone is typing: remembered for 5 seconds and pushed to the other side through the wait channel
async function handleTyping(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { to, group } = await request.json() as { to?: number; group?: number };
  const now = Date.now();
  if (Number.isInteger(to)) {
    await env.DB.prepare(`INSERT OR REPLACE INTO typing (k, from_id, to_id, group_id, at)
      SELECT ?, ?, ?, NULL, ?
      WHERE EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
                    AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)))`)
      .bind(`d:${auth.userId}:${to}`, auth.userId, to, now, auth.userId, to, to, auth.userId).run();
  } else if (Number.isInteger(group)) {
    await env.DB.prepare(`INSERT OR REPLACE INTO typing (k, from_id, to_id, group_id, at)
      SELECT ?, ?, NULL, ?, ?
      WHERE EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?)`)
      .bind(`g:${auth.userId}:${group}`, auth.userId, group, now, group, auth.userId).run();
  } else {
    return err('Missing target');
  }
  return json({ ok: true });
}

// --- Message status (sent / delivered / seen ticks) ---
async function handleMessageStatus(request: Request, env: Env, otherUserId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const rows = await env.DB.prepare(`
    SELECT id, delivered_at, read_at FROM direct_messages
    WHERE sender_id = ? AND receiver_id = ? AND ${NOT_EXPIRED('created_at')}
    ORDER BY id DESC LIMIT 100
  `).bind(auth.userId, otherUserId).all();
  return json(rows.results.map((r: any) => ({ id: r.id, deliveredAt: r.delivered_at, readAt: r.read_at })));
}

// --- Call signaling (WebRTC offers/answers/ICE relayed through D1) ---
const SIGNAL_TYPES = ['invite', 'accept', 'reject', 'hangup', 'desc', 'ice', 'share', 'cam'];

// --- Channels of a group: text channels hold messages, voice channels are rooms anyone from the group can walk into ---
const MAX_CHANNELS = 25;
const MAX_VOICE = 10;
const CONF_MAX = 6; // people in one voice channel; all of them are connected to each other directly
const CONF_ALIVE = 20; // seconds: a person whose app stopped reporting is no longer counted as in the room
const CONF_SIGNAL_TYPES = ['conf-desc', 'conf-ice', 'conf-cam', 'conf-share', 'conf-mute'];

interface ChannelRow { id: number; group_id: number; name: string; kind: 'text' | 'voice'; position: number }

async function isGroupMember(env: Env, groupId: number, userId: number): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').bind(groupId, userId).first());
}

/** The channel, if the person belongs to its group. */
async function channelFor(env: Env, channelId: number, userId: number): Promise<ChannelRow | null> {
  return await env.DB.prepare(`SELECT c.id, c.group_id, c.name, c.kind, c.position FROM channels c
    JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = ? WHERE c.id = ?`).bind(userId, channelId).first() as ChannelRow | null;
}

/** Every group has a "general" text channel. Old groups get it on first use and take over their old messages. */
async function defaultTextChannel(env: Env, groupId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM channels WHERE group_id = ? AND kind = 'text' ORDER BY position, id LIMIT 1").bind(groupId).first() as { id: number } | null;
  if (row) return row.id;
  const made = await env.DB.prepare("INSERT INTO channels (group_id, name, kind, position) VALUES (?, 'general', 'text', 0) RETURNING id").bind(groupId).first() as { id: number };
  await env.DB.prepare('UPDATE group_messages SET channel_id = ? WHERE group_id = ? AND channel_id IS NULL').bind(made.id, groupId).run();
  return made.id;
}

function cleanChannelName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = raw.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
  return n.length >= 1 && n.length <= 32 ? n : null;
}

async function voiceRoster(env: Env, channelId: number) {
  const rows = await env.DB.prepare(`
    SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url
    FROM voice_participants vp JOIN users u ON u.id = vp.user_id
    WHERE vp.channel_id = ? AND vp.last_seen > unixepoch() - ${CONF_ALIVE}
    ORDER BY vp.joined_at, u.id
  `).bind(channelId).all();
  return rows.results.map((r: any) => ({ id: r.id, username: r.username, avatarColor: r.avatar_color, avatarUrl: avatarPath('avatars', r.id, r.avatar_url), verified: isVerified(r.username), tick: hasTick(r.username) }));
}

async function handleListChannels(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  if (!(await isGroupMember(env, groupId, auth.userId))) return err('Not a member of this group', 403);
  await defaultTextChannel(env, groupId);
  const rows = await env.DB.prepare("SELECT id, name, kind, position FROM channels WHERE group_id = ? ORDER BY CASE kind WHEN 'text' THEN 0 ELSE 1 END, position, id").bind(groupId).all();
  const alive = await env.DB.prepare(`SELECT vp.channel_id, vp.sharing, u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url
    FROM voice_participants vp JOIN users u ON u.id = vp.user_id JOIN channels c ON c.id = vp.channel_id
    WHERE c.group_id = ? AND vp.last_seen > unixepoch() - ${CONF_ALIVE} ORDER BY vp.joined_at, u.id`).bind(groupId).all();
  const byChannel = new Map<number, unknown[]>();
  for (const r of alive.results as any[]) {
    const list = byChannel.get(r.channel_id) ?? [];
    list.push({ id: r.id, username: r.username, avatarColor: r.avatar_color, avatarUrl: avatarPath('avatars', r.id, r.avatar_url), verified: isVerified(r.username), tick: hasTick(r.username), sharing: !!r.sharing });
    byChannel.set(r.channel_id, list);
  }
  return json({
    max: CONF_MAX,
    channels: rows.results.map((c: any) => ({ id: c.id, name: c.name, kind: c.kind, position: c.position, participants: c.kind === 'voice' ? (byChannel.get(c.id) ?? []) : undefined })),
  });
}

async function groupOwnerOnly(env: Env, groupId: number, userId: number): Promise<Response | null> {
  const g = await env.DB.prepare('SELECT owner_id FROM groups WHERE id = ?').bind(groupId).first() as { owner_id: number } | null;
  if (!g) return err('Group not found', 404);
  if (g.owner_id !== userId) return err('Only the group owner can change the channels', 403);
  return null;
}

async function handleCreateChannel(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const denied = await groupOwnerOnly(env, groupId, auth.userId);
  if (denied) return denied;
  const body = await request.json() as { name?: string; kind?: string };
  const name = cleanChannelName(body.name);
  if (!name) return err('Give the channel a name (1 to 32 characters)');
  const kind = body.kind === 'voice' ? 'voice' : 'text';
  await defaultTextChannel(env, groupId);
  const count = await env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN kind = 'voice' THEN 1 ELSE 0 END) as voice FROM channels WHERE group_id = ?").bind(groupId).first() as { total: number; voice: number | null };
  if (count.total >= MAX_CHANNELS) return err(`A group can have ${MAX_CHANNELS} channels at most`);
  if (kind === 'voice' && (count.voice ?? 0) >= MAX_VOICE) return err(`A group can have ${MAX_VOICE} voice channels at most`);
  const dup = await env.DB.prepare('SELECT 1 FROM channels WHERE group_id = ? AND kind = ? AND name = ? COLLATE NOCASE').bind(groupId, kind, name).first();
  if (dup) return err('There is already a channel with this name');
  const pos = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) + 1 as p FROM channels WHERE group_id = ? AND kind = ?').bind(groupId, kind).first() as { p: number };
  const made = await env.DB.prepare('INSERT INTO channels (group_id, name, kind, position) VALUES (?, ?, ?, ?) RETURNING id, name, kind, position').bind(groupId, name, kind, pos.p).first();
  return json(made, 201);
}

async function handleRenameChannel(request: Request, env: Env, channelId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const ch = await env.DB.prepare('SELECT id, group_id, kind FROM channels WHERE id = ?').bind(channelId).first() as { id: number; group_id: number; kind: string } | null;
  if (!ch) return err('Channel not found', 404);
  const denied = await groupOwnerOnly(env, ch.group_id, auth.userId);
  if (denied) return denied;
  const name = cleanChannelName(((await request.json()) as { name?: string }).name);
  if (!name) return err('Give the channel a name (1 to 32 characters)');
  const dup = await env.DB.prepare('SELECT 1 FROM channels WHERE group_id = ? AND kind = ? AND name = ? COLLATE NOCASE AND id != ?').bind(ch.group_id, ch.kind, name, channelId).first();
  if (dup) return err('There is already a channel with this name');
  await env.DB.prepare('UPDATE channels SET name = ? WHERE id = ?').bind(name, channelId).run();
  return json({ id: channelId, name, kind: ch.kind });
}

async function handleDeleteChannel(request: Request, env: Env, channelId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const ch = await env.DB.prepare('SELECT id, group_id, kind FROM channels WHERE id = ?').bind(channelId).first() as { id: number; group_id: number; kind: string } | null;
  if (!ch) return err('Channel not found', 404);
  const denied = await groupOwnerOnly(env, ch.group_id, auth.userId);
  if (denied) return denied;
  if (ch.kind === 'text') {
    const texts = await env.DB.prepare("SELECT COUNT(*) as c FROM channels WHERE group_id = ? AND kind = 'text'").bind(ch.group_id).first() as { c: number };
    if (texts.c <= 1) return err('A group needs at least one text channel');
    await env.DB.prepare('DELETE FROM group_messages WHERE channel_id = ?').bind(channelId).run();
  } else {
    await env.DB.prepare('DELETE FROM voice_participants WHERE channel_id = ?').bind(channelId).run();
  }
  await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channelId).run();
  return json({ success: true });
}

/** The header "Call" buttons: the group's first voice channel, made on the spot when it has none. */
async function handleDefaultVoice(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  if (!(await isGroupMember(env, groupId, auth.userId))) return err('Not a member of this group', 403);
  await defaultTextChannel(env, groupId);
  // Prefer a voice channel where a call is already going on
  let row = await env.DB.prepare(`SELECT c.id, c.name FROM channels c LEFT JOIN voice_participants vp ON vp.channel_id = c.id AND vp.last_seen > unixepoch() - ${CONF_ALIVE}
    WHERE c.group_id = ? AND c.kind = 'voice' GROUP BY c.id ORDER BY COUNT(vp.user_id) DESC, c.position, c.id LIMIT 1`).bind(groupId).first() as { id: number; name: string } | null;
  if (!row) row = await env.DB.prepare("INSERT INTO channels (group_id, name, kind, position) VALUES (?, 'Voice', 'voice', 0) RETURNING id, name").bind(groupId).first() as { id: number; name: string };
  return json({ id: row.id, name: row.name });
}

async function handleVoiceJoin(request: Request, env: Env, channelId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const ch = await channelFor(env, channelId, auth.userId);
  if (!ch) return err('Not a member of this group', 403);
  if (ch.kind !== 'voice') return err('This is not a voice channel');
  const { video, ring } = await request.json().catch(() => ({})) as { video?: boolean; ring?: boolean };

  await env.DB.prepare(`DELETE FROM voice_participants WHERE channel_id = ? AND last_seen <= unixepoch() - ${CONF_ALIVE}`).bind(channelId).run();
  const others = await env.DB.prepare('SELECT COUNT(*) as c FROM voice_participants WHERE channel_id = ? AND user_id != ?').bind(channelId, auth.userId).first() as { c: number };
  const already = await env.DB.prepare('SELECT 1 FROM voice_participants WHERE channel_id = ? AND user_id = ?').bind(channelId, auth.userId).first();
  if (!already && others.c >= CONF_MAX) return err(`This channel is full (${CONF_MAX} people).`, 409);
  await env.DB.prepare('INSERT OR REPLACE INTO voice_participants (channel_id, user_id, joined_at, last_seen) VALUES (?, ?, unixepoch(), unixepoch())').bind(channelId, auth.userId).run();

  // Walking into a voice channel is quiet. Only the "Call" button of the group rings the others, and only when it starts the call.
  let started = false;
  if (others.c === 0 && ring) {
    started = true;
    const group = await env.DB.prepare('SELECT name FROM groups WHERE id = ?').bind(ch.group_id).first() as { name: string } | null;
    const members = await env.DB.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?').bind(ch.group_id, auth.userId).all();
    const payload = JSON.stringify({ groupName: group?.name ?? 'Group', channelName: ch.name, groupId: ch.group_id, video: !!video });
    for (const m of members.results as { user_id: number }[]) {
      await env.DB.prepare('INSERT INTO call_signals (from_id, to_id, type, payload, conf) VALUES (?, ?, ?, ?, ?)').bind(auth.userId, m.user_id, 'conf-invite', payload, channelId).run();
    }
  }
  return json({ started, max: CONF_MAX, groupId: ch.group_id, channelName: ch.name, roster: await voiceRoster(env, channelId) });
}

async function handleVoiceLeave(request: Request, env: Env, channelId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  await env.DB.prepare('DELETE FROM voice_participants WHERE channel_id = ? AND user_id = ?').bind(channelId, auth.userId).run();
  return json({ success: true });
}

// Tells the group list that I am (or am no longer) sharing my screen in this room
async function handleVoiceShare(request: Request, env: Env, channelId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { on } = await request.json() as { on?: boolean };
  await env.DB.prepare('UPDATE voice_participants SET sharing = ? WHERE channel_id = ? AND user_id = ?').bind(on ? 1 : 0, channelId, auth.userId).run();
  return json({ success: true });
}

async function handleVoiceInfo(request: Request, env: Env, channelId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const ch = await channelFor(env, channelId, auth.userId);
  if (!ch || ch.kind !== 'voice') return err('Not found', 404);
  return json({ max: CONF_MAX, roster: await voiceRoster(env, channelId) });
}

async function handleCallSignal(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { to, type, payload, conf } = await request.json() as { to: number; type: string; payload?: string; conf?: number };
  if (!Number.isInteger(to)) return err('Invalid signal');
  if (payload !== undefined && (typeof payload !== 'string' || payload.length > 30000)) return err('Payload too large');
  if (CONF_SIGNAL_TYPES.includes(type)) {
    if (!Number.isInteger(conf)) return err('Invalid signal');
    const mine = await channelFor(env, conf as number, auth.userId);
    if (!mine || mine.kind !== 'voice' || !(await channelFor(env, conf as number, to))) return err('Not in this group', 403);
    await env.DB.prepare('INSERT INTO call_signals (from_id, to_id, type, payload, conf) VALUES (?, ?, ?, ?, ?)').bind(auth.userId, to, type, payload ?? null, conf).run();
    return json({ success: true }, 201);
  }
  if (!SIGNAL_TYPES.includes(type)) return err('Invalid signal');
  const friendship = await env.DB.prepare(
    "SELECT id FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
  ).bind(auth.userId, to, to, auth.userId).first();
  if (!friendship) return err('You can only call friends', 403);
  if (await isSystemUserId(env, to)) return err('You cannot call Velcord', 403);
  await env.DB.prepare('INSERT INTO call_signals (from_id, to_id, type, payload) VALUES (?, ?, ?, ?)')
    .bind(auth.userId, to, type, payload ?? null).run();
  return json({ success: true }, 201);
}

async function handleCallPoll(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  if (url.searchParams.get('init') === '1') {
    const last = await env.DB.prepare('SELECT COALESCE(MAX(id), 0) as m FROM call_signals').first() as { m: number };
    return json({ now, lastId: last.m, signals: [] });
  }
  const after = parseInt(url.searchParams.get('after') || '0') || 0;
  // A conference member polls with ?conf=<group>: that also tells the server they are still in the call
  let roster: unknown = undefined;
  const confId = parseInt(url.searchParams.get('conf') || '');
  if (Number.isInteger(confId)) {
    const res = await env.DB.prepare(`UPDATE voice_participants SET last_seen = unixepoch() WHERE channel_id = ? AND user_id = ?`).bind(confId, auth.userId).run() as any;
    if (res?.meta?.changes) roster = await voiceRoster(env, confId);
  }
  const rows = await env.DB.prepare(`
    SELECT s.id, s.from_id, s.type, s.payload, s.created_at, s.conf,
           u.username, u.avatar_color, ${AV('u')} as avatar_url
    FROM call_signals s JOIN users u ON u.id = s.from_id
    WHERE s.to_id = ? AND s.id > ?
    ORDER BY s.id ASC LIMIT 100
  `).bind(auth.userId, after).all();
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM call_signals WHERE created_at < unixepoch() - 300').run();
  }
  return json({
    now,
    roster,
    signals: rows.results.map((r: any) => ({
      id: r.id,
      conf: r.conf ?? null,
      from: { id: r.from_id, username: r.username, avatarColor: r.avatar_color, avatarUrl: avatarPath('avatars', r.from_id, r.avatar_url) },
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at,
    })),
  });
}

// --- Main fetch handler ---
export default {
  async fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Fallback for non-API routes: serve static assets from Cloudflare Pages
      if (!path.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      await ensureSchema(env);
      if (Date.now() - lastPurge > 10 * 60 * 1000) {
        lastPurge = Date.now();
        const job = purgeOldMessages(env).catch(() => { lastPurge = 0; });
        if (ctx) ctx.waitUntil(job);
      }

      // Avatars (public, cached by the browser)
      const avatarMatch = path.match(/^\/api\/(avatars|group-avatars|banners|group-banners)\/(\d+)$/);
      if (avatarMatch && request.method === 'GET') return await handleGetAvatar(env, avatarMatch[1] as 'avatars' | 'group-avatars' | 'banners' | 'group-banners', parseInt(avatarMatch[2]));

      // Uploads
      if (path === '/api/uploads' && request.method === 'POST') return await handleUpload(request, env);
      const uploadMatch = path.match(/^\/api\/uploads\/([a-f0-9]+)$/);
      if (uploadMatch && request.method === 'GET') return await handleGetUpload(env, uploadMatch[1]);

      if (path === '/api/wait' && request.method === 'GET') return await handleWait(request, env);
      if (path === '/api/typing' && request.method === 'POST') return await handleTyping(request, env);

      // Official notifications (needs the secret key)
      if (path === '/api/system/notify' && request.method === 'POST') return await handleSystemNotify(request, env);
      if (path === '/api/system/status' && request.method === 'POST') return await handleSystemStatus(request, env);
      if (path === '/api/system/unfriend' && request.method === 'POST') return await handleSystemUnfriend(request, env);
      if (path === '/api/system/videos' && request.method === 'POST') return await handleSystemVideos(request, env);
      if (path === '/api/system/gif-protect' && request.method === 'POST') return await handleSystemGifProtect(request, env);
      if (path === '/api/system/test-account' && request.method === 'POST') return await handleSystemTestAccount(request, env);
      if (path === '/api/switch-account' && request.method === 'POST') return await handleSwitchAccount(request, env);

      // GIF behind a Tenor link
      if (path === '/api/gif-link' && request.method === 'GET') {
        if (!(await getAuth(request, env))) return err('Unauthorized', 401);
        return await handleGifLink(request);
      }

      // Personal GIF list
      if (path === '/api/gifs' && request.method === 'POST') return await handleGifUpload(request, env);
      if (path === '/api/gifs' && request.method === 'GET') return await handleGifList(request, env);
      if (path === '/api/gifs/save' && request.method === 'POST') return await handleGifSave(request, env);
      if (path === '/api/gifs/origins' && request.method === 'POST') return await handleGifOrigins(request, env);
      const gifFileMatch = path.match(/^\/api\/gifs\/([a-f0-9]{32})\/file$/);
      if (gifFileMatch && request.method === 'GET') return await handleGifFile(env, gifFileMatch[1]);
      const gifMatch = path.match(/^\/api\/gifs\/([a-f0-9]{32})$/);
      if (gifMatch && request.method === 'DELETE') return await handleGifRemove(request, env, gifMatch[1]);

      // Video clips
      if (path === '/api/videos' && request.method === 'POST') return await handleVideoInit(request, env);
      const videoChunkMatch = path.match(/^\/api\/videos\/([a-f0-9]{32})\/chunks\/(\d+)$/);
      if (videoChunkMatch && request.method === 'PUT') return await handleVideoChunk(request, env, videoChunkMatch[1], parseInt(videoChunkMatch[2]));
      const videoDoneMatch = path.match(/^\/api\/videos\/([a-f0-9]{32})\/complete$/);
      if (videoDoneMatch && request.method === 'POST') return await handleVideoComplete(request, env, videoDoneMatch[1]);
      const videoGetMatch = path.match(/^\/api\/videos\/([a-f0-9]{32})$/);
      if (videoGetMatch && (request.method === 'GET' || request.method === 'HEAD')) return await handleGetVideo(request, env, videoGetMatch[1]);

      // Calls
      const voiceMatch = path.match(/^\/api\/voice\/(\d+)(?:\/(join|leave|share))?$/);
      if (voiceMatch) {
        const cid = parseInt(voiceMatch[1]);
        if (voiceMatch[2] === 'join' && request.method === 'POST') return await handleVoiceJoin(request, env, cid);
        if (voiceMatch[2] === 'leave' && request.method === 'POST') return await handleVoiceLeave(request, env, cid);
        if (voiceMatch[2] === 'share' && request.method === 'POST') return await handleVoiceShare(request, env, cid);
        if (!voiceMatch[2] && request.method === 'GET') return await handleVoiceInfo(request, env, cid);
      }
      const channelsMatch = path.match(/^\/api\/groups\/(\d+)\/channels$/);
      if (channelsMatch && request.method === 'GET') return await handleListChannels(request, env, parseInt(channelsMatch[1]));
      if (channelsMatch && request.method === 'POST') return await handleCreateChannel(request, env, parseInt(channelsMatch[1]));
      const defaultVoiceMatch = path.match(/^\/api\/groups\/(\d+)\/default-voice$/);
      if (defaultVoiceMatch && request.method === 'POST') return await handleDefaultVoice(request, env, parseInt(defaultVoiceMatch[1]));
      const channelMatch = path.match(/^\/api\/channels\/(\d+)$/);
      if (channelMatch && request.method === 'PATCH') return await handleRenameChannel(request, env, parseInt(channelMatch[1]));
      if (channelMatch && request.method === 'DELETE') return await handleDeleteChannel(request, env, parseInt(channelMatch[1]));
      if (path === '/api/calls/signal' && request.method === 'POST') return await handleCallSignal(request, env);
      if (path === '/api/calls/poll' && request.method === 'GET') return await handleCallPoll(request, env);

      // Message delivery status
      const statusMatch = path.match(/^\/api\/messages\/(\d+)\/status$/);
      if (statusMatch && request.method === 'GET') return await handleMessageStatus(request, env, parseInt(statusMatch[1]));

      // Auth routes
      if (path === '/api/auth/register' && request.method === 'POST') return await handleRegister(request, env);
      if (path === '/api/auth/login' && request.method === 'POST') return await handleLogin(request, env);
      // Profile/User routes
      if (path === '/api/me' && request.method === 'GET') return await handleMe(request, env);
      if (path === '/api/me' && request.method === 'PATCH') return await handleUpdateProfile(request, env);

      const profileRoute = path.match(/^\/api\/users\/(\d+)\/(profile|note)$/);
      if (profileRoute) {
        const id = parseInt(profileRoute[1]);
        if (profileRoute[2] === 'profile' && request.method === 'GET') return await handleUserProfile(request, env, id);
        if (profileRoute[2] === 'note' && request.method === 'PUT') return await handleSetNote(request, env, id);
      }

      // Friend routes
      if (path === '/api/friends' && request.method === 'GET') return await handleGetFriends(request, env);
      if (path === '/api/friends/add' && request.method === 'POST') return await handleAddFriend(request, env);
      if (path === '/api/friends/accept' && request.method === 'POST') return await handleAcceptFriend(request, env);
      if (path === '/api/friends/reject' && request.method === 'POST') return await handleRejectFriend(request, env);

      // Group routes
      if (path === '/api/groups' && request.method === 'POST') return await handleCreateGroup(request, env);
      if (path === '/api/groups' && request.method === 'GET') return await handleGetGroups(request, env);

      const groupPatchMatch = path.match(/^\/api\/groups\/(\d+)$/);
      if (groupPatchMatch && request.method === 'PATCH') return await handleUpdateGroup(request, env, parseInt(groupPatchMatch[1]));
      const groupAddMatch = path.match(/^\/api\/groups\/(\d+)\/members$/);
      if (groupAddMatch && request.method === 'POST') return await handleAddGroupMembers(request, env, parseInt(groupAddMatch[1]));

      const groupMembersMatch = path.match(/^\/api\/groups\/(\d+)\/members$/);
      if (groupMembersMatch && request.method === 'GET') return await handleGroupMembers(request, env, parseInt(groupMembersMatch[1]));

      const groupDeleteMatch = path.match(/^\/api\/groups\/(\d+)$/);
      if (groupDeleteMatch && request.method === 'DELETE') {
        return await handleDeleteGroup(request, env, parseInt(groupDeleteMatch[1]));
      }

      const groupMatch = path.match(/^\/api\/groups\/(\d+)\/messages$/);
      if (groupMatch) {
        const groupId = parseInt(groupMatch[1]);
        if (request.method === 'GET') return await handleGetGroupMessages(request, env, groupId);
        if (request.method === 'POST') return await handleSendGroupMessage(request, env, groupId);
      }

      const groupMsgDeleteMatch = path.match(/^\/api\/group-messages\/(\d+)$/);
      if (groupMsgDeleteMatch && request.method === 'DELETE') {
        return await handleDeleteGroupMessage(request, env, parseInt(groupMsgDeleteMatch[1]));
      }

      // Message routes
      const msgIdMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (msgIdMatch && request.method === 'DELETE') return await handleDeleteMessage(request, env, parseInt(msgIdMatch[1]));

      const msgMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (msgMatch) {
        const otherUserId = parseInt(msgMatch[1]);
        if (request.method === 'GET') return await handleGetMessages(request, env, otherUserId);
        if (request.method === 'POST') return await handleSendMessage(request, env, otherUserId);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e: any) {
      console.error('Worker error:', e);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};
