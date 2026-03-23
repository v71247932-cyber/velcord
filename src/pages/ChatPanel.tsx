import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import type { Message, FriendUser } from '../api';
import { useAuth } from '../AuthContext';
import Avatar from '../components/Avatar';

interface ChatPanelProps {
    friend: FriendUser;
}

function formatTime(ts: number): string {
    const d = new Date(ts * 1000);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today at ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

export default function ChatPanel({ friend }: ChatPanelProps) {
    const { user } = useAuth();
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const lastTimestamp = useRef<number>(0);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const initialized = useRef(false);

    const loadMessages = useCallback(async (initial = false) => {
        try {
            const since = initial ? 0 : lastTimestamp.current;
            const newMsgs = await api.getMessages(friend.id, since);
            if (newMsgs.length > 0) {
                if (initial) {
                    setMessages(newMsgs);
                } else {
                    setMessages(prev => [...prev, ...newMsgs]);
                }
                lastTimestamp.current = Math.max(...newMsgs.map(m => m.createdAt));
            }
        } catch { /* noop */ }
    }, [friend.id]);

    // Initial load + polling
    useEffect(() => {
        initialized.current = false;
        setMessages([]);
        lastTimestamp.current = 0;
        loadMessages(true).then(() => { initialized.current = true; });
        const interval = setInterval(() => loadMessages(false), 2000);
        return () => clearInterval(interval);
    }, [friend.id, loadMessages]);

    // Auto-scroll on new messages
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    async function handleSend() {
        const content = input.trim();
        if (!content || sending) return;
        setInput('');
        setSending(true);
        try {
            const msg = await api.sendMessage(friend.id, content);
            setMessages(prev => [...prev, { ...msg, sender: user! }]);
            lastTimestamp.current = Math.max(lastTimestamp.current, msg.createdAt);
        } catch { /* noop */ }
        finally {
            setSending(false);
            textareaRef.current?.focus();
        }
    }

    function handleKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }

    // Auto-resize textarea
    function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
        setInput(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
    }

    async function handleDeleteMessage(e: React.MouseEvent, msg: Message) {
        if (e.shiftKey) {
            e.stopPropagation();
            if (msg.sender.id !== user?.id) return; // Only delete own messages

            if (confirm('Delete this message?')) {
                try {
                    await api.deleteMessage(msg.id);
                    setMessages(prev => prev.filter(m => m.id !== msg.id));
                } catch (err: any) {
                    alert(err.message);
                }
            }
        }
    }

    const rendered = messages.map((msg) => {
        const isMe = user && msg.sender.id === user.id;

        return (
            <div
                key={msg.id}
                className="msg-wrapper"
                onClick={(e) => handleDeleteMessage(e, msg)}
                style={{ cursor: isMe ? 'pointer' : 'default' }}
                title={isMe ? 'Shift+Click to delete' : ''}
            >
                <div className={`msg-group ${isMe ? 'msg-group-sent' : 'msg-group-received'}`}>
                    <div className="msg-avatar-col">
                        <Avatar
                            name={msg.sender.username}
                            color={msg.sender.avatarColor}
                            src={msg.sender.avatarUrl}
                            size={isMe ? 'sm' : 'md'}
                        />
                    </div>
                    <div className="msg-content-col">
                        <div className="msg-header">
                            <span className="msg-author" style={{ color: isMe ? '#fff' : msg.sender.avatarColor }}>
                                {msg.sender.username}
                            </span>
                            <span className="msg-time">{formatTime(msg.createdAt)}</span>
                        </div>
                        <div className="msg-text">{msg.content}</div>
                    </div>
                </div>
            </div>
        );
    });

    return (
        <div className="chat-panel">
            <div className="messages-area">
                {messages.length === 0 && (
                    <div className="empty-state" style={{ flex: 1 }}>
                        <div className="empty-icon">
                            <Avatar name={friend.username} color={friend.avatarColor} size="lg" />
                        </div>
                        <p>
                            This is the beginning of your history with <strong>{friend.username}</strong>.
                        </p>
                    </div>
                )}
                {rendered}
                <div ref={bottomRef} />
            </div>

            <div className="chat-input-area">
                <div className="chat-input-wrapper">
                    <textarea
                        ref={textareaRef}
                        className="chat-input"
                        value={input}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        placeholder={`Message @${friend.username}`}
                        rows={1}
                        autoFocus
                    />
                    <button
                        className="send-btn"
                        onClick={handleSend}
                        disabled={!input.trim() || sending}
                        title="Send message (Enter)"
                    >
                        ↑
                    </button>
                </div>
            </div>
        </div>
    );
}
