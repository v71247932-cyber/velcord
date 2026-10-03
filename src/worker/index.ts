/// <reference types="@cloudflare/workers-types" />
// Velcord - Cloudflare Worker Backend
// Handles all API requests for auth, friends, and messages

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ASSETS: Fetcher;
  /** Workers KV: holds the video chunks, which expire on their own */
  MEDIA?: KVNamespace;
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

async function purgeOldMessages(env: Env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM direct_messages WHERE created_at < unixepoch() - ${MESSAGE_TTL}`),
    env.DB.prepare(`DELETE FROM group_messages WHERE created_at < unixepoch() - ${MESSAGE_TTL}`),
    env.DB.prepare('DELETE FROM uploads WHERE expires_at <= unixepoch()'),
    env.DB.prepare('DELETE FROM videos WHERE expires_at <= unixepoch()'), // the KV chunks expire by themselves
  ]);
}

// --- Avatars ---
// Pictures are stored as data URLs. API responses never carry them: queries return a short
// version token and the client loads /api/avatars/<id>?v=<token>, which the browser caches.
const AV = (alias: string) =>
  `CASE WHEN ${alias}.avatar_url IS NULL THEN NULL ELSE length(${alias}.avatar_url) || '-' || substr(${alias}.avatar_url, -12) END`;

function avatarPath(kind: 'avatars' | 'group-avatars', id: number, token: string | null | undefined): string | null {
  return token ? `/api/${kind}/${id}?v=${encodeURIComponent(token)}` : null;
}

async function handleGetAvatar(env: Env, kind: 'avatars' | 'group-avatars', id: number): Promise<Response> {
  const table = kind === 'avatars' ? 'users' : 'groups';
  const row = await env.DB.prepare(`SELECT avatar_url FROM ${table} WHERE id = ?`).bind(id).first() as { avatar_url: string | null } | null;
  const m = row?.avatar_url ? /^data:(image\/[a-z+.-]+);base64,(.*)$/s.exec(row.avatar_url) : null;
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
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
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
    `SELECT id, username, password_hash, avatar_color, ${AV('users')} as avatar_url FROM users WHERE username = ?`
  ).bind(username).first() as { id: number; username: string; password_hash: string; avatar_color: string; avatar_url: string | null } | null;

  if (!user) return err('Invalid username or password', 401);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return err('Invalid username or password', 401);

  const token = await signJWT({ userId: user.id, username: user.username }, env.JWT_SECRET);
  return json({ token, user: { id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url) } });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const user = await env.DB.prepare(`SELECT id, username, avatar_color, ${AV('users')} as avatar_url FROM users WHERE id = ?`)
    .bind(auth.userId).first() as { id: number; username: string; avatar_color: string; avatar_url: string | null } | null;
  if (!user) return err('User not found', 404);
  return json({ id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url) });
}

async function handleUpdateProfile(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { username, avatarUrl } = await request.json() as { username?: string; avatarUrl?: string | null };

  if (username) {
    if (username.length < 2 || username.length > 32) return err('Username must be 2-32 characters');
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return err('Username can only contain letters, numbers, dots, underscores, hyphens');
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

  const user = await env.DB.prepare(`SELECT id, username, avatar_color, ${AV('users')} as avatar_url FROM users WHERE id = ?`)
    .bind(auth.userId).first() as { id: number; username: string; avatar_color: string; avatar_url: string | null } | null;

  if (!user) return err('User not found', 404);
  return json({ id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: avatarPath('avatars', user.id, user.avatar_url) });
}

function previewOf(content: string | null): string | null {
  if (!content) return null;
  if (/^\[img:[a-f0-9]{32}\]$/.test(content)) return 'Sent an image';
  if (/^\[vid:[a-f0-9]{32}\]$/.test(content)) return 'Sent a video';
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
      SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, u.last_seen, f.id as friendship_id,
             (SELECT COUNT(*) FROM direct_messages dm WHERE dm.sender_id = u.id AND dm.receiver_id = ? AND dm.read_at IS NULL AND ${NOT_EXPIRED('dm.created_at')}) as unread,
             (SELECT MAX(dm.id) FROM direct_messages dm WHERE dm.sender_id = u.id AND dm.receiver_id = ? AND dm.read_at IS NULL AND ${NOT_EXPIRED('dm.created_at')}) as last_unread_id,
             (SELECT dm.content FROM direct_messages dm WHERE dm.sender_id = u.id AND dm.receiver_id = ? AND dm.read_at IS NULL AND ${NOT_EXPIRED('dm.created_at')} ORDER BY dm.id DESC LIMIT 1) as preview
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
      WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
    `).bind(me, me, me, me, me, me),
    env.DB.prepare(`
      SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, u.last_seen, f.id as friendship_id
      FROM friendships f JOIN users u ON u.id = f.addressee_id
      WHERE f.requester_id = ? AND f.status = 'pending'
    `).bind(me),
    env.DB.prepare(`
      SELECT u.id, u.username, u.avatar_color, ${AV('u')} as avatar_url, u.last_seen, f.id as friendship_id
      FROM friendships f JOIN users u ON u.id = f.requester_id
      WHERE f.addressee_id = ? AND f.status = 'pending'
    `).bind(me),
  ]);

  const person = (r: any) => ({
    id: r.id, username: r.username, avatarColor: r.avatar_color,
    avatarUrl: avatarPath('avatars', r.id, r.avatar_url),
    online: isOnline(r.last_seen), friendshipId: r.friendship_id,
  });
  return json({
    friends: friends.results.map((r: any) => ({ ...person(r), unread: r.unread || 0, lastUnreadId: r.last_unread_id || 0, preview: previewOf(r.preview) })),
    pendingSent: sent.results.map(person),
    pendingReceived: received.results.map(person),
  });
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
    sender: { id: m.sender_id, username: m.sender_username, avatarColor: m.sender_avatar_color, avatarUrl: avatarPath('avatars', m.sender_id, m.sender_avatar_url) },
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

  // Friendship check and insert in one statement
  const result = await env.DB.prepare(`
    INSERT INTO direct_messages (sender_id, receiver_id, content)
    SELECT ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM friendships WHERE status = 'accepted'
                  AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)))
    RETURNING id, created_at
  `).bind(auth.userId, otherUserId, content.trim(), auth.userId, otherUserId, otherUserId, auth.userId).first() as { id: number; created_at: number } | null;
  if (!result) return err('You are not friends with this user yet', 403);

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
    SELECT g.id, g.name, g.owner_id, g.created_at, ${AV('g')} as avatar_url,
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as memberCount
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
    memberCount: g.memberCount
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
    online: r.id === auth.userId || isOnline(r.last_seen),
    isOwner: r.id === r.owner_id,
  })));
}

