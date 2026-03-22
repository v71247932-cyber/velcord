import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import type { FriendUser, FriendsData } from '../api';
import Avatar from '../components/Avatar';
import FriendsPanel from './FriendsPanel';
import ChatPanel from './ChatPanel';

type View = { type: 'friends' } | { type: 'dm'; friend: FriendUser };

export default function MainLayout() {
    const { user, logout } = useAuth();
    const [view, setView] = useState<View>({ type: 'friends' });
    const [dmList, setDmList] = useState<FriendUser[]>([]);
    const [friendsData, setFriendsData] = useState<FriendsData>({ friends: [], pendingSent: [], pendingReceived: [] });

    useEffect(() => {
        const load = async () => {
            try {
                const d = await api.getFriends();
                setFriendsData(d);
            } catch { /* noop */ }
        };
        load();
        const interval = setInterval(load, 5000);
        return () => clearInterval(interval);
    }, []);

    function openDM(friend: FriendUser) {
        setView({ type: 'dm', friend });
        setDmList(prev => {
            if (prev.find(f => f.id === friend.id)) return prev;
            return [friend, ...prev];
        });
    }

    const pendingCount = friendsData.pendingReceived.length;

    const currentFriend = view.type === 'dm' ? view.friend : null;

    return (
        <div className="app-layout">
            {/* Left navigation icons */}
            <nav className="nav-sidebar">
                <button
                    className={`nav-icon-btn ${view.type === 'friends' ? 'active' : ''}`}
                    onClick={() => setView({ type: 'friends' })}
                    title="Friends"
                    id="nav-friends"
                >
                    👥
                    {pendingCount > 0 && (
                        <span style={{
                            position: 'absolute', top: -2, right: -2,
                            background: 'var(--red)', color: 'white', fontSize: 10,
                            fontWeight: 700, width: 16, height: 16, borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                        }}>{pendingCount}</span>
                    )}
                </button>

                <div className="nav-separator" />

                {/* Recent DM icons */}
                {dmList.slice(0, 8).map(f => (
                    <button
                        key={f.id}
                        className={`nav-icon-btn ${currentFriend?.id === f.id ? 'active' : ''}`}
                        onClick={() => openDM(f)}
                        title={f.username}
                        style={{ overflow: 'hidden', background: f.avatarColor, borderRadius: currentFriend?.id === f.id ? '35%' : '50%' }}
                    >
                        <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>
                            {f.username.charAt(0).toUpperCase()}
                        </span>
                    </button>
                ))}

                <div className="nav-bottom">
                    <button className="nav-icon-btn" onClick={logout} title="Log out">
                        🚪
                    </button>
                </div>
            </nav>

            {/* Channel/DM sidebar */}
            <aside className="channel-sidebar">
                <div className="sidebar-header">
                    {view.type === 'friends' ? '👥 Friends' : '💬 Direct Messages'}
                </div>

                <div className="dm-list">
                    <div className="sidebar-section-label">Direct Messages</div>
                    {dmList.length === 0 && (
                        <p style={{ padding: '8px', fontSize: 13, color: 'var(--text-muted)' }}>
                            No recent conversations
                        </p>
                    )}
                    {dmList.map(f => (
                        <div
                            key={f.id}
                            className={`dm-item ${currentFriend?.id === f.id ? 'active' : ''}`}
                            onClick={() => openDM(f)}
                            id={`dm-${f.id}`}
                        >
                            <Avatar name={f.username} color={f.avatarColor} size="sm" />
                            <span className="dm-name">{f.username}</span>
                        </div>
                    ))}

                    <div className="sidebar-section-label" style={{ marginTop: 16 }}>Friends</div>
                    {friendsData.friends.map(f => (
                        <div
                            key={f.id}
                            className={`dm-item ${currentFriend?.id === f.id ? 'active' : ''}`}
                            onClick={() => openDM(f)}
                        >
                            <Avatar name={f.username} color={f.avatarColor} size="sm" />
                            <span className="dm-name">{f.username}</span>
                        </div>
                    ))}
                </div>

                {/* User panel at bottom */}
                <div className="user-panel">
                    <Avatar name={user!.username} color={user!.avatarColor} size="sm" />
                    <div className="user-info">
                        <div className="user-name">{user!.username}</div>
                        <div className="user-tag" style={{ color: 'var(--green)' }}>● Online</div>
                    </div>
                    <button className="logout-btn" onClick={logout} title="Log out">⎋</button>
                </div>
            </aside>

            {/* Main content */}
            <main className="main-content">
                {view.type === 'friends' && (
                    <>
                        <div className="content-header">
                            <span>👥</span>
                            <span>Friends</span>
                        </div>
                        <FriendsPanel onOpenDM={openDM} />
                    </>
                )}
                {view.type === 'dm' && currentFriend && (
                    <>
                        <div className="content-header">
                            <Avatar name={currentFriend.username} color={currentFriend.avatarColor} size="sm" />
                            <span>{currentFriend.username}</span>
                        </div>
                        <ChatPanel key={currentFriend.id} friend={currentFriend} />
                    </>
                )}
            </main>
        </div>
    );
}
