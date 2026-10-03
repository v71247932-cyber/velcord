// Live updates. A single long request asks the server "tell me when something new happens".
// When it does, everything that listens refreshes at once instead of waiting for its timer.
import { api } from './api';

const listeners = new Set<() => void>();
let running = false;
let generation = 0;

export function onLive(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function startLive() {
    if (running) return;
    running = true;
    const mine = ++generation;
    (async () => {
        let marks: string | null = null;
        while (running && mine === generation) {
            try {
                const res = await api.wait(marks);
                if (!running || mine !== generation) break;
                const changed = marks !== null && res.marks !== marks;
                marks = res.marks;
                if (changed) listeners.forEach(f => { try { f(); } catch { /* one bad listener must not stop the rest */ } });
            } catch {
                await new Promise(r => setTimeout(r, 3000)); // offline or signed out: try again shortly
            }
        }
    })();
}

export function stopLive() {
    running = false;
    generation++;
}
