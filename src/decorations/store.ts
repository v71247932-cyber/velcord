import { useSyncExternalStore } from 'react';
import { api } from '../api';
import catalog from './catalog.json';

export interface Deco { id: string; name: string; theme: string; tags: string[] }
export const DECOS = catalog as Deco[];
export const DECO_BY_ID = new Map(DECOS.map(d => [d.id, d]));

// username (lower case) -> decoration id, for everybody who wears one
let byName: Record<string, string> = {};
const listeners = new Set<() => void>();
function emit() { listeners.forEach(l => l()); }

export async function refreshDecorations() {
    try {
        const r = await api.getDecorations();
        byName = r.byName || {};
        emit();
    } catch { /* noop */ }
}

/** after the user equips something, show it at once without waiting for the next refresh */
export function setLocalDecoration(username: string, id: string | null) {
    byName = { ...byName };
    if (id) byName[username.toLowerCase()] = id; else delete byName[username.toLowerCase()];
    emit();
}

let timer: number | undefined;
export function startDecorationSync() {
    if (timer !== undefined) return;
    refreshDecorations();
    timer = window.setInterval(refreshDecorations, 60000);
}
export function stopDecorationSync() {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    byName = {};
    emit();
}

function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function useDecorationOf(name: string | undefined): string | null {
    return useSyncExternalStore(subscribe, () => (name ? byName[name.toLowerCase()] || null : null));
}

// the drawings are big, so they are loaded only when somebody actually wears one (or the shop opens)
let svgsPromise: Promise<Record<string, string>> | null = null;
export function loadSvgs(): Promise<Record<string, string>> {
    if (!svgsPromise) svgsPromise = import('./svgs.json').then(m => (m.default || m) as Record<string, string>);
    return svgsPromise;
}
