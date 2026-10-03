import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';
import type { GifItem } from './api';

// My GIF list, shared by the GIF panel and the stars on GIFs in chats.
interface State { gifs: GifItem[]; max: number; loaded: boolean }
let state: State = { gifs: [], max: 40, loaded: false };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(l => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

let loading: Promise<void> | null = null;
export function loadGifs(): Promise<void> {
    if (!loading) {
        loading = api.getGifs().then(r => set({ gifs: r.gifs, max: r.max, loaded: true })).catch(() => {}).finally(() => { loading = null; });
    }
    return loading;
}

export function useGifs(): State {
    const s = useSyncExternalStore(subscribe, () => state);
    useEffect(() => { if (!s.loaded) loadGifs(); }, [s.loaded]);
    return s;
}

export const addRow = (g: GifItem) => set({ gifs: [g, ...state.gifs.filter(x => x.id !== g.id)] });
export const dropRow = (id: string) => set({ gifs: state.gifs.filter(x => x.id !== id) });

// A GIF sent from someone's list can be a copy; the origin says which original it is.
const origins = new Map<string, string | null>();
const locked = new Set<string>(); // GIFs whose owner does not allow copying them
/** True when this GIF is protected by its owner (and is not already in my list). */
export const isProtected = (id: string) => locked.has(id);
const wanted = new Set<string>();
let asking = false;
export function ensureOrigin(id: string) {
    if (origins.has(id) || wanted.has(id)) return;
    wanted.add(id);
    if (asking) return;
    asking = true;
    queueMicrotask(async () => { // one request for every star drawn in the same moment
        const ids = Array.from(wanted).slice(0, 50);
        ids.forEach(i => wanted.delete(i));
        asking = false;
        try {
            const r = await api.gifOrigins(ids);
            for (const i of ids) origins.set(i, typeof r[i] === 'string' ? r[i] : null);
            for (const i of (Array.isArray(r.__protected) ? r.__protected : []) as string[]) locked.add(i);
        }
        catch { for (const i of ids) origins.set(i, null); }
        set({}); // redraw the stars
        if (wanted.size) { const more = Array.from(wanted); wanted.clear(); more.forEach(ensureOrigin); }
    });
}

export type StarTarget = { file: string } | { url: string };

/** The row in my list that stands for this GIF, if any. */
export function findRow(t: StarTarget): GifItem | undefined {
    if ('url' in t) return state.gifs.find(g => g.url === t.url);
    const origin = origins.get(t.file) ?? t.file;
    return state.gifs.find(g => !g.url && ((g.origin ?? g.id) === origin || g.id === t.file));
}

/** Adds the GIF to my list, or takes it out again when it is already there. Returns the new starred state. */
export async function toggleStar(t: StarTarget): Promise<boolean> {
    const existing = findRow(t);
    if (existing) {
        await api.removeGif(existing.id);
        dropRow(existing.id);
        return false;
    }
    const saved = await api.saveGif('url' in t ? { url: t.url } : { gifId: t.file });
    if ('file' in t) origins.set(t.file, saved.origin ?? saved.id);
    addRow(saved);
    return true;
}