function validAvatar(v: unknown): boolean {
  return v === null || (typeof v === 'string' && v.length <= 700000 && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v));
}

// Any member can change the group photo or name
async function handleUpdateGroup(request: Request, env: Env, groupId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const isMember = await env.DB.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?')
    .bind(groupId, auth.userId).first();
  if (!isMember) return err('Not a member of this group', 403);
  const { name, avatarUrl } = await request.json() as { name?: string; avatarUrl?: string | null };
  if (name !== undefined) {
    const n = String(name).trim();
    if (n.length < 1 || n.length > 50) return err('Group name must be 1-50 characters');
    await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(n, groupId).run();
  }
  if (avatarUrl !== undefined) {
    if (!validAvatar(avatarUrl)) return err('Invalid group image');
    await env.DB.prepare('UPDATE groups SET avatar_url = ? WHERE id = ?').bind(avatarUrl, groupId).run();
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
  const url = new URL(request.url);
  const afterParam = url.searchParams.get('after');
  const initial = afterParam === '0';
  const afterId = parseInt(afterParam || '0') || 0;
  const legacySince = afterParam === null ? (url.searchParams.get('since') || '0') : null; // older open tabs

  const select = `SELECT gm.id, gm.content, gm.created_at,
           u.id as sender_id, u.username as sender_username, u.avatar_color as sender_avatar_color, ${AV('u')} as sender_avatar_url
    FROM group_messages gm JOIN users u ON u.id = gm.sender_id`;
  const messagesStmt = legacySince !== null
    ? env.DB.prepare(`${select} WHERE gm.group_id = ? AND ${NOT_EXPIRED('gm.created_at')} AND gm.created_at > ? ORDER BY gm.created_at ASC, gm.id ASC LIMIT 100`).bind(groupId, legacySince)
    : initial
      ? env.DB.prepare(`${select} WHERE gm.group_id = ? AND ${NOT_EXPIRED('gm.created_at')} ORDER BY gm.id DESC LIMIT ${PAGE_FIRST}`).bind(groupId)
      : env.DB.prepare(`${select} WHERE gm.group_id = ? AND ${NOT_EXPIRED('gm.created_at')} AND gm.id > ? ORDER BY gm.id ASC LIMIT 100`).bind(groupId, afterId);

  const [member, messages] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?').bind(groupId, auth.userId),
    messagesStmt,
  ]);
  if (member.results.length === 0) return err('Not a member of this group', 403);

  const rows = initial ? [...messages.results].reverse() : messages.results;
  return json(rows.map((m: any) => ({
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    sender: { id: m.sender_id, username: m.sender_username, avatarColor: m.sender_avatar_color, avatarUrl: avatarPath('avatars', m.sender_id, m.sender_avatar_url) },
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
  const { content } = await request.json() as { content: string };
  if (!content?.trim()) return err('Message cannot be empty');

  // Membership check and insert in one statement
  const result = await env.DB.prepare(`
    INSERT INTO group_messages (group_id, sender_id, content)
    SELECT ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?)
    RETURNING id, created_at
  `).bind(groupId, auth.userId, content.trim(), groupId, auth.userId).first() as { id: number; created_at: number } | null;
  if (!result) return err('Not a member of this group', 403);

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
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS call_signals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_id INTEGER NOT NULL,
          to_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_call_signals_to ON call_signals(to_id, id)'),
      ]);
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
  await env.MEDIA.put(videoKey(id, n), body, { expirationTtl: VIDEO_TTL + 3600 });
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
const SIGNAL_TYPES = ['invite', 'accept', 'reject', 'hangup', 'desc', 'ice', 'share'];

async function handleCallSignal(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { to, type, payload } = await request.json() as { to: number; type: string; payload?: string };
  if (!Number.isInteger(to) || !SIGNAL_TYPES.includes(type)) return err('Invalid signal');
  if (payload !== undefined && (typeof payload !== 'string' || payload.length > 30000)) return err('Payload too large');
  const friendship = await env.DB.prepare(
    "SELECT id FROM friendships WHERE status = 'accepted' AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"
  ).bind(auth.userId, to, to, auth.userId).first();
  if (!friendship) return err('You can only call friends', 403);
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
  const rows = await env.DB.prepare(`
    SELECT s.id, s.from_id, s.type, s.payload, s.created_at,
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
    signals: rows.results.map((r: any) => ({
      id: r.id,
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
      const avatarMatch = path.match(/^\/api\/(avatars|group-avatars)\/(\d+)$/);
      if (avatarMatch && request.method === 'GET') return handleGetAvatar(env, avatarMatch[1] as 'avatars' | 'group-avatars', parseInt(avatarMatch[2]));

      // Uploads
      if (path === '/api/uploads' && request.method === 'POST') return handleUpload(request, env);
      const uploadMatch = path.match(/^\/api\/uploads\/([a-f0-9]+)$/);
      if (uploadMatch && request.method === 'GET') return handleGetUpload(env, uploadMatch[1]);

      // Video clips
      if (path === '/api/videos' && request.method === 'POST') return handleVideoInit(request, env);
      const videoChunkMatch = path.match(/^\/api\/videos\/([a-f0-9]{32})\/chunks\/(\d+)$/);
      if (videoChunkMatch && request.method === 'PUT') return handleVideoChunk(request, env, videoChunkMatch[1], parseInt(videoChunkMatch[2]));
      const videoDoneMatch = path.match(/^\/api\/videos\/([a-f0-9]{32})\/complete$/);
      if (videoDoneMatch && request.method === 'POST') return handleVideoComplete(request, env, videoDoneMatch[1]);
      const videoGetMatch = path.match(/^\/api\/videos\/([a-f0-9]{32})$/);
      if (videoGetMatch && (request.method === 'GET' || request.method === 'HEAD')) return handleGetVideo(request, env, videoGetMatch[1]);

      // Calls
      if (path === '/api/calls/signal' && request.method === 'POST') return handleCallSignal(request, env);
      if (path === '/api/calls/poll' && request.method === 'GET') return handleCallPoll(request, env);

      // Message delivery status
      const statusMatch = path.match(/^\/api\/messages\/(\d+)\/status$/);
      if (statusMatch && request.method === 'GET') return handleMessageStatus(request, env, parseInt(statusMatch[1]));

      // Auth routes
      if (path === '/api/auth/register' && request.method === 'POST') return handleRegister(request, env);
      if (path === '/api/auth/login' && request.method === 'POST') return handleLogin(request, env);
      // Profile/User routes
      if (path === '/api/me' && request.method === 'GET') return handleMe(request, env);
      if (path === '/api/me' && request.method === 'PATCH') return handleUpdateProfile(request, env);

      // Friend routes
      if (path === '/api/friends' && request.method === 'GET') return handleGetFriends(request, env);
      if (path === '/api/friends/add' && request.method === 'POST') return handleAddFriend(request, env);
      if (path === '/api/friends/accept' && request.method === 'POST') return handleAcceptFriend(request, env);
      if (path === '/api/friends/reject' && request.method === 'POST') return handleRejectFriend(request, env);

      // Group routes
      if (path === '/api/groups' && request.method === 'POST') return handleCreateGroup(request, env);
      if (path === '/api/groups' && request.method === 'GET') return handleGetGroups(request, env);

      const groupPatchMatch = path.match(/^\/api\/groups\/(\d+)$/);
      if (groupPatchMatch && request.method === 'PATCH') return handleUpdateGroup(request, env, parseInt(groupPatchMatch[1]));
      const groupAddMatch = path.match(/^\/api\/groups\/(\d+)\/members$/);
      if (groupAddMatch && request.method === 'POST') return handleAddGroupMembers(request, env, parseInt(groupAddMatch[1]));

      const groupMembersMatch = path.match(/^\/api\/groups\/(\d+)\/members$/);
      if (groupMembersMatch && request.method === 'GET') return handleGroupMembers(request, env, parseInt(groupMembersMatch[1]));

      const groupDeleteMatch = path.match(/^\/api\/groups\/(\d+)$/);
      if (groupDeleteMatch && request.method === 'DELETE') {
        return handleDeleteGroup(request, env, parseInt(groupDeleteMatch[1]));
      }

      const groupMatch = path.match(/^\/api\/groups\/(\d+)\/messages$/);
      if (groupMatch) {
        const groupId = parseInt(groupMatch[1]);
        if (request.method === 'GET') return handleGetGroupMessages(request, env, groupId);
        if (request.method === 'POST') return handleSendGroupMessage(request, env, groupId);
      }

      const groupMsgDeleteMatch = path.match(/^\/api\/group-messages\/(\d+)$/);
      if (groupMsgDeleteMatch && request.method === 'DELETE') {
        return handleDeleteGroupMessage(request, env, parseInt(groupMsgDeleteMatch[1]));
      }

      // Message routes
      const msgIdMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (msgIdMatch && request.method === 'DELETE') return handleDeleteMessage(request, env, parseInt(msgIdMatch[1]));

      const msgMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (msgMatch) {
        const otherUserId = parseInt(msgMatch[1]);
        if (request.method === 'GET') return handleGetMessages(request, env, otherUserId);
        if (request.method === 'POST') return handleSendMessage(request, env, otherUserId);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e: any) {
      console.error('Worker error:', e);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};
