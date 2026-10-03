// Call sounds, synthesized in the browser (no audio files to download).
// The chosen one is remembered on this device.

interface Pattern { period: number; play: (c: AudioContext, out: AudioNode) => void }
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

// ---- the one call sound
// A short two-part melody: a rising wooden phrase answered by a falling one that ends on a
// soft bell. More musical than a beep, still quick enough to not get tiresome.
const incoming: Pattern = {
    period: 3.8,
    play: (c, o) => {
        const out = withEcho(c, o, 0.26);
        [N.E5, N.G5, N.B5, N.E6].forEach((f, i) => marimba(c, out, f, i * 0.14, 0.3));
        [N.D6, N.B5, N.G5].forEach((f, i) => marimba(c, out, f, 0.78 + i * 0.16, 0.24));
        bell(c, out, N.E6, 1.32, 1.5, 0.12);
    },
};
const outgoing: Pattern = {
    period: 3.8,
    play: (c, o) => {
        const out = withEcho(c, o, 0.24);
        marimba(c, out, N.A4, 0, 0.14);
        marimba(c, out, N.E5, 0.36, 0.14);
        bell(c, out, N.A5, 0.72, 1.3, 0.07);
    },
};

/** Plays the repeating call sound; returns a function that stops it. */
export function startRinging(isIncoming: boolean): () => void {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return () => {};
    const c = new Ctx() as AudioContext;
    c.resume().catch(() => {});
    const master = c.createGain();
    master.gain.value = 0.9;
    master.connect(c.destination);
    const pattern = isIncoming ? incoming : outgoing;
    pattern.play(c, master);
    const iv = setInterval(() => pattern.play(c, master), pattern.period * 1000);
    return () => { clearInterval(iv); c.close().catch(() => {}); };
}
