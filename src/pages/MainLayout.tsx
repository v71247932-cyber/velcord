import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import type { FriendUser, FriendsData, Group } from '../api';
import Avatar from '../components/Avatar';
import FriendsPanel from './FriendsPanel';
import ChatPanel from './ChatPanel';
import GroupChatPanel from './GroupChatPanel';
import CreateGroupModal from '../components/CreateGroupModal';

type View =
    | { type: 'friends' }
    | { type: 'dm'; friend: FriendUser }
    | { type: 'group'; group: Group };

export default function MainLayout() {
    const { user, logout } = useAuth();
    const [view, setView] = useState<View>({ type: 'friends' });
    const [groups, setGroups] = useState<Group[]>([]);
    const [friendsData, setFriendsData] = useState<FriendsData>({ friends: [], pendingSent: [], pendingReceived: [] });
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);

    const load = async () => {
        try {
            const [f, g] = await Promise.all([
                api.getFriends(),
                api.getGroups()
            ]);
            setFriendsData(f);
            setGroups(g);
        } catch { /* noop */ }
    };

    useEffect(() => {
        load();
        const interval = setInterval(load, 5000);
        return () => clearInterval(interval);
    }, []);

    function openDM(friend: FriendUser) {
        setView({ type: 'dm', friend });
        setSidebarOpen(false); // Close on mobile
    }

    function openGroup(group: Group) {
        setView({ type: 'group', group });
        setSidebarOpen(false); // Close on mobile
    }

    const pendingCount = friendsData.pendingReceived.length;
    const currentFriend = view.type === 'dm' ? view.friend : null;
    const currentGroup = view.type === 'group' ? view.group : null;

    const getHeaderTitle = () => {
        if (view.type === 'friends') return 'Friends';
        if (view.type === 'dm') return `@${view.friend.username}`;
        if (view.type === 'group') return `# ${view.group.name}`;
        return 'Velcord';
    };

    return (
        <div className={`app-layout ${sidebarOpen ? 'sidebar-open' : ''}`}>

            <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />

            {/* Mobile Top Header */}
            <header className="mobile-header">
                <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
                    ☰
                </button>
                <span style={{ fontWeight: 600 }}>{getHeaderTitle()}</span>
            </header>

            {/* Left navigation icons */}
            <nav className="nav-sidebar">
                <button
                    className={`nav-icon-btn ${view.type === 'friends' ? 'active' : ''}`}
                    onClick={() => {
                        setView({ type: 'friends' });
                        setSidebarOpen(false);
                    }}
                    title="Friends"
                    id="nav-friends"
                >
                    👥
                    {pendingCount > 0 ? (
                        <span className="badge">{pendingCount}</span>
                    ) : (
                        <span className="badge badge-dot" />
                    )}
                </button>

                <div className="nav-separator" />

                {/* Groups in the icon sidebar circle icons */}
                {groups.map(g => (
                    <button
                        key={g.id}
                        className={`nav-icon-btn ${currentGroup?.id === g.id ? 'active' : ''}`}
                        onClick={() => openGroup(g)}
                        title={g.name}
                        style={{ background: 'var(--bg-accent)', borderRadius: currentGroup?.id === g.id ? '35%' : '50%' }}
                    >
                        <span style={{ color: 'white', fontWeight: 700, fontSize: 13 }}>
                            {g.name.substring(0, 2).toUpperCase()}
                        </span>
                    </button>
                ))}

                <button
                    className="nav-icon-btn add-btn"
                    onClick={() => {
                        setShowCreateGroup(true);
                        setSidebarOpen(false);
                    }}
                    title="Create Group"
                >
                    +
                </button>
            </nav>

            {/* Channel/DM sidebar */}
            <aside className="channel-sidebar">
                <div className="dm-list">
                    {/* Groups Section */}
                    <div className="sidebar-section-header">
                        <span className="sidebar-section-label">GROUPS</span>
                        <button className="add-section-btn" onClick={() => setShowCreateGroup(true)}>+</button>
                    </div>
                    {groups.map(g => (
                        <div
                            key={g.id}
                            className={`dm-item ${currentGroup?.id === g.id ? 'active' : ''}`}
                            onClick={() => openGroup(g)}
                        >
                            <div className="group-icon-sm">#</div>
                            <span className="dm-name">{g.name}</span>
                        </div>
                    ))}

                    <div className="sidebar-section-label" style={{ marginTop: 24 }}>DIRECT MESSAGES</div>

                    {/* List ALL friends here as requested, regardless of online/recent status */}
                    {[...friendsData.friends, ...friendsData.pendingReceived, ...friendsData.pendingSent].length === 0 && (
                        <p style={{ padding: '0 16px', fontSize: 13, color: 'var(--text-muted)' }}>
                            No friends yet
                        </p>
                    )}

                    {/* Combine friends and pending lists for the sidebar as requested previously for DMs */}
                    {[...friendsData.friends, ...friendsData.pendingReceived, ...friendsData.pendingSent].map(f => (
                        <div
                            key={f.id}
                            className={`dm-item ${currentFriend?.id === f.id ? 'active' : ''}`}
                            onClick={() => openDM(f)}
                            id={`dm-${f.id}`}
                        >
                            <Avatar name={f.username} color={f.avatarColor} size="sm" />
                            <div className="sidebar-user-details">
                                <span className="dm-name">{f.username}</span>
                                <span className="user-status-dot" style={{ background: friendsData.friends.find(af => af.id === f.id) ? 'var(--green)' : 'var(--text-muted)' }} />
                            </div>
                        </div>
                    ))}
                </div>

                <div className="user-panel">
                    <Avatar name={user!.username} color={user!.avatarColor} size="sm" />
                    <div className="user-info">
                        <div className="user-name">{user!.username}</div>
                        <div className="user-tag" style={{ color: 'var(--green)' }}>● Online</div>
                    </div>
                    <button className="leave-btn" onClick={logout}>Leave</button>
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
                {view.type === 'group' && currentGroup && (
                    <>
                        <div className="content-header">
                            <div className="group-icon-sm">#</div>
                            <span>{currentGroup.name}</span>
                            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                                ({currentGroup.memberCount} members)
                            </span>
                        </div>
                        <GroupChatPanel key={currentGroup.id} group={currentGroup} />
                    </>
                )}
            </main>

            {showCreateGroup && (
                <CreateGroupModal
                    friends={friendsData.friends}
                    onClose={() => setShowCreateGroup(false)}
                    onCreated={(_id) => {
                        load();
                    }}
                />
            )}

            <style>{`
                .sidebar-section-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding-right: 8px;
                }
                .add-section-btn {
                    background: none;
                    border: none;
                    color: var(--text-muted);
                    font-size: 18px;
                    cursor: pointer;
                    line-height: 1;
                }
                .add-section-btn:hover {
                    color: var(--text-primary);
                }
                .group-icon-sm {
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--text-muted);
                    font-size: 20px;
                    font-weight: 400;
                }
                .nav-icon-btn.add-btn {
                    color: var(--green);
                    background: var(--bg-accent);
                    font-size: 24px;
                }
                .nav-icon-btn.add-btn:hover {
                    background: var(--green);
                    color: white;
                    border-radius: 35%;
                }
                .sidebar-user-details {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex: 1;
                }
                .user-status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                }
            `}</style>
        </div>
    );
}
