import { useEffect, useRef, useState } from 'react';
import { isMobileDevice } from '../notify';

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}'"»]+$/;

/** Start time from ?t=90, ?t=1m30s or ?start=90 (seconds). */
function parseStart(raw: string | null): number {
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
    return m ? (parseInt(m[1] || '0') * 3600 + parseInt(m[2] || '0') * 60 + parseInt(m[3] || '0')) : 0;
}

/** The YouTube video id (11 characters) and start time, or null when the link is not a YouTube video. */
export function parseYouTube(link: string): { id: string; start: number } | null {
    let u: URL;
    try { u = new URL(link); } catch { return null; }
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v');
        else {
            const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
            if (m) id = m[1];
        }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { id, start: parseStart(u.searchParams.get('t') || u.searchParams.get('start')) };
}

/** A YouTube card: picture first, the real player (with sound) after one click. */
export function YouTubeCard({ id, start }: { id: string; start: number }) {
    const [playing, setPlaying] = useState(false);
    const [stillMuted, setStillMuted] = useState(false);
    const frame = useRef<HTMLIFrameElement>(null);
    // On a phone a tap on our picture does not count as a tap inside the player, so the player would
    // start with the sound off. There the player opens ready and its own play button starts it with sound.
    const autoplay = !isMobileDevice();
    const src = `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
        + `${autoplay ? '&autoplay=1' : ''}${start ? `&start=${start}` : ''}`;

    // Talk to the player: if it reports that it is muted, turn the sound on
    useEffect(() => {
        if (!playing) return;
        const f = frame.current;
        if (!f) return;
        let asked = 0;
        const send = (o: object) => f.contentWindow?.postMessage(JSON.stringify(o), '*');
        const unmute = () => { send({ event: 'command', func: 'unMute', args: [] }); send({ event: 'command', func: 'setVolume', args: [100] }); };
        const onMessage = (e: MessageEvent) => {
            if (e.source !== f.contentWindow || typeof e.data !== 'string') return;
            let d: any;
            try { d = JSON.parse(e.data); } catch { return; }
            const muted = d?.info?.muted;
            if (d?.event === 'infoDelivery' && typeof muted === 'boolean') {
                if (muted && asked < 3) { asked++; unmute(); }
                setStillMuted(muted && asked >= 3);
            }
        };
        const hello = () => {
            send({ event: 'listening', id: 1, channel: 'widget' });
            for (const n of ['onReady', 'onStateChange']) send({ event: 'command', func: 'addEventListener', args: [n], id: 1, channel: 'widget' });
        };
        window.addEventListener('message', onMessage);
        f.addEventListener('load', hello);
        return () => { window.removeEventListener('message', onMessage); f.removeEventListener('load', hello); };
    }, [playing]);

    return (
        <div className="yt-card" onClick={e => e.stopPropagation()}>
            {playing ? (
                <iframe
                    ref={frame}
                    className="yt-frame"
                    src={src}
                    title="YouTube video"
                    allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                />
            ) : (
                <button type="button" className="yt-thumb" onClick={() => setPlaying(true)} aria-label="Play video">
                    <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" />
                    <span className="yt-play">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="#fff"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" /></svg>
                    </span>
                </button>
            )}
            {playing && !autoplay && <div className="yt-hint">Tap play in the video. The sound starts with it.</div>}
            {stillMuted && <div className="yt-hint">Your device keeps the sound off. Tap the speaker icon in the player.</div>}
            <a className="yt-open" href={`https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`} target="_blank" rel="noopener noreferrer">Open on YouTube</a>
        </div>
    );
}

/** Message text with clickable links; YouTube links also get a player under the text. */
export default function RichText({ content }: { content: string }) {
    const parts: (string | { href: string })[] = [];
    let last = 0;
    for (const m of content.matchAll(URL_RE)) {
        const raw = m[0];
        const trimmed = raw.replace(TRAILING, '');
        const start = m.index ?? 0;
        if (start > last) parts.push(content.slice(last, start));
        parts.push({ href: trimmed });
        last = start + trimmed.length;
    }
    if (last < content.length) parts.push(content.slice(last));

    const firstYouTube = parts.map(p => (typeof p === 'string' ? null : parseYouTube(p.href))).find(Boolean) ?? null;

    return (
        <>
            <div className="msg-text">
                {parts.map((p, i) => typeof p === 'string'
                    ? p
                    : <a key={i} className="msg-link" href={p.href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{p.href}</a>)}
            </div>
            {firstYouTube && <YouTubeCard id={firstYouTube.id} start={firstYouTube.start} />}
        </>
    );
}
