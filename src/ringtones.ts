// Call sounds, synthesized in the browser (no audio files to download).
// The chosen one is remembered on this device.

export type RingtoneId = 'marimba' | 'bells' | 'classic' | 'pulse' | 'soft' | 'off';

interface Pattern { period: number; play: (c: AudioContext, out: AudioNode) => void }
interface Ringtone { id: RingtoneId; label: string; hint: string; incoming: Pattern; outgoing: Pattern }

const STORAGE_KEY = 'velcord_ringtone';
const N: Record<string, number> = {
    G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99,
    A5: 880.0, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98,
};

// ---- building blocks
function envelope(g: GainNode, t0: number, attack: number, decay: number, peak: number) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

/** Adds a soft echo so notes ring out in a room instead of sounding dry. */
function withEcho(c: AudioContext, out: AudioNode, amount = 0.3): AudioNode {
    const input = c.createGain();
    const delay = c.createDelay(1);
    const feedback = c.createGain();
    const wet = c.createGain();
    delay.delayTime.value = 0.2;
    feedback.gain.value = 0.32;
    wet.gain.value = amount;
    input.connect(out);
    input.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(out);
    return input;
}

/** Wooden mallet: a pure tone plus a short, higher knock. */
function marimba(c: AudioContext, out: AudioNode, f: number, t: number, vol: number) {
    const body = c.createGain();
    envelope(body, c.currentTime + t, 0.004, 0.5, vol);
    body.connect(out);
    const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = f;
    o1.connect(body); o1.start(c.currentTime + t); o1.stop(c.currentTime + t + 0.6);
    const knock = c.createGain();
    envelope(knock, c.currentTime + t, 0.002, 0.07, vol * 0.45);
    knock.connect(out);
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 4;
    o2.connect(knock); o2.start(c.currentTime + t); o2.stop(c.currentTime + t + 0.12);
}

/** Small bell: frequency modulation gives the metallic shimmer that fades as it rings. */
function bell(c: AudioContext, out: AudioNode, f: number, t: number, decay: number, vol: number) {
    const t0 = c.currentTime + t;
    const amp = c.createGain();
    envelope(amp, t0, 0.005, decay, vol);
    amp.connect(out);
    const carrier = c.createOscillator(); carrier.type = 'sine'; carrier.frequency.value = f;
    const mod = c.createOscillator(); mod.type = 'sine'; mod.frequency.value = f * 3.5;
    const depth = c.createGain();
    depth.gain.setValueAtTime(f * 2.2, t0);
    depth.gain.exponentialRampToValueAtTime(1, t0 + decay * 0.8);
    mod.connect(depth).connect(carrier.frequency);
    carrier.connect(amp);
    carrier.start(t0); mod.start(t0);
    carrier.stop(t0 + decay + 0.1); mod.stop(t0 + decay + 0.1);
}

/** Gentle plucked note: sine plus a quiet octave, smooth attack. */
function pluck(c: AudioContext, out: AudioNode, f: number, t: number, decay: number, vol: number) {
    const t0 = c.currentTime + t;
    const amp = c.createGain();
    envelope(amp, t0, 0.02, decay, vol);
    amp.connect(out);
    for (const [mult, level] of [[1, 1], [2, 0.18]] as const) {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f * mult;
        const g = c.createGain(); g.gain.value = level;
        o.connect(g).connect(amp);
        o.start(t0); o.stop(t0 + decay + 0.1);
    }
}

/** One burst of a classic phone ring: two tones shaken 25 times a second. */
function ringBurst(c: AudioContext, out: AudioNode, t: number, dur: number, vol: number) {
    const t0 = c.currentTime + t;
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
    amp.gain.setValueAtTime(vol, t0 + dur - 0.03);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const shake = c.createGain();
    shake.gain.value = 0.55;
    const lfo = c.createOscillator(); lfo.frequency.value = 25;
    const lfoDepth = c.createGain(); lfoDepth.gain.value = 0.45;
    lfo.connect(lfoDepth).connect(shake.gain);
    shake.connect(amp);
    amp.connect(out);
    for (const f of [1040, 1320]) {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        o.connect(shake); o.start(t0); o.stop(t0 + dur + 0.05);
    }
    lfo.start(t0); lfo.stop(t0 + dur + 0.05);
}

/** Plain steady tone, used for the "calling" sound of the classic phone. */
function tone(c: AudioContext, out: AudioNode, f: number[], t: number, dur: number, vol: number) {
    const t0 = c.currentTime + t;
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(vol, t0 + 0.05);
    amp.gain.setValueAtTime(vol, t0 + dur - 0.08);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    amp.connect(out);
    for (const x of f) {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = x;
        o.connect(amp); o.start(t0); o.stop(t0 + dur + 0.05);
    }
}

