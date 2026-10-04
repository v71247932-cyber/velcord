import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../AuthContext';
import { api } from '../api';
import type { FriendUser, FriendsData, Group } from '../api';
import Avatar from '../components/Avatar';
import FriendsPanel from './FriendsPanel';
import ChatPanel from './ChatPanel';
import GroupChatPanel from './GroupChatPanel';
import { useCall } from '../CallContext';
import { bannerStyle } from '../banner';
import { playMessageSound } from '../ringtones';
import { requestChatFocus } from '../focusChat';
import VerifiedBadge from '../components/VerifiedBadge';
import GroupSettingsModal from '../components/GroupSettingsModal';
import { onLive, startLive, stopLive } from '../live';
import BannerCropModal from '../components/BannerCropModal';
import { askNotificationPermissionOnFirstClick, notify, setBadge, isDesktopApp, isOldDesktopShell, isMobileDevice, isInstalledPwa, isIOS, INSTALL_COMMAND } from '../notify';
import { PhoneIcon, VideoIcon, UsersIcon, PlusIcon } from '../components/Icons';
import UserProfileModal from '../components/UserProfileModal';
import { PROFILE_EVENT } from '../components/Avatar';
import ProfileCard from '../components/ProfileCard';
import { useConference } from '../ConferenceContext';
import { useChannels } from '../useChannels';
import GroupChannels from '../components/GroupChannels';
import '../switch.css';
import GroupMembersPanel from '../components/GroupMembersPanel';
import CreateGroupModal from '../components/CreateGroupModal';

type View =
    | { type: 'friends' }
    | { type: 'dm'; friend: FriendUser }
    | { type: 'group'; group: Group };

