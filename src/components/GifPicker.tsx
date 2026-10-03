import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { GifItem } from '../api';
import { CloseIcon, PlusIcon } from './Icons';

const BASE = import.meta.env.VITE_API_URL || '';
const MAX_BYTES = 8 * 1024 * 1024;

/** The person's own GIF list: upload files into it, click one to send it. */
export default function GifPicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
    const [gifs, setGifs] = useState<GifItem[]>([]);
    const [max, setMax] = useState(40);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const box = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        api.getGifs().then(r => { setGifs(r.gifs); setMax(r.max); }).catch(e => setError(e.message)).finally(() => setLoading(false));
    }, []);

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

    async function upload(files: FileList | null) {
        if (!files || files.length === 0) return;
        setBusy(true);
        setError('');
        try {
            for (const f of Array.from(files)) {
                if (!/\.(gif|webp|png)$/i.test(f.name) && !/^image\/(gif|webp|png)$/.test(f.type)) { setError('Use a .gif, .webp or .png file.'); continue; }
                if (f.size > MAX_BYTES) { setError(`"${f.name}" is too big. The limit is 8 MB.`); continue; }
                const added = await api.uploadGif(f);
                setGifs(g => [added, ...g]);
            }
        } catch (e: any) {
            setError(e.message || 'Upload failed');
        } finally {
            setBusy(false);
            if (fileRef.current) fileRef.current.value = '';
        }
    }

    async function remove(e: React.MouseEvent, id: string) {
        e.stopPropagation();
        try { await api.removeGif(id); setGifs(g => g.filter(x => x.id !== id)); }
        catch (err: any) { setError(err.message || 'Could not remove it'); }
    }

    return (
        <div className="gif-picker" ref={box} role="dialog" aria-label="GIFs">
            <div className="gif-head">
                <span className="gif-title">Your GIFs</span>
                <span className="gif-count">{gifs.length}/{max}</span>
                <button type="button" className="gif-upload" onClick={() => fileRef.current?.click()} disabled={busy || gifs.length >= max}>
                    <PlusIcon size={14} /> {busy ? 'Uploading…' : 'Upload'}
                </button>
                <input ref={fileRef} type="file" accept="image/gif,image/webp,image/png,.gif,.webp,.png" multiple hidden onChange={e => upload(e.target.files)} />
            </div>
            {error && <div className="gif-error">{error}</div>}
            <div className="gif-grid">
                {loading && <div className="gif-empty">Loading…</div>}
                {!loading && gifs.length === 0 && (
                    <div className="gif-empty">
                        <strong>No GIFs yet</strong>
                        <span>Upload a .gif file and it stays here, ready to send in one click.</span>
                    </div>
                )}
                {gifs.map(g => (
                    <div key={g.id} className="gif-tile" title={g.name} onClick={() => onPick(g.id)}>
                        <img src={`${BASE}/api/gifs/${g.id}/file`} alt={g.name} loading="lazy" draggable={false} />
                        <button type="button" className="gif-remove" onClick={e => remove(e, g.id)} aria-label={`Remove ${g.name}`} title="Remove from the list"><CloseIcon size={12} /></button>
                    </div>
                ))}
            </div>
        </div>
    );
}
