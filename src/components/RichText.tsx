import { useEffect, useRef, useState } from 'react';
import { isMobileDevice } from '../notify';
import { api } from '../api';
import GifStar from './GifStar';

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

// ---------------------------------------------------------------- GIFs behind links
type GifSource =
    | { kind: 'img'; src: string }
    | { kind: 'video'; src: string }   // imgur .gifv is really a looping muted mp4
    | { kind: 'tenor'; link: string }; // a page: the real GIF is looked up on the server

/** Which links hold a GIF: direct files, Giphy pages, Imgur .gifv and Tenor pages. Everything else is null. */
export function parseGif(link: string): GifSource | null {
    let u: URL;
    try { u = new URL(link); } catch { return null; }
    if (u.protocol !== 'https:') return null; // plain http would be blocked as mixed content anyway
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname;
    if (host === 'tenor.com' && /^\/view\/[a-z0-9-]+-\d{6,25}$/i.test(path)) return { kind: 'tenor', link: `https://tenor.com${path}` };
    if (host === 'giphy.com') {
        const m = /^\/gifs\/(?:[^/]*-)?([A-Za-z0-9]{8,})$/.exec(path);
        if (m) return { kind: 'img', src: `https://media.giphy.com/media/${m[1]}/giphy.gif` };
    }
    if (host === 'imgur.com' || host === 'i.imgur.com') {
        const m = /^\/([A-Za-z0-9]{5,10})\.gifv$/.exec(path);
        if (m) return { kind: 'video', src: `https://i.imgur.com/${m[1]}.mp4` };
    }
    if (/\.(gif|webp|apng)$/i.test(path)) return { kind: 'img', src: link };
    return null;
}

const tenorCache = new Map<string, Promise<string | null>>();
function resolveTenor(link: string): Promise<string | null> {
    let p = tenorCache.get(link);
    if (!p) { p = api.resolveGifLink(link).then(r => r.src).catch(() => null); tenorCache.set(link, p); }
    return p;
}

/** A GIF shown in the message. Clicking it opens the original link. If it cannot load, nothing is shown. */
export function GifEmbed({ source, link }: { source: GifSource; link: string }) {
    const [src, setSrc] = useState<string | null>(source.kind === 'tenor' ? null : source.src);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        if (source.kind !== 'tenor') return;
        let alive = true;
        resolveTenor(source.link).then(s => { if (!alive) return; if (s) setSrc(s); else setFailed(true); });
        return () => { alive = false; };
    }, [source]);
    if (failed || !src) return null;
    return (
        <div className="gif-wrap">
            <a className="gif-embed" href={link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                {source.kind === 'video'
                    ? <video className="msg-gif" src={src} autoPlay loop muted playsInline onError={() => setFailed(true)} />
                    : <img className="msg-gif" src={src} alt="GIF" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
            </a>
            {source.kind !== 'video' && /\.(gif|webp|apng)(\?|$)/i.test(src) && <GifStar target={{ url: src }} />}
        </div>
    );
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

    // One player or GIF per message: the first link that has one
    let firstYouTube: { id: string; start: number } | null = null;
    let firstGif: { source: GifSource; link: string } | null = null;
    for (const p of parts) {
        if (typeof p === 'string') continue;
        const yt = parseYouTube(p.href);
        if (yt) { firstYouTube = yt; break; }
        const gif = parseGif(p.href);
        if (gif) { firstGif = { source: gif, link: p.href }; break; }
    }

    // A message that is nothing but a GIF link shows just the GIF
    const onlyLink = parts.filter(p => typeof p !== 'string' || p.trim() !== '').length === 1 && parts.some(p => typeof p !== 'string');
    const hideText = onlyLink && !!firstGif;

    return (
        <>
            {!hideText && <div className="msg-text">
                {parts.map((p, i) => typeof p === 'string'
                    ? p
                    : <a key={i} className="msg-link" href={p.href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{p.href}</a>)}
            </div>}
            {firstYouTube && <YouTubeCard id={firstYouTube.id} start={firstYouTube.start} />}
            {firstGif && <GifEmbed source={firstGif.source} link={firstGif.link} />}
        </>
    );
}
