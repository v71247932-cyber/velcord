// iPhone and iPad keep Web Audio silent until the page has been touched, stop it again when the app
// goes to the background, and mute it while the silent switch is on. This keeps ONE audio context
// for the whole app, wakes it up on every touch and moves the page to the "playback" audio category,
// so message chimes and the ringing of a call can be heard.

let ctx: AudioContext | null = null;
let keepAlive: HTMLAudioElement | null = null;

export function getAudioContext(): AudioContext | null {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!ctx || ctx.state === 'closed') ctx = new Ctx() as AudioContext;
    return ctx;
}

/** 0.2 s of silence as a WAV file, built here so there is nothing to download */
function silentWavUrl(): string {
    const rate = 8000, samples = 1600;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function unlock() {
    const c = getAudioContext();
    if (!c) return;
    try { (navigator as any).audioSession.type = 'playback'; } catch { /* older iOS */ }
    if (c.state !== 'running') {
        c.resume().catch(() => {});
        try {
            const src = c.createBufferSource();
            src.buffer = c.createBuffer(1, 1, 22050);
            src.connect(c.destination);
            src.start(0);
        } catch { /* noop */ }
    }
    // a looping silent <audio> makes iOS treat the page as a media player, so the silent switch no longer mutes it
    if (!keepAlive) {
        try {
            keepAlive = new Audio(silentWavUrl());
            keepAlive.loop = true;
            keepAlive.setAttribute('playsinline', '');
            keepAlive.volume = 0.01;
        } catch { keepAlive = null; }
    }
    if (keepAlive && keepAlive.paused) keepAlive.play().catch(() => {});
}

export function installAudioUnlock() {
    const events = ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'];
    events.forEach(e => window.addEventListener(e, unlock, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    });
}
