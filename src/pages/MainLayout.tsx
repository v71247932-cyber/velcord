import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import type { FriendUser, FriendsData, Group } from '../api';
import Avatar from '../components/Avatar';
import FriendsPanel from './FriendsPanel';
import ChatPanel from './ChatPanel';
import GroupChatPanel from './GroupChatPanel';
import { useCall } from '../CallContext';
import { PhoneIcon, UsersIcon, PlusIcon } from '../components/Icons';
import ProfileCard from '../components/ProfileCard';
import GroupMembersPanel from '../components/GroupMembersPanel';
import CreateGroupModal from '../components/CreateGroupModal';

type View =
    | { type: 'friends' }
    | { type: 'dm'; friend: FriendUser }
    | { type: 'group'; group: Group };

export default function MainLayout() {
    const { user, logout, updateUser } = useAuth();
    const { phase: callPhase, startCall, muted, deafened, toggleMute, toggleDeafen } = useCall();
    const [view, setView] = useState<View>({ type: 'friends' });
    const [groups, setGroups] = useState<Group[]>([]);
    const [friendsData, setFriendsData] = useState<FriendsData>({ friends: [], pendingSent: [], pendingReceived: [] });
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    const [editUsername, setEditUsername] = useState(user?.username || '');
    const [updatingProfile, setUpdatingProfile] = useState(false);

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

    async function handleDeleteGroup(e: React.MouseEvent, group: Group) {
        if (e.shiftKey) {
            e.stopPropagation();
            if (group.ownerId !== user?.id) {
                alert('Only the owner can delete this group.');
                return;
            }
            if (confirm(`Are you sure you want to delete the group "${group.name}"?`)) {
                try {
                    await api.deleteGroup(group.id);
                    if (view.type === 'group' && view.group.id === group.id) {
                        setView({ type: 'friends' });
                    }
                    load();
                } catch (err: any) {
                    alert(err.message);
                }
            }
        }
    }

    async function handleUpdateProfile(e: React.FormEvent) {
        e.preventDefault();
        setUpdatingProfile(true);
        try {
            const updated = await api.updateProfile(editUsername);
            updateUser(updated);
            setShowProfileMenu(false);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setUpdatingProfile(false);
        }
    }

    // Accepts images up to 10 MB, crops to a centered square and downsizes
    // to 256x256 so the stored avatar stays small and never gets stretched.
    async function resizeAvatar(file: File): Promise<string> {
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error('Could not read this image'));
                i.src = url;
            });
            const SIZE = 256;
            const side = Math.min(img.naturalWidth, img.naturalHeight);
            const sx = (img.naturalWidth - side) / 2;
            const sy = (img.naturalHeight - side) / 2;
            const canvas = document.createElement('canvas');
            canvas.width = SIZE;
            canvas.height = SIZE;
            const ctx = canvas.getContext('2d')!;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
            return canvas.toDataURL('image/jpeg', 0.88);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            alert('Please choose an image file');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            alert('File too large (max 10 MB)');
            return;
        }

        setUpdatingProfile(true);
        try {
            const dataUrl = await resizeAvatar(file);
            const updated = await api.updateProfile(undefined, dataUrl);
            updateUser(updated);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setUpdatingProfile(false);
        }
    }
 
    async function handleRemoveAvatar() {
        if (!confirm('Are you sure you want to remove your profile picture?')) return;
        setUpdatingProfile(true);
        try {
            const updated = await api.updateProfile(undefined, null);
            updateUser(updated);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setUpdatingProfile(false);
        }
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
                    <UsersIcon size={22} />
                    {pendingCount > 0 ? (
                        <span className="badge">{pendingCount}</span>
                    ) : (
                        <span className="badge badge-dot" />
                    )}
                </button>
            </nav>

            {/* Channel/DM sidebar */}
            <aside className="channel-sidebar">
                <div className="dm-list">
                    {/* Groups Section */}
                    <div className="sidebar-section-header">
                        <span className="sidebar-section-label">GROUPS</span>
                        <button className="add-section-btn" onClick={() => setShowCreateGroup(true)} title="Create group"><PlusIcon size={16} /></button>
                    </div>
                    {groups.map(g => (
                        <div
                            key={g.id}
                            className={`dm-item ${currentGroup?.id === g.id ? 'active' : ''}`}
                            onClick={(e) => {
                                if (e.shiftKey) handleDeleteGroup(e, g);
                                else openGroup(g);
                            }}
                            title="Shift+Click to delete"
                        >
                            <Avatar name={g.name} color="#5865f2" src={g.avatarUrl ?? undefined} size="sm" />
                            <span className="dm-name">{g.name}</span>
                        </div>
                    ))}

                    <div className="sidebar-section-label" style={{ marginTop: 24 }}>DIRECT MESSAGES</div>

                    {friendsData.friends.length === 0 && (
                        <p style={{ padding: '0 16px', fontSize: 13, color: 'var(--text-muted)' }}>
                            No friends yet
                        </p>
                    )}

                    {/* Only accepted friends: a pending request shows up here after the other person accepts */}
                    {friendsData.friends.map(f => (
                        <div
                            key={f.id}
                            className={`dm-item ${currentFriend?.id === f.id ? 'active' : ''}`}
                            onClick={() => openDM(f)}
                            id={`dm-${f.id}`}
                        >
                            <Avatar name={f.username} color={f.avatarColor} src={f.avatarUrl} size="sm" status={f.online ? 'online' : 'offline'} />
                            <div className="sidebar-user-details">
                                <span className="dm-name">{f.username}</span>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="user-bar">
                    <div className="user-bar-main" onClick={() => setShowProfileMenu(true)} title="Profile settings">
                        <Avatar name={user!.username} color={user!.avatarColor} src={user!.avatarUrl} size="md" status="online" />
                        <div className="user-info">
                            <div className="user-name">{user!.username}</div>
                            <div className="user-tag">{deafened ? 'Deafened' : muted ? 'Muted' : 'Online'}</div>
                        </div>
                    </div>
                    <button className={`user-bar-btn ${muted || deafened ? 'is-off' : ''}`} onClick={toggleMute} title={muted || deafened ? 'Unmute' : 'Mute'}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="9" y="3" width="6" height="11" rx="3" />
                            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                            {(muted || deafened) && <path d="M3 3l18 18" />}
                        </svg>
                    </button>
                    <button className={`user-bar-btn ${deafened ? 'is-off' : ''}`} onClick={toggleDeafen} title={deafened ? 'Undeafen' : 'Deafen'}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
                            <rect x="3" y="14" width="4" height="6" rx="1.5" />
                            <rect x="17" y="14" width="4" height="6" rx="1.5" />
                            {deafened && <path d="M3 3l18 18" />}
                        </svg>
                    </button>
                    <button className="user-bar-btn user-bar-leave" onClick={logout} title="Leave">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                        </svg>
                    </button>
                </div>
            </aside>

            {/* Main content */}
            <main className="main-content">
                {view.type === 'friends' && (
                    <>
                        <div className="content-header">
                            <UsersIcon size={18} />
                            <span>Friends</span>
                        </div>
                        <FriendsPanel onOpenDM={openDM} />
                    </>
                )}
                {view.type === 'dm' && currentFriend && (() => {
                    const live = friendsData.friends.find(f => f.id === currentFriend.id) ?? currentFriend;
                    const isFriend = friendsData.friends.some(f => f.id === currentFriend.id);
                    return (
                        <div className="chat-split">
                            <div className="chat-main">
                                <div className="content-header">
                                    <Avatar name={live.username} color={live.avatarColor} src={live.avatarUrl} size="sm" zoomable status={live.online ? 'online' : 'offline'} />
                                    <span>{live.username}</span>
                                    {isFriend && (
                                        <button
                                            className="header-call-btn"
                                            onClick={() => startCall(live)}
                                            disabled={callPhase !== 'idle'}
                                            title="Start a voice call"
                                        >
                                            <PhoneIcon size={15} /> Call
                                        </button>
                                    )}
                                </div>
                                <ChatPanel key={currentFriend.id} friend={live} />
                            </div>
                            <ProfileCard friend={live} onCall={isFriend ? () => startCall(live) : undefined} callDisabled={callPhase !== 'idle'} />
                        </div>
                    );
                })()}
                {view.type === 'group' && currentGroup && (
                    <div className="chat-split">
                        <div className="chat-main">
                            <div className="content-header">
                                <Avatar name={currentGroup.name} color="#5865f2" src={currentGroup.avatarUrl ?? undefined} size="sm" />
                                <span>{currentGroup.name}</span>
                            </div>
                            <GroupChatPanel key={currentGroup.id} group={currentGroup} />
                        </div>
                        <GroupMembersPanel group={currentGroup} friends={friendsData.friends} onGroupChanged={load} />
                    </div>
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

            {showProfileMenu && (
                <div className="modal-overlay" onClick={() => setShowProfileMenu(false)}>
                    <div className="modal-content profile-modal" onClick={e => e.stopPropagation()}>
                        <div className="profile-banner" style={{ background: `linear-gradient(135deg, ${user!.avatarColor}, #1e1f22)` }}>
                            <button className="profile-close" onClick={() => setShowProfileMenu(false)} aria-label="Close">×</button>
                        </div>
                        <div className="profile-edit-body">
                            <div className="profile-avatar-row">
                                <label className="avatar-preview-container">
                                    <Avatar name={user!.username} color={user!.avatarColor} src={user!.avatarUrl} size="lg" />
                                    <span className="avatar-upload-overlay">Change</span>
                                    <input type="file" accept="image/*" onChange={handleAvatarUpload} hidden disabled={updatingProfile} />
                                </label>
                                <div className="profile-identity">
                                    <div className="profile-name">{user!.username}</div>
                                    <div className="avatar-hint">JPG, PNG, GIF or WebP, up to 10 MB</div>
                                </div>
                            </div>
                            <div className="avatar-buttons">
                                <label className={`btn-primary avatar-btn ${updatingProfile ? 'disabled' : ''}`}>
                                    {updatingProfile ? 'Uploading...' : 'Upload picture'}
                                    <input type="file" accept="image/*" onChange={handleAvatarUpload} hidden disabled={updatingProfile} />
                                </label>
                                {user?.avatarUrl && (
                                    <button type="button" className="avatar-btn avatar-btn-secondary" onClick={handleRemoveAvatar} disabled={updatingProfile}>
                                        Remove
                                    </button>
                                )}
                            </div>

                            <form onSubmit={handleUpdateProfile} className="profile-form">
                                <div className="form-group">
                                    <label>USERNAME</label>
                                    <input
                                        type="text"
                                        value={editUsername}
                                        onChange={e => setEditUsername(e.target.value)}
                                        placeholder="New username"
                                        disabled={updatingProfile}
                                    />
                                </div>
                                <div className="modal-actions">
                                    <button type="button" className="btn-link" onClick={() => setShowProfileMenu(false)}>
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        className="btn-primary"
                                        disabled={updatingProfile || !editUsername.trim() || editUsername === user?.username}
                                    >
                                        {updatingProfile ? 'Saving...' : 'Save Changes'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
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
                .profile-modal {
                    max-width: 440px;
                    width: 92%;
                    padding: 0 !important;
                    overflow: hidden;
                    border-radius: 12px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                }
                .profile-banner {
                    height: 96px;
                    position: relative;
                }
                .profile-close {
                    position: absolute;
                    top: 10px;
                    right: 10px;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    border: none;
                    background: rgba(0,0,0,0.35);
                    color: white;
                    font-size: 20px;
                    line-height: 1;
                    cursor: pointer;
                }
                .profile-close:hover { background: rgba(0,0,0,0.55); }
                .profile-edit-body { padding: 0 24px 24px; }
                .profile-avatar-row {
                    display: flex;
                    align-items: flex-end;
                    gap: 16px;
                    margin-top: -44px;
                    margin-bottom: 16px;
                }
                .avatar-preview-container {
                    position: relative;
                    width: 88px;
                    height: 88px;
                    border-radius: 50%;
                    border: 6px solid var(--bg-secondary);
                    box-sizing: content-box;
                    cursor: pointer;
                    flex-shrink: 0;
                    overflow: hidden;
                }
                .avatar-preview-container .avatar {
                    width: 88px !important;
                    height: 88px !important;
                    font-size: 36px;
                }
                .avatar-upload-overlay {
                    position: absolute;
                    inset: 0;
                    background: rgba(0,0,0,0.55);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    transition: opacity 0.2s;
                    color: white;
                    font-size: 12px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .avatar-preview-container:hover .avatar-upload-overlay { opacity: 1; }
                .profile-identity { padding-bottom: 6px; min-width: 0; }
                .profile-name {
                    font-size: 20px;
                    font-weight: 700;
                    color: var(--text-primary);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .avatar-hint { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
                .avatar-buttons { display: flex; gap: 8px; margin-bottom: 20px; }
                .avatar-btn {
                    padding: 8px 16px;
                    border-radius: 4px;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    display: inline-flex;
                    align-items: center;
                }
                .avatar-btn.disabled { opacity: 0.6; pointer-events: none; }
                .avatar-btn-secondary {
                    background: var(--bg-accent);
                    color: var(--status-danger, #ed4245);
                }
                .avatar-btn-secondary:hover:not(:disabled) { background: var(--bg-hover); }
                .profile-form .form-group {
                    margin-bottom: 16px;
                }
                .profile-form label {
                    display: block;
                    font-size: 12px;
                    font-weight: 700;
                    color: var(--text-muted);
                    margin-bottom: 8px;
                }
                .profile-form input {
                    width: 100%;
                    padding: 10px;
                    background: var(--bg-tertiary);
                    border: 1px solid transparent;
                    border-radius: 4px;
                    color: white;
                }
                .profile-form input:focus {
                    border-color: var(--blue);
                    outline: none;
                }
            `}</style>
        </div>
    );
}
