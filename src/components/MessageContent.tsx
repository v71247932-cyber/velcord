import { useEffect, useRef, useState } from 'react';
import { IMAGE_TOKEN, VIDEO_TOKEN, GIF_TOKEN } from '../uploads';
import type { Message, User } from '../api';
import { CloseIcon, ImageIcon } from './Icons';
import Avatar from './Avatar';
import RichText from './RichText';

const BASE = import.meta.env.VITE_API_URL || '';

function formatWhen(ts: number): string {
    const d = new Date(ts * 1000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
        ? `Today at ${time}`
        : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

/** Full-screen picture viewer: dark backdrop, sender on the left, buttons on the right. */
function ImageViewer({ src, from, sender, createdAt, onClose }: { src: string; from: DOMRect | null; sender?: User; createdAt?: number; onClose: () => void }) {
    const [zoomed, setZoomed] = useState(false);
    const [ready, setReady] = useState(false);
    const [flew, setFlew] = useState(false);
    const [closing, setClosing] = useState(false);
    const imgRef = useRef<HTMLImageElement>(null);
    const played = useRef(false);
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Transform that makes the big picture sit exactly on top of the small one in the chat
    const fromThumb = (el: HTMLImageElement): string | null => {
        if (!from || reduce) return null;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        const dx = from.left + from.width / 2 - (r.left + r.width / 2);
        const dy = from.top + from.height / 2 - (r.top + r.height / 2);
        return `translate(${dx}px, ${dy}px) scale(${from.width / r.width}, ${from.height / r.height})`;
    };

    // Opening: start on the thumbnail, then glide to the full size
    const begin = () => {
        if (played.current) return;
        played.current = true;
        const el = imgRef.current;
        const t = el ? fromThumb(el) : null;
        if (!el || !t) { setReady(true); return; }
        el.style.transition = 'none';
        el.style.transform = t;
        el.style.opacity = '1';
        void el.offsetWidth; // apply the start position before animating
        el.style.transition = 'transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)';
        el.style.transform = 'none';
        setFlew(true);
        setReady(true);
        setTimeout(() => { el.style.transition = ''; el.style.transform = ''; }, 340);
    };

    useEffect(() => {
        const el = imgRef.current;
        if (el && el.complete && el.naturalWidth) begin();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Closing: glide back onto the thumbnail while the backdrop fades
    const close = () => {
        if (closing) return;
        const el = imgRef.current;
        const t = el && !zoomed ? fromThumb(el) : null;
        setClosing(true);
        if (el && t) {
            el.style.transition = 'transform 0.26s cubic-bezier(0.4, 0, 0.2, 1)';
            el.style.transform = t;
        }
        setTimeout(onClose, reduce ? 0 : 260);
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closing, zoomed]);

    return (
        <div className={`viewer ${closing ? 'closing' : ''}`} onClick={close}>
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
                    <button className="viewer-close" onClick={close} title="Close (Esc)" aria-label="Close"><CloseIcon size={20} /></button>
                </div>
            </div>
            <div className={`viewer-stage ${zoomed ? 'zoomed' : ''}`} onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) close(); }}>
                <img ref={imgRef} src={src} alt="attachment" className={`viewer-img ${ready ? (flew ? 'ready' : 'ready pop') : ''}`} onLoad={begin} onClick={e => { e.stopPropagation(); setZoomed(z => !z); }} />
            </div>
        </div>
    );
}

export function MessageContent({ content, sender, createdAt }: { content: string; sender?: User; createdAt?: number }) {
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState(false);
    const [fromRect, setFromRect] = useState<DOMRect | null>(null);
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
    const g = GIF_TOKEN.exec(content);
    if (g) {
        const gsrc = `${BASE}/api/gifs/${g[1]}/file`;
        if (failed) return <div className="msg-expired"><ImageIcon size={15} /> This GIF was removed</div>;
        return (
            <>
                <img className="msg-gif" src={gsrc} alt="GIF" loading="lazy" onError={() => setFailed(true)}
                    style={open ? { visibility: 'hidden' } : undefined}
                    onClick={e => { e.stopPropagation(); setFromRect(e.currentTarget.getBoundingClientRect()); setOpen(true); }} />
                {open && <ImageViewer src={gsrc} from={fromRect} sender={sender} createdAt={createdAt} onClose={() => setOpen(false)} />}
            </>
        );
    }
    const m = IMAGE_TOKEN.exec(content);
    if (!m) return <RichText content={content} />;
    const src = `${BASE}/api/uploads/${m[1]}`;
    if (failed) return <div className="msg-expired"><ImageIcon size={15} /> Image expired (deleted after 2 days)</div>;
    return (
        <>
            <img className="msg-image" src={src} alt="attachment" loading="lazy" onError={() => setFailed(true)}
                style={open ? { visibility: 'hidden' } : undefined}
                onClick={e => { e.stopPropagation(); setFromRect(e.currentTarget.getBoundingClientRect()); setOpen(true); }} />
            {open && <ImageViewer src={src} from={fromRect} sender={sender} createdAt={createdAt} onClose={() => setOpen(false)} />}
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
