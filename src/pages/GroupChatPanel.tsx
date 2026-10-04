import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import type { Message, Group } from '../api';
import { useAuth } from '../AuthContext';
import Avatar from '../components/Avatar';
import VerifiedBadge from '../components/VerifiedBadge';
import { MessageContent } from '../components/MessageContent';
import { useAttach, useDropZone } from '../useAttach';
import { useChat } from '../useChat';
import { useStickToBottom } from '../useStickToBottom';
import GifPicker from '../components/GifPicker';
import { FOCUS_CHAT } from '../focusChat';
import { isMobileDevice } from '../notify';
import { TypingLine, useTypingNames, useTypingPing } from '../typing';

interface GroupChatPanelProps {
    group: Group;
    /** the text channel being shown */
    channel: { id: number; name: string };
}

function formatTime(ts: number): string {
    const d = new Date(ts * 1000);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today at ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

export default function GroupChatPanel({ group, channel }: GroupChatPanelProps) {
    const { user } = useAuth();
    const [input, setInput] = useState('');
    const [sending] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [gifOpen, setGifOpen] = useState(false);
    useEffect(() => {
        const focus = () => textareaRef.current?.focus();
        window.addEventListener(FOCUS_CHAT, focus);
        return () => window.removeEventListener(FOCUS_CHAT, focus);
    }, []);
    const typingNames = useTypingNames('group', group.id);
    const pingTyping = useTypingPing('group', group.id);

    const { messages, setMessages, send } = useChat({
        key: `group-${group.id}-${channel.id}`,
        me: user!,
        fetchMessages: (afterId) => api.getGroupMessages(group.id, afterId, channel.id),
        sendMessage: (content) => api.sendGroupMessage(group.id, content, channel.id),
    });

        const { areaRef, onScroll, unseen, jumpToNewest } = useStickToBottom(messages, user?.id, `group-${group.id}-${channel.id}`);

    async function handleSend() {
        const content = input.trim();
        if (!content) return;
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
    const { dragging, zoneProps } = useDropZone(sendImage, true);

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
                    await api.deleteGroupMessage(msg.id);
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
                            userId={isMe ? undefined : msg.sender.id}
                            name={msg.sender.username}
                            color={msg.sender.avatarColor}
                            src={msg.sender.avatarUrl}
                            size={isMe ? 'sm' : 'md'}
                        />
                    </div>
                    <div className="msg-content-col">
                        <div className="msg-header">
                            <span className="msg-author" style={{ color: isMe ? '#fff' : msg.sender.avatarColor }}>
                                {msg.sender.username}{(msg.sender.verified || msg.sender.tick) && <VerifiedBadge size={14} />}
                            </span>
                            <span className="msg-time">{formatTime(msg.createdAt)}</span>
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
            <div className="messages-area" ref={areaRef} onScroll={onScroll}>
                {messages.length === 0 && (
                    <div className="empty-state" style={{ flex: 1 }}>
                        <div className="empty-icon">
                            <Avatar name={group.name} color="#5865f2" src={group.avatarUrl ?? undefined} size="xl" />
                        </div>
                        <p>
                            This is the beginning of <strong>#{channel.name}</strong> in {group.name}.
                        </p>
                    </div>
                )}
                {rendered}
            </div>

            {unseen > 0 && (
                <button type="button" className="jump-new" onClick={jumpToNewest}>
                    ↓ {unseen} new message{unseen === 1 ? '' : 's'}
                </button>
            )}

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

            <div className="chat-input-area">
                {gifOpen && (
                    <GifPicker
                        onClose={() => setGifOpen(false)}
                        onPick={content => { setGifOpen(false); send(content).catch((e: any) => alert(e.message || 'Could not send the GIF')); }}
                    />
                )}
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
                        placeholder={`Message #${channel.name}`}
                        rows={1}
                        autoFocus={!isMobileDevice()}
                    />
                    <button type="button" className={`gif-btn ${gifOpen ? 'on' : ''}`} onClick={() => setGifOpen(o => !o)} title="GIFs" aria-label="GIFs">
                        <span>GIF</span>
                    </button>
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
