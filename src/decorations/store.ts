import { useSyncExternalStore } from 'react';
import { api } from '../api';
import catalog from './catalog.json';
import effectsCatalog from './effects-catalog.json';
import platesCatalog from './plates-catalog.json';
import combosCatalog from './combos.json';

export interface Deco { id: string; name: string; theme: string; tags: string[] }
export const DECOS = catalog as Deco[];
export const DECO_BY_ID = new Map(DECOS.map(d => [d.id, d]));
export const EFFECTS = effectsCatalog as Deco[];
export const PLATES = platesCatalog as Deco[];
export type ItemKind = 'deco' | 'effect' | 'plate' | 'combo';
/** a ready-made set: one avatar decoration, one nameplate and one profile effect, picked to go together */
export interface Combo extends Deco { deco: string; plate: string; effect: string }
export const COMBOS = combosCatalog as Combo[];

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

// profile effects and nameplates work the same way
let effectByName: Record<string, string> = {};
let plateByName: Record<string, string> = {};
export async function refreshCosmetics() {
    try {
        const r = await api.getCosmetics();
        effectByName = r.effects || {};
        plateByName = r.plates || {};
        emit();
    } catch { /* noop */ }
}
export function setLocalItem(kind: ItemKind, username: string, id: string | null) {
    if (kind === 'combo') return;
    if (kind === 'deco') { setLocalDecoration(username, id); return; }
    const map = kind === 'effect' ? { ...effectByName } : { ...plateByName };
    if (id) map[username.toLowerCase()] = id; else delete map[username.toLowerCase()];
    if (kind === 'effect') effectByName = map; else plateByName = map;
    emit();
}
export function useEffectOf(name: string | undefined): string | null {
    return useSyncExternalStore(subscribe, () => (name ? effectByName[name.toLowerCase()] || null : null));
}
export function usePlateOf(name: string | undefined): string | null {
    return useSyncExternalStore(subscribe, () => (name ? plateByName[name.toLowerCase()] || null : null));
}

let timer: number | undefined;
export function startDecorationSync() {
    if (timer !== undefined) return;
    refreshDecorations();
    refreshCosmetics();
    timer = window.setInterval(() => { refreshDecorations(); refreshCosmetics(); }, 60000);
}
export function stopDecorationSync() {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    byName = {};
    effectByName = {};
    plateByName = {};
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

let effectSvgs: Promise<Record<string, string>> | null = null;
export function loadEffectSvgs(): Promise<Record<string, string>> {
    if (!effectSvgs) effectSvgs = import('./effects-svgs.json').then(m => (m.default || m) as Record<string, string>);
    return effectSvgs;
}
let plateSvgs: Promise<Record<string, string>> | null = null;
export function loadPlateSvgs(): Promise<Record<string, string>> {
    if (!plateSvgs) plateSvgs = import('./plates-svgs.json').then(m => (m.default || m) as Record<string, string>);
    return plateSvgs;
}
