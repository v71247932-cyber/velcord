// Sends page errors (and, with ?debug=1 once on a phone, taps) to the server so a problem that only
// shows up on one device can be read afterwards. Nothing personal is sent: no messages, no names.

let sent = 0;
const MAX = 80;

function report(kind: string, msg: string) {
    if (sent >= MAX) return;
    sent += 1;
    try {
        fetch('/api/client-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind, msg: `${msg} | ${innerWidth}x${innerHeight} ${(navigator as any).standalone ? 'standalone' : 'tab'}` }),
            keepalive: true,
        }).catch(() => {});
    } catch { /* noop */ }
}

const describe = (el: EventTarget | null) => {
    const e = el as HTMLElement | null;
    return e && e.tagName ? `${e.tagName.toLowerCase()}.${String(e.className || '').split(' ').slice(0, 2).join('.')}` : '?';
};

export function startClientLog() {
    try {
        const q = new URLSearchParams(location.search);
        if (q.get('debug') === '1') localStorage.setItem('velcord_debug', '1');
        if (q.get('debug') === '0') localStorage.removeItem('velcord_debug');
    } catch { /* noop */ }
    window.addEventListener('error', e => report('error', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
    window.addEventListener('unhandledrejection', e => report('promise', String((e.reason && (e.reason.stack || e.reason.message)) || e.reason).slice(0, 400)));
    // TEMPORARY: on iPhone/iPad taps are logged by default while a menu problem is being tracked down
    let debug = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    try { debug = debug || localStorage.getItem('velcord_debug') === '1'; } catch { /* noop */ }
    if (!debug) return;
    report('debug', `start ${navigator.userAgent.slice(0, 80)}`);
    ['touchstart', 'touchend', 'click'].forEach(type =>
        window.addEventListener(type, e => report('tap', `${type} on ${describe(e.target)}`), { capture: true, passive: true }));
    const watch = () => {
        const layout = document.querySelector('.app-layout');
        if (!layout) return setTimeout(watch, 500);
        new MutationObserver(() => report('layout', `class="${layout.className}"`)).observe(layout, { attributes: true, attributeFilter: ['class'] });
    };
    watch();
}
