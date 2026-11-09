import type { CSSProperties } from 'react';

/** Ready-made conversation backgrounds. All are dark enough for the white message text. */
export const CHAT_BG_PRESETS: { id: string; name: string; css: string }[] = [
    { id: 'night', name: 'Night', css: 'linear-gradient(160deg, #1b1f4b 0%, #0e1030 60%, #07081c 100%)' },
    { id: 'sunset', name: 'Sunset', css: 'linear-gradient(160deg, #4a1d4f 0%, #7a2b3d 55%, #8f4a2a 100%)' },
    { id: 'forest', name: 'Forest', css: 'linear-gradient(160deg, #0f3b2e 0%, #134a36 55%, #0a2a22 100%)' },
    { id: 'ocean', name: 'Ocean', css: 'linear-gradient(160deg, #0b3a5c 0%, #0a5a73 55%, #08283f 100%)' },
    { id: 'graphite', name: 'Graphite', css: 'radial-gradient(rgba(255,255,255,.07) 1.5px, transparent 1.5px) 0 0 / 22px 22px, #1c1d21' },
    { id: 'aurora', name: 'Aurora', css: 'radial-gradient(ellipse at 20% 10%, rgba(88,101,242,.55), transparent 55%), radial-gradient(ellipse at 85% 85%, rgba(46,204,113,.35), transparent 55%), #0d1117' },
];

/** Inline style for the chat panel: preset, picture (slightly dimmed so text stays readable), or nothing. */
export function chatBgStyle(bg: string | null | undefined): CSSProperties | undefined {
    if (!bg) return undefined;
    if (bg.startsWith('preset:')) {
        const p = CHAT_BG_PRESETS.find(x => x.id === bg.slice(7));
        return p ? { background: p.css } : undefined;
    }
    if (bg.startsWith('data:image/')) {
        return { background: `linear-gradient(rgba(0,0,0,.4), rgba(0,0,0,.4)), center / cover no-repeat url("${bg}")` };
    }
    return undefined;
}

/** Shrinks a chosen picture to at most 1600 px as JPEG so it fits in the account (about 200-400 KB). */
export function shrinkToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const k = Math.min(1, 1600 / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * k);
            c.height = Math.round(img.height * k);
            c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            let q = 0.8;
            let out = c.toDataURL('image/jpeg', q);
            while (out.length > 650000 && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
            resolve(out);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this picture')); };
        img.src = url;
    });
}
