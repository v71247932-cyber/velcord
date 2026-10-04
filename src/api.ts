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
    let data: any = null;
    try { data = await res.json(); } catch { /* not JSON (an error page from the platform) */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Request failed'), { status: res.status });
    return data as T;
}

export const api = {
    register: (username: string, password: string) =>
        request<{ success: boolean }>('POST', '/api/auth/register', { username, password }),

    login: (username: string, password: string) =>
        request<{ token: string; user: User }>('POST', '/api/auth/login', { username, password }),

    me: () => request<User>('GET', '/api/me'),

    /** Waits until something new happens for me (message, call, tick), or ~12 s. */
    wait: (marks: string | null, tmark: string | null) =>
        request<{ marks: string; tmark: string; typing: TypingEntry[] }>('GET', marks && tmark ? `/api/wait?m=${marks}&t=${tmark}` : '/api/wait'),

    /** Tell the other side that I am typing (to = a friend, group = a group) */
    typing: (target: { to?: number; group?: number }) =>
        request<{ ok: boolean }>('POST', '/api/typing', target),

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

    getGroupMessages: (groupId: number, afterId = 0, channelId?: number) =>
        request<Message[]>('GET', `/api/groups/${groupId}/messages?after=${afterId}${channelId ? `&channel=${channelId}` : ''}`),

    sendGroupMessage: (groupId: number, content: string, channelId?: number) =>
        request<Message>('POST', `/api/groups/${groupId}/messages`, { content, channelId }),

    getChannels: (groupId: number) => request<{ max: number; channels: Channel[] }>('GET', `/api/groups/${groupId}/channels`),
    createChannel: (groupId: number, name: string, kind: 'text' | 'voice') => request<Channel>('POST', `/api/groups/${groupId}/channels`, { name, kind }),
    renameChannel: (channelId: number, name: string) => request<Channel>('PATCH', `/api/channels/${channelId}`, { name }),
    deleteChannel: (channelId: number) => request<{ success: boolean }>('DELETE', `/api/channels/${channelId}`),
    defaultVoice: (groupId: number) => request<{ id: number; name: string }>('POST', `/api/groups/${groupId}/default-voice`, {}),

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

    resolveGifLink: (link: string) => request<{ src: string; width: number | null; height: number | null }>('GET', `/api/gif-link?url=${encodeURIComponent(link)}`),

    getGifs: () => request<{ max: number; gifs: GifItem[] }>('GET', '/api/gifs'),

    saveGif: (arg: { gifId?: string; url?: string }) => request<GifItem>('POST', '/api/gifs/save', arg),

    gifOrigins: (ids: string[]) => request<Record<string, any>>('POST', '/api/gifs/origins', { ids }), // id -> origin; "__protected" lists the ids that cannot be copied

    switchAccount: () => request<{ token: string; user: User }>('POST', '/api/switch-account', {}),

    removeGif: (id: string) => request<{ success: boolean }>('DELETE', `/api/gifs/${id}`),

    callSignal: (to: number, type: string, payload?: unknown, conf?: number) =>
        request<{ success: boolean }>('POST', '/api/calls/signal', { to, type, conf, payload: payload === undefined ? undefined : JSON.stringify(payload) }),

    /** A voice channel is the room of a conference. ring = this join starts the call, so ring the rest of the group. */
    confJoin: (roomId: number, video: boolean, ring = false) =>
        request<{ started: boolean; max: number; groupId: number; channelName: string; roster: ConfPerson[] }>('POST', `/api/voice/${roomId}/join`, { video, ring }),

    confLeave: (roomId: number) => request<{ success: boolean }>('POST', `/api/voice/${roomId}/leave`, {}),

    confShare: (roomId: number, on: boolean) => request<{ success: boolean }>('POST', `/api/voice/${roomId}/share`, { on }),

    callPoll: (after: number, conf?: number) =>
        request<{ now: number; lastId?: number; roster?: ConfPerson[]; signals: CallSignal[] }>('GET', after < 0 ? '/api/calls/poll?init=1' : `/api/calls/poll?after=${after}${conf ? `&conf=${conf}` : ''}`),

    getUserProfile: (id: number) => request<UserProfile>('GET', `/api/users/${id}/profile`),

    setUserNote: (id: number, note: string) => request<{ success: boolean }>('PUT', `/api/users/${id}/note`, { note }),

    updateBanner: (patch: { bannerUrl?: string | null; bannerColors?: [string, string] | null }) =>
        request<User>('PATCH', '/api/me', patch),

    updateProfile: (username?: string, avatarUrl?: string | null, gifsProtected?: boolean) =>
        request<User>('PATCH', '/api/me', { username, avatarUrl, gifsProtected }),
};

export interface User {
    id: number;
    username: string;
    avatarColor: string;
    /** nobody else can copy this person's GIFs into their own list */
    gifsProtected?: boolean;
    /** blue check next to the name (Velcord and the test account) */
    tick?: boolean;
    /** this account is linked to another one and can switch to it */
    canSwitch?: boolean;
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
    tick?: boolean;
    online?: boolean;
    unread?: number;
    /** id of the newest message in the conversation with this friend (0 = none); sorts the list */
    lastMessageId?: number;
    lastUnreadId?: number;
    preview?: string | null;
    friendshipId: number;
}

export interface FriendsData {
    friends: FriendUser[];
    pendingSent: FriendUser[];
    pendingReceived: FriendUser[];
}

export interface TypingEntry {
    userId: number;
    username: string;
    toId: number | null;
    groupId: number | null;
}

export interface Channel {
    id: number;
    name: string;
    kind: 'text' | 'voice';
    position: number;
    /** voice channels only: who is in the room right now */
    participants?: ConfPerson[];
}

export interface GifItem {
    id: string;
    name: string;
    mime: string;
    size: number;
    createdAt: number;
    /** set when the GIF is a link (nothing stored): the picture's address */
    url?: string | null;
    /** the first copy of this GIF; the same for everyone who saved it */
    origin?: string;
}

export interface GroupMember {
    id: number;
    username: string;
    avatarColor: string;
    avatarUrl?: string;
    online: boolean;
    isOwner: boolean;
    verified?: boolean;
    tick?: boolean;
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

export interface ConfPerson {
    id: number;
    username: string;
    avatarColor: string;
    avatarUrl?: string | null;
    verified?: boolean;
    tick?: boolean;
    /** is sharing their screen in the voice channel */
    sharing?: boolean;
}

export interface CallSignal {
    id: number;
    conf?: number | null;
    from: User;
    type: 'invite' | 'accept' | 'reject' | 'hangup' | 'desc' | 'ice' | 'share' | 'cam' | 'conf-invite' | 'conf-desc' | 'conf-ice' | 'conf-cam' | 'conf-share' | 'conf-mute';
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
    /** how many people are in a conference call of this group right now */
    callCount?: number;
    /** how many of them are sharing their screen */
    sharingCount?: number;
}

export interface UserProfile {
    id: number;
    username: string;
    avatarColor: string;
    avatarUrl?: string | null;
    bannerUrl?: string | null;
    bannerColor1?: string | null;
    bannerColor2?: string | null;
    verified?: boolean;
    tick?: boolean;
    online: boolean;
    /** unix seconds */
    memberSince: number;
    friendship: { id: number; status: 'pending' | 'accepted'; since: number } | null;
    /** private note the viewer wrote about this person */
    note: string;
    mutualFriends: { id: number; username: string; avatarColor: string; avatarUrl?: string | null }[];
    mutualGroups: { id: number; name: string; avatarUrl?: string | null }[];
}
