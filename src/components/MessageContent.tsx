import { useState } from 'react';
import { IMAGE_TOKEN, VIDEO_TOKEN } from '../uploads';
import type { Message } from '../api';
import { ImageIcon } from './Icons';

const BASE = import.meta.env.VITE_API_URL || '';

export function MessageContent({ content }: { content: string }) {
    const [failed, setFailed] = useState(false);
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
        <a href={src} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
            <img className="msg-image" src={src} alt="attachment" loading="lazy" onError={() => setFailed(true)} />
        </a>
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
