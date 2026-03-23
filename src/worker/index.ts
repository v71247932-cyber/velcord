/// <reference types="@cloudflare/workers-types" />
// Velcord - Cloudflare Worker Backend
// Handles all API requests for auth, friends, and messages

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ASSETS: Fetcher;
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

// --- Auth middleware ---
async function getAuth(request: Request, env: Env): Promise<{ userId: number; username: string } | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

// --- CORS helpers ---
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
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
    'SELECT id, username, password_hash, avatar_color FROM users WHERE username = ?'
  ).bind(username).first() as { id: number; username: string; password_hash: string; avatar_color: string } | null;

  if (!user) return err('Invalid username or password', 401);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return err('Invalid username or password', 401);

  const token = await signJWT({ userId: user.id, username: user.username }, env.JWT_SECRET);
  return json({ token, user: { id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: user.avatar_url } });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const user = await env.DB.prepare('SELECT id, username, avatar_color, avatar_url FROM users WHERE id = ?')
    .bind(auth.userId).first() as { id: number; username: string; avatar_color: string; avatar_url: string } | null;
  if (!user) return err('User not found', 404);
  return json({ id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: user.avatar_url });
}

async function handleUpdateProfile(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);
  const { username, avatarUrl } = await request.json() as { username?: string; avatarUrl?: string };

  if (username) {
    if (username.length < 2 || username.length > 32) return err('Username must be 2-32 characters');
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) return err('Username can only contain letters, numbers, dots, underscores, hyphens');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(username, auth.userId).first();
    if (existing) return err('Username already taken');
    await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, auth.userId).run();
  }

  if (avatarUrl !== undefined) {
    await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(avatarUrl, auth.userId).run();
  }

  const user = await env.DB.prepare('SELECT id, username, avatar_color, avatar_url FROM users WHERE id = ?')
    .bind(auth.userId).first() as { id: number; username: string; avatar_color: string; avatar_url: string } | null;

  return json(user);
}

async function handleGetFriends(request: Request, env: Env): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  // Accepted friends
  const friends = await env.DB.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.avatar_url, f.id as friendship_id,
           CASE WHEN f.requester_id = ? THEN 'sent' ELSE 'received' END as direction
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
  `).bind(auth.userId, auth.userId, auth.userId, auth.userId).all();

  // Pending sent
  const sent = await env.DB.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.avatar_url, f.id as friendship_id
    FROM friendships f
    JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
  `).bind(auth.userId).all();

  // Pending received
  const received = await env.DB.prepare(`
    SELECT u.id, u.username, u.avatar_color, u.avatar_url, f.id as friendship_id
    FROM friendships f
    JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
  `).bind(auth.userId).all();

  return json({
    friends: friends.results.map((r: any) => ({ id: r.id, username: r.username, avatarColor: r.avatar_color, avatarUrl: r.avatar_url, friendshipId: r.friendship_id })),
    pendingSent: sent.results.map((r: any) => ({ id: r.id, username: r.username, avatarColor: r.avatar_color, avatarUrl: r.avatar_url, friendshipId: r.friendship_id })),
    pendingReceived: received.results.map((r: any) => ({ id: r.id, username: r.username, avatarColor: r.avatar_color, avatarUrl: r.avatar_url, friendshipId: r.friendship_id })),
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

async function handleGetMessages(request: Request, env: Env, otherUserId: number): Promise<Response> {
  const auth = await getAuth(request, env);
  if (!auth) return err('Unauthorized', 401);

  // Verify they have any friendship record (pending or accepted)
  const friendship = await env.DB.prepare(
    "SELECT id FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)"
  ).bind(auth.userId, otherUserId, otherUserId, auth.userId).first();
  if (!friendship) return err('No connection with this user', 403);

  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '0';

  const messages = await env.DB.prepare(`
    SELECT dm.id, dm.content, dm.created_at,
           u.id as sender_id, u.username as sender_username, u.avatar_color as sender_avatar_color, u.avatar_url as sender_avatar_url
    FROM direct_messages dm
    JOIN users u ON u.id = dm.sender_id
    WHERE ((dm.sender_id = ? AND dm.receiver_id = ?) OR (dm.sender_id = ? AND dm.receiver_id = ?))
      AND dm.created_at > ?
    ORDER BY dm.created_at ASC, dm.id ASC
    LIMIT 100
  `).bind(auth.userId, otherUserId, otherUserId, auth.userId, since).all();

  return json(messages.results.map((m: any) => ({
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    sender: { id: m.sender_id, username: m.sender_username, avatarColor: m.sender_avatar_color, avatarUrl: m.sender_avatar_url }
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

  // Verify they have any friendship record
  const friendship = await env.DB.prepare(
    "SELECT id FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)"
  ).bind(auth.userId, otherUserId, otherUserId, auth.userId).first();
  if (!friendship) return err('No connection with this user', 403);

  const result = await env.DB.prepare(
    'INSERT INTO direct_messages (sender_id, receiver_id, content) VALUES (?, ?, ?) RETURNING id, created_at'
  ).bind(auth.userId, otherUserId, content.trim()).first() as { id: number; created_at: number };

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
    SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as memberCount
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
    memberCount: g.memberCount
  })));
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

  // Verify user is a member
  const isMember = await env.DB.prepare(
    'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
  ).bind(groupId, auth.userId).first();
  if (!isMember) return err('Not a member of this group', 403);

  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '0';

  const messages = await env.DB.prepare(`
    SELECT gm.id, gm.content, gm.created_at,
           u.id as sender_id, u.username as sender_username, u.avatar_color as sender_avatar_color, u.avatar_url as sender_avatar_url
    FROM group_messages gm
    JOIN users u ON u.id = gm.sender_id
    WHERE gm.group_id = ? AND gm.created_at > ?
    ORDER BY gm.created_at ASC, gm.id ASC
    LIMIT 100
  `).bind(groupId, since).all();

  return json(messages.results.map((m: any) => ({
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    sender: { id: m.sender_id, username: m.sender_username, avatarColor: m.sender_avatar_color, avatarUrl: m.sender_avatar_url }
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

  // Verify membership
  const isMember = await env.DB.prepare(
    'SELECT id FROM group_members WHERE group_id = ? AND user_id = ?'
  ).bind(groupId, auth.userId).first();
  if (!isMember) return err('Not a member of this group', 403);

  const result = await env.DB.prepare(
    'INSERT INTO group_messages (group_id, sender_id, content) VALUES (?, ?, ?) RETURNING id, created_at'
  ).bind(groupId, auth.userId, content.trim()).first() as { id: number; created_at: number };

  return json({ id: result.id, content: content.trim(), createdAt: result.created_at, senderId: auth.userId }, 201);
}

// --- Main fetch handler ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
