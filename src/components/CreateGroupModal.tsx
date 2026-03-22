import { useState } from 'react';
import type { FriendUser } from '../api';
import { api } from '../api';
import Avatar from './Avatar';

interface CreateGroupModalProps {
    friends: FriendUser[];
    onClose: () => void;
    onCreated: (groupId: number) => void;
}

export default function CreateGroupModal({ friends, onClose, onCreated }: CreateGroupModalProps) {
    const [name, setName] = useState('');
    const [selected, setSelected] = useState<number[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const toggleFriend = (id: number) => {
        setSelected(prev =>
            prev.includes(id) ? prev.filter(f => f !== id) : [...prev, id]
        );
    };

    const handleCreate = async () => {
        if (!name.trim()) return setError('Enter a group name');
        if (selected.length === 0) return setError('Select at least one friend');

        setLoading(true);
        setError('');
        try {
            const group = await api.createGroup(name, selected);
            onCreated(group.id);
            onClose();
        } catch (err: any) {
            setError(err.message || 'Failed to create group');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Create Group</h2>
                    <button className="close-btn" onClick={onClose}>&times;</button>
                </div>

                <div className="modal-body">
                    {error && <div className="error-box">{error}</div>}

                    <div className="form-group">
                        <label>GROUP NAME</label>
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="My Awesome Group"
                            autoFocus
                        />
                    </div>

                    <div className="form-group">
                        <label>SELECT FRIENDS ({selected.length})</label>
                        <div className="friend-selector-list">
                            {friends.length === 0 ? (
                                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>You need friends to create a group!</p>
                            ) : (
                                friends.map(f => (
                                    <div
                                        key={f.id}
                                        className={`friend-select-item ${selected.includes(f.id) ? 'selected' : ''}`}
                                        onClick={() => toggleFriend(f.id)}
                                    >
                                        <Avatar name={f.username} color={f.avatarColor} size="sm" />
                                        <span className="friend-name">{f.username}</span>
                                        <div className="checkbox">
                                            {selected.includes(f.id) && '✓'}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="cancel-link" onClick={onClose}>Cancel</button>
                    <button
                        className="btn-primary"
                        onClick={handleCreate}
                        disabled={loading || friends.length === 0}
                    >
                        {loading ? 'Creating...' : 'Create Group'}
                    </button>
                </div>
            </div>

            <style>{`
                .friend-selector-list {
                    max-height: 200px;
                    overflow-y: auto;
                    margin-top: 8px;
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                .friend-select-item {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 8px;
                    border-radius: var(--radius-sm);
                    cursor: pointer;
                    transition: background 0.2s;
                }
                .friend-select-item:hover {
                    background: var(--bg-modifier);
                }
                .friend-select-item.selected {
                    background: rgba(88, 101, 242, 0.1);
                }
                .checkbox {
                    margin-left: auto;
                    width: 18px;
                    height: 18px;
                    border: 2px solid var(--border);
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    color: var(--blurple);
                    font-weight: 800;
                }
                .selected .checkbox {
                    border-color: var(--blurple);
                    background: var(--blurple);
                    color: white;
                }
                .error-box {
                    background: rgba(237, 66, 69, 0.1);
                    color: var(--red);
                    padding: 8px;
                    border-radius: var(--radius-sm);
                    font-size: 13px;
                    margin-bottom: 16px;
                    border: 1px solid var(--red);
                }
            `}</style>
        </div>
    );
}
