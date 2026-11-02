import { useEffect, useState } from 'react';
import { enablePush, pushState, refreshPush } from '../push';
import type { PushState } from '../push';
import './pushBanner.css';

const DISMISS_KEY = 'velcord-push-dismissed';

/** A small bar that asks to turn notifications on (the permission needs a tap), or explains how to get them on an iPhone. */
export default function PushBanner() {
    const [state, setState] = useState<PushState>(() => pushState());
    const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } });
    const [busy, setBusy] = useState(false);

    useEffect(() => { refreshPush(); }, []);

    if (hidden || (state !== 'default' && state !== 'needs-install')) return null;

    async function turnOn() {
        setBusy(true);
        try { setState(await enablePush()); } catch { setState(pushState()); }
        setBusy(false);
    }
    function dismiss() {
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
        setHidden(true);
    }

    return (
        <div className="push-banner" role="status">
            {state === 'default' ? (
                <>
                    <span>Get notified about new messages and calls, even when Velcord is closed.</span>
                    <button type="button" className="push-on" onClick={turnOn} disabled={busy}>{busy ? '…' : 'Turn on'}</button>
                </>
            ) : (
                <span>To get notifications on an iPhone, open Velcord from the Home Screen icon: in Safari tap Share, then Add to Home Screen.</span>
            )}
            <button type="button" className="push-x" onClick={dismiss} aria-label="Dismiss">×</button>
        </div>
    );
}
