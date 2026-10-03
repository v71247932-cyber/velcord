import { useEffect, useState } from 'react';
import { IMAGE_TOKEN, VIDEO_TOKEN } from '../uploads';
import type { Message, User } from '../api';
import { CloseIcon, ImageIcon } from './Icons';
import Avatar from './Avatar';

const BASE = import.meta.env.VITE_API_URL || '';

function formatWhen(ts: number): string {
    const d = new Date(ts * 1000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
        ? `Today at ${time}`
        : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

/** Full-screen picture viewer: dark backdrop, sender on the left, buttons on the right. */
function ImageViewer({ src, sender, createdAt, onClose }: { src: string; sender?: User; createdAt?: number; onClose: () => void }) {
    const [zoomed, setZoomed] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="viewer" onClick={onClose}>
            <div className="viewer-top" onClick={e => e.stopPropagation()}>
                {sender && (
                    <div className="viewer-who">
                        <Avatar name={sender.username} color={sender.avatarColor} src={sender.avatarUrl} size="md" />
                        <div>
                            <div className="viewer-name">{sender.username}</div>
                            {createdAt && <div className="viewer-time">{formatWhen(createdAt)}</div>}
                        </div>
                    </div>
                )}
                <div className="viewer-tools">
                    <button onClick={() => setZoomed(z => !z)} title={zoomed ? 'Fit to screen' : 'Zoom in'} aria-label="Zoom">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2M8.5 11h5" />{!zoomed && <path d="M11 8.5v5" />}
                        </svg>
                    </button>
                    <a href={src} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
                        </svg>
                    </a>
                    <button className="viewer-close" onClick={onClose} title="Close (Esc)" aria-label="Close"><CloseIcon size={20} /></button>
                </div>
            </div>
            <div className={`viewer-stage ${zoomed ? 'zoomed' : ''}`} onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
                <img src={src} alt="attachment" className="viewer-img" onClick={e => { e.stopPropagation(); setZoomed(z => !z); }} />
            </div>
        </div>
    );
}

export function MessageContent({ content, sender, createdAt }: { content: string; sender?: User; createdAt?: number }) {
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState(false);
    const v = VIDEO_TOKEN.exec(content);
    if (v) {
        const vsrc = `${BASE}/api/videos/${v[1]}`;
        if (failed) {
            return (
                <div className="msg-expired">
                    <ImageIcon size={15} /> Video unavailable. Clips are deleted after 1 day, and some formats cannot play here.
                    {' '}<a href={vsrc} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Try opening it</a>
                </div>
            );
        }
        return (
            <video className="msg-video" src={vsrc} controls preload="metadata" playsInline
                onClick={e => e.stopPropagation()} onError={() => setFailed(true)} />
        );
    }
    const m = IMAGE_TOKEN.exec(content);
    if (!m) return <div className="msg-text">{content}</div>;
    const src = `${BASE}/api/uploads/${m[1]}`;
    if (failed) return <div className="msg-expired"><ImageIcon size={15} /> Image expired (deleted after 2 days)</div>;
    return (
        <>
            <img className="msg-image" src={src} alt="attachment" loading="lazy" onError={() => setFailed(true)}
                onClick={e => { e.stopPropagation(); setOpen(true); }} />
            {open && <ImageViewer src={src} sender={sender} createdAt={createdAt} onClose={() => setOpen(false)} />}
        </>
    );
}

/** One grey tick = sent, two grey = delivered, two blue = seen. */
export function Ticks({ msg }: { msg: Message }) {
    if (msg.pending) {
        return (
            <span className="ticks ticks-pending" title="Sending" aria-label="Sending">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            </span>
        );
    }
    const seen = !!msg.readAt;
    const delivered = !!msg.deliveredAt || seen;
    const label = seen ? 'Seen' : delivered ? 'Delivered' : 'Sent';
    return (
        <span className={`ticks ${seen ? 'ticks-seen' : ''}`} title={label} aria-label={label}>
            <svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 6.5 4.5 10 11 2" />
                {delivered && <path d="M7 9.5 7.5 10 14 2" />}
            </svg>
        </span>
    );
}
