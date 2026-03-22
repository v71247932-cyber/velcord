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
    const [dmList, setDmList] = useState<FriendUser[]>([]);
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

    function openDM(friend: FriendUser) {
        setView({ type: 'dm', friend });
        setDmList(prev => {
            if (prev.find(f => f.id === friend.id)) return prev;
            return [friend, ...prev];
        });
    }

    function openGroup(group: Group) {
        setView({ type: 'group', group });
    }

    const pendingCount = friendsData.pendingReceived.length;
    const currentFriend = view.type === 'dm' ? view.friend : null;
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
                    <div className="sidebar-section-label" style={{ display: 'none' }}>Direct Messages</div>

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

                    <div className="sidebar-section-label" style={{ marginTop: 16 }}>DIRECT MESSAGES</div>
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

                    <div className="sidebar-section-label" style={{ marginTop: 16 }}>FRIENDS</div>
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
                        // Optional: automatically open the newly created group
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
            `}</style>
        </div>
    );
}
