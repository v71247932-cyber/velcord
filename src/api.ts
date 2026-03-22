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

    getMessages: (userId: number, since?: number) =>
        request<Message[]>('GET', `/api/messages/${userId}${since ? `?since=${since}` : ''}`),

    sendMessage: (userId: number, content: string) =>
        request<Message>('POST', `/api/messages/${userId}`, { content }),
};

export interface User {
    id: number;
    username: string;
    avatarColor: string;
}

export interface FriendUser {
    id: number;
    username: string;
    avatarColor: string;
    friendshipId: number;
}

export interface FriendsData {
    friends: FriendUser[];
    pendingSent: FriendUser[];
    pendingReceived: FriendUser[];
}

export interface Message {
    id: number;
    content: string;
    createdAt: number;
    sender: User;
}