export default function MainLayout() {
    const { user, logout, updateUser } = useAuth();
    const conference = useConference();
    const { phase: callPhase, startCall, muted, deafened, toggleMute, toggleDeafen } = useCall();
    const [view, setView] = useState<View>({ type: 'friends' });
    const [groups, setGroups] = useState<Group[]>([]);
    const [profileId, setProfileId] = useState<number | null>(null); // whose profile window is open
    useEffect(() => {
        const open = (e: Event) => setProfileId((e as CustomEvent<number>).detail);
        window.addEventListener(PROFILE_EVENT, open);
        return () => window.removeEventListener(PROFILE_EVENT, open);
    }, []);
    const [friendsData, setFriendsData] = useState<FriendsData>({ friends: [], pendingSent: [], pendingReceived: [] });
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    const [editUsername, setEditUsername] = useState(user?.username || '');
    const [updatingProfile, setUpdatingProfile] = useState(false);

    const viewRef = useRef(view);
    viewRef.current = view;
    const lastUnreadRef = useRef<Map<number, number> | null>(null);
    const openDMRef = useRef<(f: FriendUser) => void>(() => {});
    const [copied, setCopied] = useState(false);
    const [showGroupSettings, setShowGroupSettings] = useState(false);
    const [bannerC1, setBannerC1] = useState(user?.bannerColor1 || '#5865f2');
    const [bannerC2, setBannerC2] = useState(user?.bannerColor2 || '#eb459e');
    const [previewColors, setPreviewColors] = useState(false);
    const [cropFile, setCropFile] = useState<File | null>(null);
    // A new profile picture is only a draft until "Save Changes": undefined = unchanged, null = remove it
    const [draftAvatar, setDraftAvatar] = useState<string | null | undefined>(undefined);
    const [draftProtect, setDraftProtect] = useState<boolean | undefined>(undefined); // "protect my GIFs", saved with the rest
    useEffect(() => {
        if (!showProfileMenu) { setDraftAvatar(undefined); setDraftProtect(undefined); setEditUsername(user?.username || ''); }
    }, [showProfileMenu]); // eslint-disable-line react-hooks/exhaustive-deps
    const [switching, setSwitching] = useState(false);
    // Moves to the linked account (for testing). A fresh page start makes sure nothing of the old account is left behind.
    async function switchAccount() {
        if (switching) return;
        setSwitching(true);
        try {
            const r = await api.switchAccount();
            localStorage.setItem('velcord_token', r.token);
            window.location.reload();
        } catch (e: any) {
            setSwitching(false);
            alert(e.message || 'Could not switch the account');
        }
    }
    const [showInfo, setShowInfo] = useState(false); // phone: profile / members panel

    // Notify about new direct messages (and show the unread total on the dock/taskbar icon)
    const handleUnread = (friends: FriendUser[]) => {
        const prev = lastUnreadRef.current;
        const next = new Map(friends.map(f => [f.id, f.lastUnreadId || 0]));
        if (prev) {
            for (const f of friends) {
                if ((f.lastUnreadId || 0) <= (prev.get(f.id) ?? 0)) continue;
                const v = viewRef.current;
                const watching = document.hasFocus() && v.type === 'dm' && v.friend.id === f.id;
                if (!watching) {
                    playMessageSound();
                    notify(f.username, f.preview || 'New message', { tag: `dm-${f.id}`, onClick: () => openDMRef.current(f) });
                }
            }
        }
        lastUnreadRef.current = next;
        setBadge(friends.reduce((n, f) => n + (f.unread || 0), 0));
    };

    useEffect(() => { askNotificationPermissionOnFirstClick(); }, []);

    const load = async () => {
        try {
            const [f, g] = await Promise.all([
                api.getFriends(),
                api.getGroups()
            ]);
            setFriendsData(f);
            handleUnread(f.friends);
            setGroups(g);
        } catch { /* noop */ }
    };

    // After I send a message the conversation moves to the top at once
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        const h = () => loadRef.current();
        window.addEventListener('velcord:message-sent', h);
        window.addEventListener('velcord:call-left', h); // the "a call is going on" banner must not outlive my own call
        return () => { window.removeEventListener('velcord:message-sent', h); window.removeEventListener('velcord:call-left', h); };
    }, []);

    useEffect(() => {
        load();
        startLive();
        const off = onLive(load);
        // Presence needs a regular heartbeat (a person counts as online for 20 s after the last one)
        const interval = setInterval(load, 8000);
        return () => { clearInterval(interval); off(); stopLive(); };
    }, []);

    function openDM(friend: FriendUser) {
        setShowInfo(false);
        setView({ type: 'dm', friend });
        requestChatFocus();
        setTimeout(load, 1500); // the chat marks messages as seen, so refresh the unread list soon after
        setSidebarOpen(false); // Close on mobile
    }

    function openGroup(group: Group) {
        setShowInfo(false);
        setShowGroupSettings(false);
        setView({ type: 'group', group });
        requestChatFocus();
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
            const nameChanged = editUsername.trim() !== user?.username;
            const updated = await api.updateProfile(nameChanged ? editUsername.trim() : undefined, draftAvatar, draftProtect);
            updateUser(updated);
            setDraftAvatar(undefined);
            setDraftProtect(undefined);
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
            setDraftAvatar(await resizeAvatar(file)); // shown in the window only; saved with "Save Changes"
        } catch (err: any) {
            alert(err.message);
        } finally {
            setUpdatingProfile(false);
        }
    }
 
    async function handleBannerUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) { alert('Please choose an image file'); return; }
        if (file.size > 10 * 1024 * 1024) { alert('File too large (max 10 MB)'); return; }
        setCropFile(file); // the user picks the visible area next
    }

    async function saveCroppedBanner(dataUrl: string) {
        updateUser(await api.updateBanner({ bannerUrl: dataUrl }));
        setPreviewColors(false);
        setCropFile(null);
    }

    async function saveBannerColors() {
        setUpdatingProfile(true);
        try {
            updateUser(await api.updateBanner({ bannerColors: [bannerC1, bannerC2] }));
            setPreviewColors(false);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setUpdatingProfile(false);
        }
    }

    async function resetBanner() {
        setUpdatingProfile(true);
        try {
            updateUser(await api.updateBanner({ bannerUrl: null, bannerColors: null }));
            setPreviewColors(false);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setUpdatingProfile(false);
        }
    }

    function handleRemoveAvatar() {
        setDraftAvatar(null); // removed when "Save Changes" is pressed
    }

    openDMRef.current = openDM;
    const pendingCount = friendsData.pendingReceived.length;
    // Newest first. The chat that is open and in front is already being read, so it leaves the list at once.
    const unreadFriends = friendsData.friends
        .filter(f => (f.unread || 0) > 0 && !(view.type === 'dm' && view.friend.id === f.id && document.hasFocus()))
        .sort((a, b) => (b.lastUnreadId || 0) - (a.lastUnreadId || 0));
    const currentFriend = view.type === 'dm' ? view.friend : null;
    const currentGroup = view.type === 'group' ? (groups.find(g => g.id === view.group.id) ?? view.group) : null;

    // Channels of the open group: which text channel is shown (remembered per group)
    const { channels, reload: reloadChannels, loaded: channelsLoaded } = useChannels(currentGroup?.id ?? null);
    const [textChoice, setTextChoice] = useState<Record<number, number>>({});
    const textChannels = channels.filter(c => c.kind === 'text');
    const activeText = currentGroup
        ? (textChannels.find(c => c.id === textChoice[currentGroup.id]) ?? textChannels[0] ?? null)
        : null;
    const isGroupOwner = !!currentGroup && currentGroup.ownerId === user?.id;

    const getHeaderTitle = () => {
        if (view.type === 'friends') return 'Friends';
        if (view.type === 'dm') return `@${view.friend.username}`;
        if (view.type === 'group') return activeText ? `${view.group.name} · #${activeText.name}` : view.group.name;
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
                <span className="mobile-title">{getHeaderTitle()}</span>
                {view.type === 'dm' && currentFriend && friendsData.friends.some(f => f.id === currentFriend.id) && !currentFriend.verified && (
                    <div className="mobile-actions">
                        <button onClick={() => startCall(currentFriend)} disabled={callPhase !== 'idle'} aria-label="Call"><PhoneIcon size={20} /></button>
                        <button onClick={() => startCall(currentFriend, { video: true })} disabled={callPhase !== 'idle'} aria-label="Video call"><VideoIcon size={20} /></button>
                    </div>
                )}
                {view.type === 'group' && currentGroup && conference.activeGroupId !== currentGroup.id && (
                    <div className="mobile-actions">
                        <button onClick={() => conference.startGroupCall(currentGroup)} disabled={callPhase !== 'idle' || conference.activeGroupId !== null} aria-label="Group call"><PhoneIcon size={20} /></button>
                        <button onClick={() => conference.startGroupCall(currentGroup, true)} disabled={callPhase !== 'idle' || conference.activeGroupId !== null} aria-label="Group video call"><VideoIcon size={20} /></button>
                    </div>
                )}
                {(view.type === 'dm' || view.type === 'group') && (
                    <button className={`mobile-info-btn ${showInfo ? 'on' : ''}`} onClick={() => setShowInfo(v => !v)} aria-label="Info">
                        <UsersIcon size={20} />
                    </button>
                )}
            </header>

            {/* Left navigation icons */}
            <nav className="nav-sidebar">

                {/* Unread messages: the sender's picture waits here, above the groups, until the chat is opened */}
                {unreadFriends.map(f => (
                    <button
                        key={`unread-${f.id}`}
                        className="nav-icon-btn nav-unread-btn"
                        onClick={() => openDM(f)}
                        title={`${f.username}: ${f.preview || 'new message'}`}
                    >
                        <Avatar name={f.username} color={f.avatarColor} src={f.avatarUrl} size="lg" />
                        <span className="nav-unread-count">{(f.unread || 0) > 99 ? '99+' : f.unread}</span>
                    </button>
                ))}
                {unreadFriends.length > 0 && <div className="nav-separator" />}

                {groups.map(g => (
                    <button
                        key={g.id}
                        className={`nav-icon-btn nav-group-btn ${currentGroup?.id === g.id ? 'active' : ''} ${(g.callCount || 0) > 0 ? 'in-call' : ''}`}
                        onClick={(e) => {
                            if (e.shiftKey) handleDeleteGroup(e, g);
                            else if (currentGroup?.id === g.id) setShowGroupSettings(true); // click the selected group again
                            else openGroup(g);
                        }}
                        title={`${g.name} (Shift+Click to delete)`}
                    >
                        {g.avatarUrl
                            ? <img src={g.avatarUrl} alt={g.name} />
                            : <span>{g.name.substring(0, 2).toUpperCase()}</span>}
                    </button>
                ))}

                <button
                    className="nav-icon-btn add-btn"
                    onClick={() => { setShowCreateGroup(true); setSidebarOpen(false); }}
                    title="Create group"
                >
                    <PlusIcon size={22} />
                </button>
            </nav>

            {/* Channel/DM sidebar */}
            <aside className="channel-sidebar">
                <div className="dm-list">
                    <button
                        className={`friends-row ${view.type === 'friends' ? 'active' : ''}`}
                        onClick={() => { setView({ type: 'friends' }); setSidebarOpen(false); }}
                        id="nav-friends"
                    >
                        <UsersIcon size={20} />
                        <span>Friends</span>
                        {pendingCount > 0 && <span className="friends-row-badge">{pendingCount}</span>}
                    </button>

                    {view.type === 'group' && currentGroup && (
                        <GroupChannels
                            group={currentGroup}
                            channels={channels}
                            activeTextId={activeText?.id ?? null}
                            isOwner={isGroupOwner}
                            onSelectText={id => { setTextChoice(c => ({ ...c, [currentGroup.id]: id })); requestChatFocus(); }}
                            onChanged={reloadChannels}
                            onPicked={() => setSidebarOpen(false)}
                        />
                    )}

                    {/* The conversations list belongs to Friends and the chats; inside a group only the channels show */}
                    {view.type !== 'group' && (<>
                    <div className="sidebar-section-label dm-section-label">DIRECT MESSAGES</div>

                    {friendsData.friends.length === 0 && (
                        <p style={{ padding: '0 16px', fontSize: 13, color: 'var(--text-muted)' }}>
                            No friends yet
                        </p>
                    )}

                    {/* Only accepted friends: a pending request shows up here after the other person accepts */}
                    {/* Newest conversation first; friends I never wrote to follow in alphabetical order */}
                    {[...friendsData.friends]
                        .sort((a, b) => (b.lastMessageId || 0) - (a.lastMessageId || 0) || a.username.localeCompare(b.username))
                        .map(f => (
                        <div
                            key={f.id}
                            className={`dm-item ${currentFriend?.id === f.id ? 'active' : ''}`}
                            onClick={() => openDM(f)}
                            id={`dm-${f.id}`}
                        >
                            {(f.bannerUrl || (f.bannerColor1 && f.bannerColor2)) && <div className="dm-item-bg" style={bannerStyle(f)} />}
                            <Avatar name={f.username} color={f.avatarColor} src={f.avatarUrl} size="sm" status={f.online ? 'online' : 'offline'} />
                            <div className="sidebar-user-details">
                                <span className="dm-name">{f.username}{(f.verified || f.tick) && <VerifiedBadge size={14} />}</span>
                                {(f.unread || 0) > 0 && currentFriend?.id !== f.id && (
                                    <span className="unread-badge">{(f.unread || 0) > 99 ? '99+' : f.unread}</span>
                                )}
                            </div>
                        </div>
                    ))}
                    </>)}
                </div>

                {isOldDesktopShell() && (
                    <div className="shell-update">
                        <strong>New desktop window available</strong>
                        <span>Quit Velcord, then paste this in Terminal:</span>
                        <code>{INSTALL_COMMAND}</code>
                        <button type="button" onClick={() => { navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }}>
                            {copied ? 'Copied' : 'Copy command'}
                        </button>
                    </div>
                )}
                <div className="user-bar">
                    {(user!.bannerUrl || (user!.bannerColor1 && user!.bannerColor2)) && (
                        <div className="user-bar-bg" style={bannerStyle(user!)} />
                    )}
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
                    {user?.canSwitch && (
                        <button className="user-bar-btn" onClick={switchAccount} disabled={switching} title="Switch account" aria-label="Switch account">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 8h13l-3-3M20 16H7l3 3" />
                            </svg>
                        </button>
                    )}
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
                        <div className={`chat-split ${showInfo ? 'info-open' : ''}`}>
                            <div className="chat-main">
                                <div className="content-header">
                                    <Avatar name={live.username} color={live.avatarColor} src={live.avatarUrl} size="sm" zoomable userId={live.id} status={live.online ? 'online' : 'offline'} />
                                    <span className="header-name">{live.username}{(live.verified || live.tick) && <VerifiedBadge size={16} />}</span>
                                    {isFriend && !live.verified && (
                                        <button
                                            className="header-call-btn"
                                            onClick={() => startCall(live)}
                                            disabled={callPhase !== 'idle'}
                                            title="Start a voice call"
                                        >
                                            <PhoneIcon size={15} /> Call
                                        </button>
                                    )}
                                    {isFriend && !live.verified && (
                                        <button
                                            className="header-call-btn header-video-btn"
                                            onClick={() => startCall(live, { video: true })}
                                            disabled={callPhase !== 'idle'}
                                            title="Start a video call"
                                        >
                                            <VideoIcon size={15} /> Video
                                        </button>
                                    )}
                                </div>
                                <ChatPanel key={currentFriend.id} friend={live} />
                            </div>
                            <ProfileCard friend={live} onCall={isFriend && !live.verified ? () => startCall(live) : undefined} onVideoCall={isFriend && !live.verified ? () => startCall(live, { video: true }) : undefined} callDisabled={callPhase !== 'idle'} />
                        </div>
                    );
                })()}
                {view.type === 'group' && currentGroup && (
                    <div className={`chat-split ${showInfo ? 'info-open' : ''}`}>
                        <div className="chat-main">
                            <div className="content-header">
                                <div className="header-clickable" onClick={() => setShowGroupSettings(true)} title="Group settings">
                                    <Avatar name={currentGroup.name} color="#5865f2" src={currentGroup.avatarUrl ?? undefined} size="sm" />
                                    <span>{currentGroup.name}</span>
                                    <span className="header-chevron">▾</span>
                                </div>
                                {activeText && <span className="header-channel"># {activeText.name}</span>}
                                {conference.activeGroupId === currentGroup.id ? (
                                    <span className="header-in-call">● You are in the call</span>
                                ) : (
                                    <>
                                        <button className="header-call-btn" onClick={() => conference.startGroupCall(currentGroup)} disabled={callPhase !== 'idle' || conference.activeGroupId !== null} title="Start a group call">
                                            <PhoneIcon size={15} /> {(currentGroup.callCount || 0) > 0 ? 'Join call' : 'Call'}
                                        </button>
                                        <button className="header-call-btn header-video-btn" onClick={() => conference.startGroupCall(currentGroup, true)} disabled={callPhase !== 'idle' || conference.activeGroupId !== null} title="Start a group video call">
                                            <VideoIcon size={15} /> Video
                                        </button>
                                    </>
                                )}
                            </div>
                            {(currentGroup.callCount || 0) > 0 && conference.activeGroupId !== currentGroup.id && (
                                <div className="conf-banner">
                                    <span className="conf-banner-dot" />
                                    <span className="conf-banner-text">A call is going on · {currentGroup.callCount} in the call</span>
                                    <button onClick={() => conference.startGroupCall(currentGroup)} disabled={callPhase !== 'idle' || conference.activeGroupId !== null}>Join</button>
                                </div>
                            )}
                            {activeText
                                ? <GroupChatPanel key={`${currentGroup.id}-${activeText.id}`} group={currentGroup} channel={activeText} />
                                : <div className="empty-state" style={{ flex: 1 }}><p>{channelsLoaded ? 'This group has no text channel.' : 'Loading…'}</p></div>}
                        </div>
                        <GroupMembersPanel group={currentGroup} friends={friendsData.friends} onGroupChanged={load} />
                    </div>
                )}
            </main>

            {profileId !== null && (
                <UserProfileModal
                    userId={profileId}
                    friends={friendsData.friends}
                    groups={groups}
                    onClose={() => setProfileId(null)}
                    onMessage={openDM}
                    onOpenGroup={openGroup}
                    onChanged={load}
                />
            )}
            {showGroupSettings && currentGroup && (
                <GroupSettingsModal
                    group={currentGroup}
                    isOwner={currentGroup.ownerId === user?.id}
                    onClose={() => setShowGroupSettings(false)}
                    onChanged={load}
                />
            )}

            {showCreateGroup && (
                <CreateGroupModal
                    friends={friendsData.friends}
                    onClose={() => setShowCreateGroup(false)}
                    onCreated={(_id) => {
                        load();
                    }}
                />
            )}

            {cropFile && <BannerCropModal file={cropFile} onCancel={() => setCropFile(null)} onConfirm={saveCroppedBanner} />}

            {showProfileMenu && (
                <div className="modal-overlay" onClick={() => setShowProfileMenu(false)}>
                    <div className="modal-content profile-modal" onClick={e => e.stopPropagation()}>
                        <div className="profile-banner" style={previewColors ? { background: `linear-gradient(135deg, ${bannerC1}, ${bannerC2})` } : bannerStyle(user!)}>
                            <button className="profile-close" onClick={() => setShowProfileMenu(false)} aria-label="Close">×</button>
                        </div>
                        <div className="profile-edit-body">
                            <div className="profile-avatar-row">
                                <label className="avatar-preview-container">
                                    <Avatar name={user!.username} color={user!.avatarColor} src={draftAvatar === undefined ? user!.avatarUrl : (draftAvatar ?? undefined)} size="lg" />
                                    <span className="avatar-upload-overlay">Change</span>
                                    <input type="file" accept="image/*" onChange={handleAvatarUpload} hidden disabled={updatingProfile} />
                                </label>
                                <div className="profile-identity">
                                    <div className="profile-name">{user!.username}</div>
                                    <div className="avatar-hint">JPG, PNG, GIF or WebP, up to 10 MB</div>
                                    {draftAvatar !== undefined && <div className="avatar-unsaved">Not saved yet. Press Save Changes.</div>}
                                </div>
                            </div>
                            <div className="avatar-buttons">
                                <label className={`btn-primary avatar-btn ${updatingProfile ? 'disabled' : ''}`}>
                                    {updatingProfile ? 'Uploading...' : 'Upload picture'}
                                    <input type="file" accept="image/*" onChange={handleAvatarUpload} hidden disabled={updatingProfile} />
                                </label>
                                {(draftAvatar === undefined ? !!user?.avatarUrl : !!draftAvatar) && (
                                    <button type="button" className="avatar-btn avatar-btn-secondary" onClick={handleRemoveAvatar} disabled={updatingProfile}>
                                        Remove
                                    </button>
                                )}
                            </div>

                            {!isDesktopApp() && isMobileDevice() && !isInstalledPwa() && (
                                <div className="desktop-install">
                                    <div className="desktop-install-title">Install on your phone</div>
                                    {isIOS()
                                        ? <p>In Safari tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>. Velcord opens full screen like an app.</p>
                                        : <p>In Chrome tap the <strong>⋮</strong> menu, then <strong>Add to Home screen</strong> (or <strong>Install app</strong>).</p>}
                                </div>
                            )}
                            {!isDesktopApp() && !isMobileDevice() && (
                                <div className="desktop-install">
                                    <div className="desktop-install-title">Desktop app</div>
                                    <p>Install Velcord on your Mac or Linux computer. Paste this in a terminal:</p>
                                    <div className="desktop-install-cmd">
                                        <code>{INSTALL_COMMAND}</code>
                                        <button onClick={() => {
                                            navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {});
                                        }}>{copied ? 'Copied' : 'Copy'}</button>
                                    </div>
                                </div>
                            )}

                            {user?.username.toLowerCase() === 'idk' && <label className="protect-row">
                                <input
                                    type="checkbox"
                                    checked={draftProtect ?? !!user?.gifsProtected}
                                    onChange={e => setDraftProtect(e.target.checked === !!user?.gifsProtected ? undefined : e.target.checked)}
                                    disabled={updatingProfile}
                                />
                                <span className="protect-switch" aria-hidden="true" />
                                <span className="protect-text">
                                    <strong>Protect my GIFs</strong>
                                    <small>Nobody else can add your GIFs to their own list.</small>
                                </span>
                            </label>}

                            <div className="banner-editor">
                                <div className="desktop-install-title">Profile banner</div>
                                <div className="banner-editor-row">
                                    <label className={`avatar-btn avatar-btn-secondary banner-btn ${updatingProfile ? 'disabled' : ''}`}>
                                        Upload picture
                                        <input type="file" accept="image/*" hidden onChange={handleBannerUpload} disabled={updatingProfile} />
                                    </label>
                                    <button type="button" className="avatar-btn avatar-btn-secondary banner-btn" onClick={resetBanner} disabled={updatingProfile}>Reset</button>
                                </div>
                                <div className="banner-editor-row banner-colors">
                                    <span>or two colours</span>
                                    <input type="color" value={bannerC1} onChange={e => { setBannerC1(e.target.value); setPreviewColors(true); }} aria-label="First colour" />
                                    <input type="color" value={bannerC2} onChange={e => { setBannerC2(e.target.value); setPreviewColors(true); }} aria-label="Second colour" />
                                    <button type="button" className="avatar-btn avatar-btn-secondary banner-btn" onClick={saveBannerColors} disabled={updatingProfile || !previewColors}>Apply</button>
                                </div>
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
                                        disabled={updatingProfile || !editUsername.trim() || (editUsername.trim() === user?.username && draftAvatar === undefined && draftProtect === undefined)}
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
