import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import type { FriendsData, Group } from '../api';
import Avatar from '../components/Avatar';
import FriendsPanel from './FriendsPanel';
import GroupChatPanel from './GroupChatPanel';
import CreateGroupModal from '../components/CreateGroupModal';

type View =
    | { type: 'friends' }
    | { type: 'group'; group: Group };

export default function MainLayout() {
    const { user, logout } = useAuth();
    const [view, setView] = useState<View>({ type: 'friends' });
    const [groups, setGroups] = useState<Group[]>([]);
    const [friendsData, setFriendsData] = useState<FriendsData>({ friends: [], pendingSent: [], pendingReceived: [] });
    const [showCreateGroup, setShowCreateGroup] = useState(false);

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

    function openGroup(group: Group) {
        setView({ type: 'group', group });
    }

    const pendingCount = friendsData.pendingReceived.length;
    const currentGroup = view.type === 'group' ? view.group : null;

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
                    onClick={() => setShowCreateGroup(true)}
                    title="Create Group"
                >
                    +
                </button>

                <div className="nav-bottom">
                    {/* Logout icon removed from here as requested */}
                </div>
            </nav>

            {/* Channel/DM sidebar */}
            <aside className="channel-sidebar">
                <div className="sidebar-header" style={{ display: 'none' }}>
                    {view.type === 'friends' ? '👥 Friends' : ''}
                </div>

                <div className="dm-list">
                    {/* Groups Section */}
                    <div className="sidebar-section-header">
                        <span className="sidebar-section-label">GROUPS</span>
                        <button className="add-section-btn" onClick={() => setShowCreateGroup(true)}>+</button>
                    </div>
                    {groups.length === 0 && (
                        <p style={{ padding: '0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
                            No groups yet. Create one with your friends!
                        </p>
                    )}
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

                    <div className="sidebar-section-label" style={{ marginTop: 24 }}>FRIENDS</div>
                    {friendsData.friends.length === 0 && (
                        <p style={{ padding: '0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
                            No friends yet
                        </p>
                    )}
                    {friendsData.friends.map(f => (
                        <div key={f.id} className="dm-item disabled-item" title="DMs are disabled. Create a group to chat!">
                            <Avatar name={f.username} color={f.avatarColor} size="sm" />
                            <span className="dm-name">{f.username}</span>
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
                        <FriendsPanel />
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
                .disabled-item {
                    opacity: 0.6;
                    cursor: default !important;
                }
            `}</style>
        </div>
    );
}
