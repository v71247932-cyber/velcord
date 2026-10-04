import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FriendUser, Group, GroupMember } from '../api';
import '../group.css';
import Avatar from './Avatar';
import VerifiedBadge from './VerifiedBadge';
import { CrownIcon, UserPlusIcon, CheckIcon } from './Icons';

interface Props {
    group: Group;
    friends: FriendUser[];
    onGroupChanged: () => void;
}

export default function GroupMembersPanel({ group, friends, onGroupChanged }: Props) {
    const [members, setMembers] = useState<GroupMember[]>([]);
    const [showAdd, setShowAdd] = useState(false);
    const [selected, setSelected] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        try { setMembers(await api.getGroupMembers(group.id)); } catch { /* noop */ }
    };

    useEffect(() => {
        let stopped = false;
        setMembers([]);
        const run = async () => {
            try {
                const m = await api.getGroupMembers(group.id);
                if (!stopped) setMembers(m);
            } catch { /* noop */ }
        };
        run();
        const iv = setInterval(run, 5000);
        return () => { stopped = true; clearInterval(iv); };
    }, [group.id]);

    const online = members.filter(m => m.online);
    const offline = members.filter(m => !m.online);
    const memberIds = new Set(members.map(m => m.id));
    const addable = friends.filter(f => !memberIds.has(f.id));

    async function addSelected() {
        if (selected.length === 0) return;
        setBusy(true);
        try {
            await api.addGroupMembers(group.id, selected);
            setSelected([]);
            setShowAdd(false);
            await load();
            onGroupChanged();
        } catch (e: any) {
            alert(e.message);
        } finally {
            setBusy(false);
        }
    }

    const row = (m: GroupMember) => (
        <div key={m.id} className={`member-row ${m.online ? '' : 'member-offline'}`}>
            <Avatar name={m.username} color={m.avatarColor} src={m.avatarUrl} size="sm" zoomable userId={m.id} status={m.online ? 'online' : 'offline'} />
            <span className="member-name">{m.username}{m.verified && <VerifiedBadge size={14} />}</span>
            {m.isOwner && <span className="member-owner" title="Group owner"><CrownIcon size={13} /> Owner</span>}
        </div>
    );

    return (
        <aside className="right-panel members-aside">
            <div className="members-head">
                <div className="members-title">Members — {members.length}</div>
                <button className="members-add" onClick={() => setShowAdd(true)} title="Add members" aria-label="Add members">
                    <UserPlusIcon size={18} />
                </button>
            </div>

            <div className="members-list">
                {online.length > 0 && <div className="members-section">Online — {online.length}</div>}
                {online.map(row)}
                {offline.length > 0 && <div className="members-section">Offline — {offline.length}</div>}
                {offline.map(row)}
            </div>

            {showAdd && (
                <div className="modal-overlay" onClick={() => setShowAdd(false)}>
                    <div className="modal-content" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
                        <div className="modal-header"><h2>Add members</h2></div>
                        <div className="modal-body">
                            {addable.length === 0 ? (
                                <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                                    All your friends are already in this group.
                                </p>
                            ) : (
                                <div className="pick-list">
                                    {addable.map(f => {
                                        const on = selected.includes(f.id);
                                        return (
                                            <div key={f.id} className={`pick-row ${on ? 'on' : ''}`}
                                                onClick={() => setSelected(s => on ? s.filter(x => x !== f.id) : [...s, f.id])}>
                                                <Avatar name={f.username} color={f.avatarColor} src={f.avatarUrl} size="sm" status={f.online ? 'online' : 'offline'} />
                                                <span className="pick-name">{f.username}</span>
                                                <span className="pick-check">{on && <CheckIcon size={14} />}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="btn-link" onClick={() => { setShowAdd(false); setSelected([]); }}>Cancel</button>
                            <button className="btn-primary" onClick={addSelected} disabled={busy || selected.length === 0}>
                                {busy ? 'Adding…' : `Add${selected.length ? ` (${selected.length})` : ''}`}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </aside>
    );
}
