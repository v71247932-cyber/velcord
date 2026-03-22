import { useState, useEffect } from 'react';
import { api } from '../api';
import type { FriendUser, FriendsData } from '../api';
import Avatar from '../components/Avatar';

interface FriendsPanelProps {
    onOpenDM: (friend: FriendUser) => void;
}

type Tab = 'all' | 'pending' | 'add';

export default function FriendsPanel({ onOpenDM }: FriendsPanelProps) {
    const [tab, setTab] = useState<Tab>('all');
    const [data, setData] = useState<FriendsData>({ friends: [], pendingSent: [], pendingReceived: [] });
    const [addUsername, setAddUsername] = useState('');
    const [addMsg, setAddMsg] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadFriends();
        const interval = setInterval(loadFriends, 5000);
        return () => clearInterval(interval);
    }, []);

    async function loadFriends() {
        try {
            const d = await api.getFriends();
            setData(d);
        } catch { /* noop */ }
        finally { setLoading(false); }
    }

    async function handleAddFriend(e: React.FormEvent) {
        e.preventDefault();
        setAddMsg(null);
        try {
            const res = await api.addFriend(addUsername.trim());
            setAddMsg({ type: 'success', text: (res as any).message || 'Friend request sent!' });
            setAddUsername('');
            loadFriends();
        } catch (err: any) {
            setAddMsg({ type: 'error', text: err.message });
        }
    }

    async function handleAccept(friendshipId: number) {
        try {
            await api.acceptFriend(friendshipId);
            loadFriends();
        } catch { /* noop */ }
    }

    async function handleReject(friendshipId: number) {
        try {
            await api.rejectFriend(friendshipId);
            loadFriends();
        } catch { /* noop */ }
    }

    const pendingCount = data.pendingReceived.length;

    return (
        <div className="friends-panel">
            <div className="friends-tabs">
                <button className={`friend-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
                    All Friends {data.friends.length > 0 && `(${data.friends.length})`}
                </button>
                <button className={`friend-tab ${tab === 'pending' ? 'active' : ''}`} onClick={() => setTab('pending')}>
                    Pending
                    {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
                </button>
                <button className={`friend-tab ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>
                    Add Friend
                </button>
            </div>

            <div className="friends-body">
                {tab === 'all' && (
                    <>
                        {loading && (
                            <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
                                <div className="spinner" />
                            </div>
                        )}
                        {!loading && data.friends.length === 0 && (
                            <div className="empty-state">
                                <div className="empty-icon">👥</div>
                                <p>No friends yet. Add someone using the <strong>Add Friend</strong> tab!</p>
                            </div>
                        )}
                        {!loading && data.friends.length > 0 && (
                            <>
                                <div className="section-header">Friends — {data.friends.length}</div>
                                {data.friends.map(f => (
                                    <div key={f.id} className="friend-item">
                                        <Avatar name={f.username} color={f.avatarColor} size="md" />
                                        <div className="friend-info">
                                            <div className="friend-name">{f.username}</div>
                                            <div className="friend-status">Online</div>
                                        </div>
                                        <div className="friend-actions">
                                            <button className="btn btn-secondary btn-sm" onClick={() => onOpenDM(f)}>
                                                💬 Message
                                            </button>
                                            <button className="btn btn-danger btn-sm" onClick={() => handleReject(f.friendshipId)}
                                                title="Remove friend">
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                    </>
                )}

                {tab === 'pending' && (
                    <>
                        {data.pendingReceived.length === 0 && data.pendingSent.length === 0 && (
                            <div className="empty-state">
                                <div className="empty-icon">📭</div>
                                <p>No pending friend requests.</p>
                            </div>
                        )}
                        {data.pendingReceived.length > 0 && (
                            <>
                                <div className="section-header">Incoming — {data.pendingReceived.length}</div>
                                {data.pendingReceived.map(f => (
                                    <div key={f.id} className="friend-item">
                                        <Avatar name={f.username} color={f.avatarColor} size="md" />
                                        <div className="friend-info">
                                            <div className="friend-name">{f.username}</div>
                                            <div className="friend-status">Incoming Friend Request</div>
                                        </div>
                                        <div className="friend-actions">
                                            <button className="btn btn-success" onClick={() => handleAccept(f.friendshipId)}>✓ Accept</button>
                                            <button className="btn btn-danger" onClick={() => handleReject(f.friendshipId)}>✕ Decline</button>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                        {data.pendingSent.length > 0 && (
                            <>
                                <div className="section-header" style={{ marginTop: '16px' }}>Outgoing — {data.pendingSent.length}</div>
                                {data.pendingSent.map(f => (
                                    <div key={f.id} className="friend-item">
                                        <Avatar name={f.username} color={f.avatarColor} size="md" />
                                        <div className="friend-info">
                                            <div className="friend-name">{f.username}</div>
                                            <div className="friend-status">Outgoing Friend Request</div>
                                        </div>
                                        <div className="friend-actions">
                                            <button className="btn btn-danger btn-sm" onClick={() => handleReject(f.friendshipId)}>
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                    </>
                )}

                {tab === 'add' && (
                    <div className="add-friend-panel">
                        <h2>Add Friend</h2>
                        <p>You can add friends by their exact username.</p>
                        {addMsg && (
                            <div className={addMsg.type === 'error' ? 'error-msg' : 'success-msg'}>
                                {addMsg.type === 'error' ? '⚠ ' : '✓ '}{addMsg.text}
                            </div>
                        )}
                        <form className="add-friend-form" onSubmit={handleAddFriend}>
                            <input
                                type="text"
                                value={addUsername}
                                onChange={e => setAddUsername(e.target.value)}
                                placeholder="Enter username..."
                                autoFocus
                                required
                            />
                            <button type="submit" className="btn btn-primary btn-sm">
                                Send Request
                            </button>
                        </form>
                    </div>
                )}
            </div>
        </div>
    );
}
