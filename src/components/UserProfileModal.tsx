import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FriendUser, Group, UserProfile } from '../api';
import Avatar from './Avatar';
import VerifiedBadge from './VerifiedBadge';
import { MessageIcon, UserPlusIcon, CloseIcon } from './Icons';
import { bannerStyle } from '../banner';
import './userProfile.css';

interface Props {
    userId: number;
    friends: FriendUser[];
    groups: Group[];
    onClose: () => void;
    onMessage: (friend: FriendUser) => void;
    onOpenGroup: (group: Group) => void;
    /** called after the friend list changed, so the app reloads it */
    onChanged: () => void;
}

type Tab = 'activity' | 'friends' | 'servers';

const fmtDate = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Full profile window opened by clicking a person's picture. */
export default function UserProfileModal({ userId, friends, groups, onClose, onMessage, onOpenGroup, onChanged }: Props) {
    const [p, setP] = useState<UserProfile | null>(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<Tab>('activity');
    const [menu, setMenu] = useState(false);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const savedNote = useRef('');

    useEffect(() => {
        let alive = true;
        api.getUserProfile(userId).then(r => {
            if (!alive) return;
            setP(r); setNote(r.note); savedNote.current = r.note;
        }).catch(e => alive && setError(e.message));
        return () => { alive = false; };
    }, [userId]);

    async function saveNote() {
        if (note === savedNote.current) return;
        savedNote.current = note;
        try { await api.setUserNote(userId, note); } catch { /* the next edit tries again */ }
    }

    const friend = friends.find(f => f.id === userId);
    const isFriend = p?.friendship?.status === 'accepted' && !!friend;

    async function addFriend() {
        if (!p) return;
        setBusy(true);
        try {
            await api.addFriend(p.username);
            setP(await api.getUserProfile(userId));
            onChanged();
        } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    }

    async function removeFriend() {
        if (!p?.friendship) return;
        setMenu(false);
        setBusy(true);
        try {
            await api.rejectFriend(p.friendship.id);
            setP(await api.getUserProfile(userId));
            onChanged();
        } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    }

    function message() {
        if (!friend) return;
        onClose();
        onMessage(friend);
    }

    const sharedGroups = p ? p.mutualGroups.map(g => groups.find(x => x.id === g.id) ?? null) : [];

    return (
        <div className="modal-overlay up-overlay" onClick={() => { saveNote(); onClose(); }}>
            <div className="up-window" onClick={e => { e.stopPropagation(); setMenu(false); }}>
                <button className="up-close" onClick={() => { saveNote(); onClose(); }} aria-label="Close"><CloseIcon size={18} /></button>
                {!p ? (
                    <div className="up-loading">{error || 'Loading…'}</div>
                ) : (
                    <>
                        <div className="up-left">
                            <div className="up-banner" style={bannerStyle(p)} />
                            <div className="up-avatar">
                                <Avatar name={p.username} color={p.avatarColor} src={p.avatarUrl ?? undefined} size="xl" zoomable status={p.online ? 'online' : 'offline'} />
                            </div>
                            <div className="up-info">
                                <div className="up-name">{p.username}{(p.verified || p.tick) && <VerifiedBadge size={20} />}</div>
                                <div className={`up-status ${p.online ? 'is-online' : ''}`}>{p.online ? 'Online' : 'Offline'}</div>

                                <div className="up-actions">
                                    {isFriend ? (
                                        <button className="up-btn up-btn-primary" onClick={message}><MessageIcon size={17} /> Message</button>
                                    ) : p.friendship?.status === 'pending' ? (
                                        <button className="up-btn up-btn-secondary" disabled>Request pending</button>
                                    ) : (
                                        <button className="up-btn up-btn-primary" onClick={addFriend} disabled={busy}><UserPlusIcon size={17} /> Add friend</button>
                                    )}
                                    <div className="up-menu-wrap">
                                        <button className="up-icon-btn" onClick={e => { e.stopPropagation(); setMenu(m => !m); }} aria-label="More">⋯</button>
                                        {menu && (
                                            <div className="up-menu" onClick={e => e.stopPropagation()}>
                                                <button onClick={() => { navigator.clipboard?.writeText(p.username).catch(() => {}); setMenu(false); }}>Copy username</button>
                                                {p.friendship && !p.verified && <button className="danger" onClick={removeFriend}>{p.friendship.status === 'accepted' ? 'Remove friend' : 'Cancel request'}</button>}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="up-field">
                                    <div className="up-label">Member Since</div>
                                    <div className="up-value">{fmtDate(p.memberSince)}</div>
                                </div>
                                {p.friendship?.status === 'accepted' && (
                                    <div className="up-field">
                                        <div className="up-label">Friends Since</div>
                                        <div className="up-value">{fmtDate(p.friendship.since)}</div>
                                    </div>
                                )}
                                <div className="up-field">
                                    <div className="up-label">Note (only visible to you)</div>
                                    <textarea
                                        className="up-note"
                                        value={note}
                                        maxLength={256}
                                        placeholder="Click to add a note"
                                        rows={2}
                                        onChange={e => setNote(e.target.value)}
                                        onBlur={saveNote}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="up-right">
                            <div className="up-tabs">
                                <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
                                <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>
                                    {p.mutualFriends.length === 0 ? 'No Mutual Friends' : `${p.mutualFriends.length} Mutual Friend${p.mutualFriends.length === 1 ? '' : 's'}`}
                                </button>
                                <button className={tab === 'servers' ? 'active' : ''} onClick={() => setTab('servers')}>
                                    {p.mutualGroups.length === 0 ? 'No Mutual Groups' : `${p.mutualGroups.length} Mutual Group${p.mutualGroups.length === 1 ? '' : 's'}`}
                                </button>
                            </div>
                            <div className="up-tab-body">
                                {tab === 'activity' && (
                                    <div className="up-empty">
                                        <strong>{p.username} doesn't have any activity to share here</strong>
                                        <span>{p.username} keeps their profile simple - ask what they're into</span>
                                        {isFriend && <button className="up-btn up-btn-secondary" onClick={message}><MessageIcon size={17} /> Message</button>}
                                    </div>
                                )}
                                {tab === 'friends' && (p.mutualFriends.length === 0 ? (
                                    <div className="up-empty"><strong>No mutual friends</strong></div>
                                ) : p.mutualFriends.map(m => {
                                    const f = friends.find(x => x.id === m.id);
                                    return (
                                        <div key={m.id} className="up-row">
                                            <Avatar name={m.username} color={m.avatarColor} src={m.avatarUrl ?? undefined} size="md" />
                                            <span className="up-row-name">{m.username}</span>
                                            {f && <button className="up-icon-btn" title="Message" onClick={() => { onClose(); onMessage(f); }}><MessageIcon size={16} /></button>}
                                        </div>
                                    );
                                }))}
                                {tab === 'servers' && (p.mutualGroups.length === 0 ? (
                                    <div className="up-empty"><strong>No mutual groups</strong></div>
                                ) : p.mutualGroups.map((g, i) => (
                                    <div key={g.id} className="up-row">
                                        <Avatar name={g.name} color="#5865f2" src={g.avatarUrl ?? undefined} size="md" />
                                        <span className="up-row-name">{g.name}</span>
                                        {sharedGroups[i] && <button className="up-icon-btn" title="Open group" onClick={() => { onClose(); onOpenGroup(sharedGroups[i]!); }}><MessageIcon size={16} /></button>}
                                    </div>
                                )))}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
