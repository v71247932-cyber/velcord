// API base URL - in dev points to worker, in prod same origin
const BASE = import.meta.env.VITE_API_URL || '';

function authHeaders(): HeadersInit {
    const token = localStorage.getItem('velcord_token');
    return token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data as any).error || 'Request failed');
    return data as T;
}

export const api = {
    register: (username: string, password: string) =>
        request<{ success: boolean }>('POST', '/api/auth/register', { username, password }),

    login: (username: string, password: string) =>
        request<{ token: string; user: User }>('POST', '/api/auth/login', { username, password }),

    me: () => request<User>('GET', '/api/me'),

    getFriends: () => request<FriendsData>('GET', '/api/friends'),

    addFriend: (username: string) => request<{ success: boolean }>('POST', '/api/friends/add', { username }),

    acceptFriend: (friendshipId: number) =>
        request<{ success: boolean }>('POST', '/api/friends/accept', { friendshipId }),

    rejectFriend: (friendshipId: number) =>
        request<{ success: boolean }>('POST', '/api/friends/reject', { friendshipId }),

    /** afterId = 0 loads the latest page; otherwise only messages newer than that id */
    getMessages: (userId: number, afterId = 0, seen = false) =>
        request<Message[]>('GET', `/api/messages/${userId}?after=${afterId}${seen ? '&seen=1' : ''}`),

    sendMessage: (userId: number, content: string) =>
        request<Message>('POST', `/api/messages/${userId}`, { content }),

    getGroupMessages: (groupId: number, afterId = 0) =>
        request<Message[]>('GET', `/api/groups/${groupId}/messages?after=${afterId}`),

    sendGroupMessage: (groupId: number, content: string) =>
        request<Message>('POST', `/api/groups/${groupId}/messages`, { content }),

    getGroupMembers: (groupId: number) => request<GroupMember[]>('GET', `/api/groups/${groupId}/members`),

    updateGroup: (groupId: number, patch: { name?: string; avatarUrl?: string | null; bannerUrl?: string | null; bannerColors?: [string, string] | null }) =>
        request<{ success: boolean }>('PATCH', `/api/groups/${groupId}`, patch),

    addGroupMembers: (groupId: number, userIds: number[]) =>
        request<{ success: boolean; added: number }>('POST', `/api/groups/${groupId}/members`, { userIds }),

    getGroups: () => request<Group[]>('GET', '/api/groups'),

    createGroup: (name: string, members: number[]) =>
        request<Group>('POST', '/api/groups', { name, members }),

    deleteMessage: (messageId: number) =>
        request<{ success: boolean }>('DELETE', `/api/messages/${messageId}`),

    deleteGroupMessage: (messageId: number) =>
        request<{ success: boolean }>('DELETE', `/api/group-messages/${messageId}`),

    deleteGroup: (groupId: number) =>
        request<{ success: boolean }>('DELETE', `/api/groups/${groupId}`),

    getMessageStatus: (userId: number) =>
        request<{ id: number; deliveredAt: number | null; readAt: number | null }[]>('GET', `/api/messages/${userId}/status`),

    uploadImage: async (blob: Blob) => {
        const token = localStorage.getItem('velcord_token');
        const res = await fetch(`${BASE}/api/uploads`, {
            method: 'POST',
            headers: { 'Content-Type': blob.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: blob,
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data as any).error || 'Upload failed');
        return data as { id: string; expiresAt: number };
    },

    initVideo: (size: number, mime: string) =>
        request<{ id: string; chunkSize: number; chunks: number }>('POST', '/api/videos', { size, mime }),

    completeVideo: (id: string) =>
        request<{ id: string; expiresAt: number }>('POST', `/api/videos/${id}/complete`, {}),

    callSignal: (to: number, type: string, payload?: unknown) =>
        request<{ success: boolean }>('POST', '/api/calls/signal', { to, type, payload: payload === undefined ? undefined : JSON.stringify(payload) }),

    callPoll: (after: number) =>
        request<{ now: number; lastId?: number; signals: CallSignal[] }>('GET', after < 0 ? '/api/calls/poll?init=1' : `/api/calls/poll?after=${after}`),

    updateBanner: (patch: { bannerUrl?: string | null; bannerColors?: [string, string] | null }) =>
        request<User>('PATCH', '/api/me', patch),

    updateProfile: (username?: string, avatarUrl?: string | null) =>
        request<User>('PATCH', '/api/me', { username, avatarUrl }),
};

export interface User {
    id: number;
    username: string;
    avatarColor: string;
    avatarUrl?: string;
    bannerUrl?: string | null;
    bannerColor1?: string | null;
    bannerColor2?: string | null;
    verified?: boolean;
}

export interface FriendUser {
    id: number;
    username: string;
    avatarColor: string;
    avatarUrl?: string;
    bannerUrl?: string | null;
    bannerColor1?: string | null;
    bannerColor2?: string | null;
    verified?: boolean;
    online?: boolean;
    unread?: number;
    lastUnreadId?: number;
    preview?: string | null;
    friendshipId: number;
}

export interface FriendsData {
    friends: FriendUser[];
    pendingSent: FriendUser[];
    pendingReceived: FriendUser[];
}

export interface GroupMember {
    id: number;
    username: string;
    avatarColor: string;
    avatarUrl?: string;
    online: boolean;
    isOwner: boolean;
    verified?: boolean;
}

export interface Message {
    id: number;
    content: string;
    createdAt: number;
    deliveredAt?: number | null;
    readAt?: number | null;
    /** shown instantly while the server is still saving it */
    pending?: boolean;
    sender: User;
}

export interface CallSignal {
    id: number;
    from: User;
    type: 'invite' | 'accept' | 'reject' | 'hangup' | 'desc' | 'ice' | 'share';
    payload: string | null;
    createdAt: number;
}

export interface Group {
    id: number;
    name: string;
    ownerId: number;
    createdAt: number;
    avatarUrl?: string | null;
    bannerUrl?: string | null;
    bannerColor1?: string | null;
    bannerColor2?: string | null;
    memberCount?: number;
}
