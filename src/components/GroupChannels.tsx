import { useState } from 'react';
import './channels.css';
import { api } from '../api';
import type { Channel, Group } from '../api';
import { useConference } from '../ConferenceContext';
import Avatar from './Avatar';
import { HashIcon, SpeakerIcon, PlusIcon, EditIcon, TrashIcon } from './Icons';

interface Props {
    group: Group;
    channels: Channel[];
    activeTextId: number | null;
    isOwner: boolean;
    onSelectText: (id: number) => void;
    onChanged: () => void;
    /** called after a channel was picked (closes the menu on a phone) */
    onPicked?: () => void;
}

/** The channel list of the open group: text channels, then voice channels with the people who are in them. */
export default function GroupChannels({ group, channels, activeTextId, isOwner, onSelectText, onChanged, onPicked }: Props) {
    const conference = useConference();
    const [creating, setCreating] = useState<'text' | 'voice' | null>(null);
    const [newName, setNewName] = useState('');
    const [renaming, setRenaming] = useState<number | null>(null);
    const [renameDraft, setRenameDraft] = useState('');
    const [busy, setBusy] = useState(false);

    const text = channels.filter(c => c.kind === 'text');
    const voice = channels.filter(c => c.kind === 'voice');

    async function create() {
        const name = newName.trim();
        if (!name || !creating || busy) return;
        setBusy(true);
        try {
            const made = await api.createChannel(group.id, name, creating);
            setCreating(null);
            setNewName('');
            onChanged();
            if (made.kind === 'text') onSelectText(made.id);
        } catch (e: any) { alert(e.message); } finally { setBusy(false); }
    }

    async function rename(c: Channel) {
        const name = renameDraft.trim();
        setRenaming(null);
        if (!name || name === c.name) return;
        try { await api.renameChannel(c.id, name); onChanged(); } catch (e: any) { alert(e.message); }
    }

    async function remove(c: Channel) {
        const warn = c.kind === 'text' ? `Delete #${c.name}? Its messages are deleted too.` : `Delete the voice channel "${c.name}"?`;
        if (!confirm(warn)) return;
        try { await api.deleteChannel(c.id); onChanged(); } catch (e: any) { alert(e.message); }
    }

    const startRename = (c: Channel) => { setRenaming(c.id); setRenameDraft(c.name); };

    const nameOrInput = (c: Channel) => renaming === c.id ? (
        <input
            className="chan-input"
            autoFocus
            maxLength={32}
            value={renameDraft}
            onClick={e => e.stopPropagation()}
            onChange={e => setRenameDraft(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') rename(c); if (e.key === 'Escape') setRenaming(null); }}
            onBlur={() => rename(c)}
        />
    ) : <span className="chan-name">{c.name}</span>;

    const tools = (c: Channel) => isOwner && renaming !== c.id && (
        <span className="chan-tools" onClick={e => e.stopPropagation()}>
            <button type="button" title="Rename" aria-label={`Rename ${c.name}`} onClick={() => startRename(c)}><EditIcon size={13} /></button>
            <button type="button" title="Delete" aria-label={`Delete ${c.name}`} onClick={() => remove(c)}><TrashIcon size={13} /></button>
        </span>
    );

    const createRow = (kind: 'text' | 'voice') => creating === kind && (
        <div className="chan-create">
            <input
                className="chan-input"
                autoFocus
                maxLength={32}
                placeholder={kind === 'text' ? 'new-channel' : 'New voice channel'}
                value={newName}
                disabled={busy}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') create(); if (e.key === 'Escape') { setCreating(null); setNewName(''); } }}
                onBlur={() => { if (!newName.trim()) { setCreating(null); setNewName(''); } }}
            />
        </div>
    );

    return (
        <div className="chan-list">
            <div className="chan-group-head" title={group.name}>
                <span>{group.name}</span>
            </div>

            <div className="chan-label">
                <span>Text channels</span>
                {isOwner && <button type="button" title="Create a text channel" aria-label="Create a text channel" onClick={() => { setCreating('text'); setNewName(''); }}><PlusIcon size={14} /></button>}
            </div>
            {text.map(c => (
                <div
                    key={c.id}
                    className={`chan-row ${c.id === activeTextId ? 'active' : ''}`}
                    onClick={() => { onSelectText(c.id); onPicked?.(); }}
                >
                    <HashIcon size={16} className="chan-icon" />
                    {nameOrInput(c)}
                    {tools(c)}
                </div>
            ))}
            {createRow('text')}

            <div className="chan-label">
                <span>Voice channels</span>
                {isOwner && <button type="button" title="Create a voice channel" aria-label="Create a voice channel" onClick={() => { setCreating('voice'); setNewName(''); }}><PlusIcon size={14} /></button>}
            </div>
            {voice.length === 0 && !creating && <div className="chan-empty">{isOwner ? 'No voice channels yet. Press + to make one.' : 'No voice channels yet.'}</div>}
            {voice.map(c => {
                const here = conference.activeRoomId === c.id;
                const people = c.participants ?? [];
                return (
                    <div key={c.id} className="chan-voice">
                        <div
                            className={`chan-row voice ${here ? 'joined' : ''}`}
                            onClick={() => {
                                if (here) { conference.setExpanded(true); return; } // clicking the room you are in shows the shared screen big again
                                conference.join(c.id, { groupId: group.id, groupName: group.name, channelName: c.name });
                                onPicked?.();
                            }}
                            title={here ? 'You are in this channel' : 'Join the voice channel'}
                        >
                            <SpeakerIcon size={16} className="chan-icon" />
                            {nameOrInput(c)}
                            {tools(c)}
                        </div>
                        {people.length > 0 && (
                            <div className="chan-people">
                                {people.map(p => (
                                    <div key={p.id} className="chan-person">
                                        <Avatar name={p.username} color={p.avatarColor} src={p.avatarUrl ?? undefined} size="sm" />
                                        <span>{p.username}</span>
                                        {p.sharing && <span className="chan-live" title="Sharing their screen">LIVE</span>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
            {createRow('voice')}
        </div>
    );
}
