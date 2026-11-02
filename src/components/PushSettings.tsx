import { useState } from 'react';
import { api } from '../api';
import { enablePush, pushState } from '../push';
import './pushBanner.css';
import type { PushState } from '../push';

const TEXT: Record<PushState, string> = {
    unsupported: 'This browser cannot get notifications when Velcord is closed.',
    'needs-install': 'On an iPhone, open Velcord from the Home Screen icon first (Share, then Add to Home Screen).',
    default: 'Notifications are off.',
    granted: 'Notifications are on for this device.',
    denied: 'Notifications are blocked. Turn them on in the phone Settings, under Notifications, Velcord.',
};

/** Shows whether this device gets notifications, lets you turn them on, and sends a test one. */
export default function PushSettings() {
    const [state, setState] = useState<PushState>(() => pushState());
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    if (state === 'unsupported') return null;

    async function turnOn() {
        setBusy(true);
        try { setState(await enablePush()); } catch (e: any) { setNote(e?.message || 'Could not turn on.'); }
        setBusy(false);
    }
    async function test() {
        setBusy(true);
        setNote('');
        try {
            const r = await api.pushTest();
            setNote(r.devices > 0 ? `Sent to ${r.devices} device${r.devices === 1 ? '' : 's'}. It should arrive in a few seconds.` : 'This device is not signed up yet. Press Turn on.');
        } catch (e: any) { setNote(e?.message || 'Could not send the test.'); }
        setBusy(false);
    }

    return (
        <div className="desktop-install">
            <div className="desktop-install-title">Notifications</div>
            <p>{TEXT[state]}</p>
            {state === 'default' && <button type="button" className="push-on" onClick={turnOn} disabled={busy}>Turn on</button>}
            {state === 'granted' && <button type="button" className="push-on" onClick={test} disabled={busy}>Send a test notification</button>}
            {note && <p>{note}</p>}
        </div>
    );
}
