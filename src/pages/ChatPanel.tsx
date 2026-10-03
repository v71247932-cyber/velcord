import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import type { Message, FriendUser } from '../api';
import { useAuth } from '../AuthContext';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/VerifiedBadge';
import { MessageContent, Ticks } from '../components/MessageContent';
import { useAttach, useDropZone } from '../useAttach';
import { useChat } from '../useChat';
import { FOCUS_CHAT } from '../focusChat';
import { isMobileDevice } from '../notify';
import { TypingLine, useTypingNames, useTypingPing } from '../typing';

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
    const [input, setInput] = useState('');
    const [sending] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const prevCount = useRef(0);
    useEffect(() => {
        const focus = () => textareaRef.current?.focus();
        window.addEventListener(FOCUS_CHAT, focus);
        return () => window.removeEventListener(FOCUS_CHAT, focus);
    }, []);
    const typingNames = useTypingNames('dm', friend.id);
    const pingTyping = useTypingPing('dm', friend.id);

    const { messages, setMessages, send } = useChat({
        key: `dm-${friend.id}`,
        me: user!,
        // Tell the server the chat is being looked at, so the sender gets blue ticks
        fetchMessages: (afterId) => api.getMessages(friend.id, afterId, document.visibilityState === 'visible' && document.hasFocus()),
        sendMessage: (content) => api.sendMessage(friend.id, content),
        fetchStatuses: () => api.getMessageStatus(friend.id),
    });

    // Jump straight to the bottom on the first load, scroll smoothly for single new messages
    useEffect(() => {
        const jump = prevCount.current === 0 || messages.length - prevCount.current > 1;
        bottomRef.current?.scrollIntoView({ behavior: jump ? 'auto' : 'smooth' });
        prevCount.current = messages.length;
    }, [messages]);
    useEffect(() => { prevCount.current = 0; }, [friend.id]);

    async function handleSend() {
        const content = input.trim();
        if (!content || sending) return;
        setInput('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        try {
            await send(content);
        } catch (err: any) {
            setInput(content);
            alert(err.message || 'Message not sent');
        }
        textareaRef.current?.focus();
    }

    const { uploading, progress, label, attach: sendImage, cancel: cancelUpload } = useAttach(send);
    const { dragging, zoneProps } = useDropZone(sendImage, !friend.verified);

    function handlePaste(e: React.ClipboardEvent) {
        const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
        if (file) {
            e.preventDefault();
            sendImage(file);
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
        if (e.target.value.trim()) pingTyping();
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
    }

    async function handleDeleteMessage(e: React.MouseEvent, msg: Message) {
        if (e.shiftKey) {
            e.stopPropagation();
            if (msg.pending || msg.sender.id !== user?.id) return; // Only delete own messages

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
                            zoomable
                            name={msg.sender.username}
                            color={msg.sender.avatarColor}
                            src={msg.sender.avatarUrl}
                            size={isMe ? 'sm' : 'md'}
                        />
                    </div>
                    <div className="msg-content-col">
                        <div className="msg-header">
                            <span className="msg-author" style={{ color: isMe ? '#fff' : msg.sender.avatarColor }}>
                                {msg.sender.username}{msg.sender.verified && <VerifiedBadge size={14} />}
                            </span>
                            <span className="msg-time">{formatTime(msg.createdAt)}</span>
                            {isMe && <Ticks msg={msg} />}
                        </div>
                        <MessageContent content={msg.content} sender={msg.sender} createdAt={msg.createdAt} />
                    </div>
                </div>
            </div>
        );
    });

    return (
        <div className="chat-panel" {...zoneProps}>
            {dragging && <div className="drop-overlay">Drop pictures or videos to send them</div>}
            <div className="messages-area">
                {messages.length === 0 && (
                    <div className="empty-state" style={{ flex: 1 }}>
                        <div className="empty-icon">
                            <Avatar name={friend.username} color={friend.avatarColor} src={friend.avatarUrl} size="xl" />
                        </div>
                        <p>
                            This is the beginning of your history with <strong>{friend.username}</strong>.
                        </p>
                    </div>
                )}
                {rendered}
                <div ref={bottomRef} />
            </div>

            <TypingLine names={typingNames} />

            {uploading && progress !== null && (
                <div className="upload-bar">
                    <div className="upload-bar-top">
                        <span className="upload-bar-name">Uploading {label}</span>
                        <span>{Math.round(progress * 100)}%</span>
                        <button type="button" onClick={cancelUpload}>Cancel</button>
                    </div>
                    <div className="upload-bar-track"><div className="upload-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                </div>
            )}

            {friend.verified ? (
                <div className="official-note">This is an official Velcord account. You can read its messages but not reply.</div>
            ) : (
            <div className="chat-input-area">
                <div className="chat-input-wrapper">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,video/mp4,video/quicktime,video/webm,video/x-m4v,video/ogg,.mp4,.mov,.m4v,.webm"
                        hidden
                        onChange={e => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (f) sendImage(f);
                        }}
                    />
                    <button
                        className="attach-btn"
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading}
                        title="Send a picture (kept 2 days) or a video up to 200 MB (kept 1 day)"
                        type="button"
                    >
                        {uploading ? '…' : '+'}
                    </button>
                    <textarea
                        ref={textareaRef}
                        className="chat-input"
                        value={input}
                        onChange={handleInput}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        placeholder={`Message @${friend.username}`}
                        rows={1}
                        autoFocus={!isMobileDevice()}
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
            )}
        </div>
    );
}
