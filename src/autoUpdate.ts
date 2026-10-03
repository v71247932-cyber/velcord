// An open page never gets new code by itself, so one side of a call could run an old version
// that cannot show the other side's video. This checks for a new deploy and reloads when it is
// safe: no call, no upload in progress and nothing typed in a message box.

const loaded = Array.from(document.scripts).map(s => s.src).find(src => /\/assets\/index-[^/]+\.js$/.test(src));

function busy(): boolean {
    if (document.querySelector('.call-card, .upload-bar, .modal-overlay')) return true;
    return Array.from(document.querySelectorAll('textarea, input[type=text]')).some(el => (el as HTMLInputElement).value.trim() !== '');
}

async function check() {
    if (!loaded) return;
    try {
        const res = await fetch('/app', { cache: 'no-store' });
        if (!res.ok) return;
        const m = /assets\/index-[^"']+\.js/.exec(await res.text());
        if (!m || loaded.endsWith(m[0])) return; // same version
        if (!busy()) location.reload();
    } catch { /* offline: try again later */ }
}

export function startAutoUpdate() {
    if (!loaded) return; // dev server
    setInterval(check, 60_000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('focus', check);
}
