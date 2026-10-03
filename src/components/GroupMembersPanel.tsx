import { useEffect, useState } from 'react';
import { api } from '../api';
import type { GroupMember } from '../api';
import Avatar from './Avatar';

export default function GroupMembersPanel({ groupId }: { groupId: number }) {
    const [members, setMembers] = useState<GroupMember[]>([]);

    useEffect(() => {
        let stopped = false;
        setMembers([]);
        const load = async () => {
            try {
                const m = await api.getGroupMembers(groupId);
                if (!stopped) setMembers(m);
            } catch { /* noop */ }
        };
        load();
        const iv = setInterval(load, 5000);
        return () => { stopped = true; clearInterval(iv); };
    }, [groupId]);

    const online = members.filter(m => m.online);
    const offline = members.filter(m => !m.online);

    const row = (m: GroupMember) => (
        <div key={m.id} className={`member-row ${m.online ? '' : 'member-offline'}`}>
            <Avatar name={m.username} color={m.avatarColor} src={m.avatarUrl} size="sm" zoomable status={m.online ? 'online' : 'offline'} />
            <span className="member-name">{m.username}</span>
            {m.isOwner && <span className="member-owner" title="Group owner">👑</span>}
        </div>
    );

    return (
        <aside className="right-panel members-aside">
            <div className="members-title">Members — {members.length}</div>
            {online.length > 0 && <div className="members-section">Online — {online.length}</div>}
            {online.map(row)}
            {offline.length > 0 && <div className="members-section">Offline — {offline.length}</div>}
            {offline.map(row)}
        </aside>
    );
}
