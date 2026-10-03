import { useEffect, useState } from 'react';
import { ensureOrigin, findRow, toggleStar, useGifs } from '../gifStore';
import type { StarTarget } from '../gifStore';

/** Star in the corner of a GIF: yellow when it is in my list; click to add it or take it out. */
export default function GifStar({ target }: { target: StarTarget }) {
    useGifs(); // loads my list and redraws this star when it changes
    const [busy, setBusy] = useState(false);
    const key = 'file' in target ? target.file : target.url;
    useEffect(() => { if ('file' in target) ensureOrigin(target.file); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
    const starred = !!findRow(target);

    return (
        <button
            type="button"
            className={`gif-star ${starred ? 'on' : ''}`}
            title={starred ? 'Remove from your GIFs' : 'Add to your GIFs'}
            aria-label={starred ? 'Remove from your GIFs' : 'Add to your GIFs'}
            aria-pressed={starred}
            disabled={busy}
            onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                setBusy(true);
                toggleStar(target).catch((err: any) => alert(err.message || 'Could not change your GIFs')).finally(() => setBusy(false));
            }}
        >
            <svg width="17" height="17" viewBox="0 0 24 24" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
                <path d="m12 3.2 2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6-4.4-4.3 6.1-.9L12 3.2Z" />
            </svg>
        </button>
    );
}
