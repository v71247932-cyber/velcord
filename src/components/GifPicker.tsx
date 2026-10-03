import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { addRow, dropRow, useGifs } from '../gifStore';
import { CloseIcon, PlusIcon } from './Icons';

const BASE = import.meta.env.VITE_API_URL || '';
const MAX_BYTES = 8 * 1024 * 1024;

/** The person's own GIF list: upload files into it, click one to send it. */
/** `onPick` gets the text of the message to send: [gif:id] for a stored GIF, the address for a link GIF. */
export default function GifPicker({ onPick, onClose }: { onPick: (content: string) => void; onClose: () => void }) {
    const { gifs, max, loaded } = useGifs();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const box = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

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
                addRow(added);
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
        try { await api.removeGif(id); dropRow(id); }
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
                {!loaded && <div className="gif-empty">Loading…</div>}
                {loaded && gifs.length === 0 && (
                    <div className="gif-empty">
                        <strong>No GIFs yet</strong>
                        <span>Upload a .gif file and it stays here, ready to send in one click.</span>
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
