import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { addRow, dropRow, useGifs } from '../gifStore';
import { CloseIcon, PlusIcon } from './Icons';

const BASE = import.meta.env.VITE_API_URL || '';

/** The person's own GIF list: paste a GIF link to save it, click one to send it. */
/** `onPick` gets the text of the message to send: [gif:id] for a stored GIF, the address for a link GIF. */
export default function GifPicker({ onPick, onClose }: { onPick: (content: string) => void; onClose: () => void }) {
    const { gifs, max, loaded } = useGifs();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const box = useRef<HTMLDivElement>(null);
    const [link, setLink] = useState('');

    // Close on Escape or a click anywhere outside (the GIF button toggles it by itself)
    useEffect(() => {
        const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        const down = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            if (box.current && !box.current.contains(t) && !t.closest('.gif-btn')) onClose();
        };
        document.addEventListener('keydown', key, true);
        document.addEventListener('mousedown', down);
        return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', down); };
    }, [onClose]);

    async function addLink(e: React.FormEvent) {
        e.preventDefault();
        const text = link.trim();
        if (!text || busy) return;
        setBusy(true);
        setError('');
        try {
            let src = text;
            // A Tenor page is not a picture: ask the server for the real GIF it shows
            try { if (new URL(text).hostname.replace(/^www\./, '') === 'tenor.com') src = (await api.resolveGifLink(text)).src; } catch (err: any) { if (/tenor/i.test(text)) throw err; }
            addRow(await api.saveGif({ url: src }));
            setLink('');
        } catch (err: any) {
            setError(err.message || 'Could not save that link');
        } finally {
            setBusy(false);
        }
    }

    async function remove(e: React.MouseEvent, id: string) {
        e.stopPropagation();
        try { await api.removeGif(id); dropRow(id); }
        catch (err: any) { setError(err.message || 'Could not remove it'); }
    }

    return (
        <div className="gif-picker" ref={box} role="dialog" aria-label="GIFs">
            <div className="gif-head">
                <span className="gif-title">Your GIFs</span>
                <span className="gif-count">{gifs.length}/{max}</span>
            </div>
            <form className="gif-link-form" onSubmit={addLink}>
                <input value={link} onChange={e => setLink(e.target.value)} placeholder="Paste a GIF link (.gif) or a Tenor link" disabled={busy || gifs.length >= max} />
                <button type="submit" className="gif-upload" disabled={busy || !link.trim() || gifs.length >= max}><PlusIcon size={14} /> {busy ? 'Saving…' : 'Add'}</button>
            </form>
            {error && <div className="gif-error">{error}</div>}
            <div className="gif-grid">
                {!loaded && <div className="gif-empty">Loading…</div>}
                {loaded && gifs.length === 0 && (
                    <div className="gif-empty">
                        <strong>No GIFs yet</strong>
                        <span>Paste the link of a GIF and it stays here, ready to send in one click.</span>
                    </div>
                )}
                {gifs.map(g => (
                    <div key={g.id} className="gif-tile" title={g.name} onClick={() => onPick(g.url ? g.url : `[gif:${g.id}]`)}>
                        <img src={g.url ?? `${BASE}/api/gifs/${g.id}/file`} referrerPolicy="no-referrer" alt={g.name} loading="lazy" draggable={false} />
                        <button type="button" className="gif-remove" onClick={e => remove(e, g.id)} aria-label={`Remove ${g.name}`} title="Remove from the list"><CloseIcon size={12} /></button>
                    </div>
                ))}
            </div>
        </div>
    );
}