// ---- the sounds
export const RINGTONES: Ringtone[] = [
    {
        id: 'marimba', label: 'Marimba', hint: 'Warm wooden notes, like a phone ringtone',
        incoming: {
            period: 3.2,
            play: (c, o) => {
                const out = withEcho(c, o, 0.22);
                [N.E5, N.G5, N.B5, N.G5, N.E6, N.B5, N.G5, N.E5].forEach((f, i) => marimba(c, out, f, i * 0.15, 0.3));
            },
        },
        outgoing: {
            period: 3.6,
            play: (c, o) => { const out = withEcho(c, o, 0.2); marimba(c, out, N.A4, 0, 0.16); marimba(c, out, N.E5, 0.4, 0.16); },
        },
    },
    {
        id: 'bells', label: 'Bells', hint: 'Soft ringing bells',
        incoming: {
            period: 3.4,
            play: (c, o) => {
                const out = withEcho(c, o, 0.3);
                bell(c, out, N.G5, 0, 1.5, 0.22);
                bell(c, out, N.D6, 0.34, 1.5, 0.2);
                bell(c, out, N.B5, 0.68, 1.5, 0.2);
                bell(c, out, N.G6, 1.02, 1.8, 0.18);
            },
        },
        outgoing: {
            period: 3.8,
            play: (c, o) => { const out = withEcho(c, o, 0.28); bell(c, out, N.A5, 0, 1.6, 0.13); },
        },
    },
    {
        id: 'classic', label: 'Classic phone', hint: 'The old-style double ring',
        incoming: {
            period: 3.0,
            play: (c, o) => { ringBurst(c, o, 0, 0.42, 0.2); ringBurst(c, o, 0.58, 0.42, 0.2); },
        },
        outgoing: {
            period: 4.0,
            play: (c, o) => tone(c, o, [440, 480], 0, 1.6, 0.1),
        },
    },
    {
        id: 'pulse', label: 'Pulse', hint: 'Short modern pings',
        incoming: {
            period: 2.4,
            play: (c, o) => {
                const out = withEcho(c, o, 0.35);
                [N.A5, N.C6, N.E6].forEach((f, i) => pluck(c, out, f, i * 0.11, 0.55, 0.26));
                [N.A5, N.C6, N.E6].forEach((f, i) => pluck(c, out, f, 0.62 + i * 0.11, 0.55, 0.2));
            },
        },
        outgoing: {
            period: 3.0,
            play: (c, o) => { const out = withEcho(c, o, 0.3); pluck(c, out, N.E5, 0, 0.7, 0.14); pluck(c, out, N.A5, 0.18, 0.8, 0.14); },
        },
    },
    {
        id: 'soft', label: 'Soft', hint: 'Slow and quiet',
        incoming: {
            period: 4.2,
            play: (c, o) => {
                const out = withEcho(c, o, 0.4);
                [N.C5, N.G5, N.E5, N.G5].forEach((f, i) => pluck(c, out, f, i * 0.45, 1.2, 0.18));
            },
        },
        outgoing: {
            period: 4.4,
            play: (c, o) => { const out = withEcho(c, o, 0.4); pluck(c, out, N.G4, 0, 1.2, 0.1); pluck(c, out, N.D5, 0.5, 1.4, 0.1); },
        },
    },
    {
        id: 'off', label: 'Silent', hint: 'No sound (you still see the call)',
        incoming: { period: 60, play: () => {} },
        outgoing: { period: 60, play: () => {} },
    },
];

export function getRingtoneId(): RingtoneId {
    try {
        const v = localStorage.getItem(STORAGE_KEY) as RingtoneId | null;
        if (v && RINGTONES.some(r => r.id === v)) return v;
    } catch { /* storage unavailable */ }
    return 'marimba';
}

export function setRingtoneId(id: RingtoneId) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable */ }
}

export function getRingtone(id: RingtoneId = getRingtoneId()): Ringtone {
    return RINGTONES.find(r => r.id === id) ?? RINGTONES[0];
}

/** Plays one round of the sound so it can be heard in settings. */
export function previewRingtone(id: RingtoneId): () => void {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx || id === 'off') return () => {};
    const c = new Ctx() as AudioContext;
    c.resume().catch(() => {});
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(c.destination);
    getRingtone(id).incoming.play(c, master);
    const timer = setTimeout(() => c.close().catch(() => {}), 4500);
    return () => { clearTimeout(timer); c.close().catch(() => {}); };
}

/** Plays the repeating call sound; returns a function that stops it. */
export function startRinging(incoming: boolean): () => void {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const tone = getRingtone();
    if (!Ctx || tone.id === 'off') return () => {};
    const c = new Ctx() as AudioContext;
    c.resume().catch(() => {});
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(c.destination);
    const pattern = incoming ? tone.incoming : tone.outgoing;
    pattern.play(c, master);
    const iv = setInterval(() => pattern.play(c, master), pattern.period * 1000);
    return () => { clearInterval(iv); c.close().catch(() => {}); };
}
