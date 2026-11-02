// Web Push: lets the server send a notification to this phone or computer even when Velcord is closed.
// On iPhone it only works from the app added to the Home Screen (iOS 16.4 or newer), and the permission
// can only be asked after a tap.
import { api } from './api';

export type PushState = 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied';

const isIPhone = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;

export function pushState(): PushState {
    if ((window as any).velcordDesktop?.isDesktop) return 'unsupported'; // the desktop app has its own notifications
    const ok = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
    if (!ok) return isIPhone() && !isStandalone() ? 'needs-install' : 'unsupported';
    return Notification.permission as PushState;
}

function keyToBytes(b64: string): Uint8Array {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function subscribe(): Promise<boolean> {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = (await (await fetch('/api/push/key')).json()) as { key: string };
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) as BufferSource });
    const json = sub.toJSON();
    await api.pushSubscribe({ endpoint: json.endpoint!, keys: json.keys as { p256dh: string; auth: string } });
    return true;
}

/** Called from a tap: asks for the permission, then signs this device up. */
export async function enablePush(): Promise<PushState> {
    const state = pushState();
    if (state !== 'default' && state !== 'granted') return state;
    const perm = await Notification.requestPermission();
    if (perm === 'granted') await subscribe();
    return pushState();
}

/** On every start: if the permission was already given, make sure the server still knows this device. */
export async function refreshPush() {
    try { if (pushState() === 'granted') await subscribe(); } catch { /* try again next time */ }
}
