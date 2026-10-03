// Live updates. A single long request asks the server "tell me when something new happens".
// When it does, everything that listens refreshes at once instead of waiting for its timer.
import { api } from './api';
import type { TypingEntry } from './api';

const listeners = new Set<() => void>();
const typingListeners = new Set<() => void>();
let typingState: { entries: TypingEntry[]; at: number } = { entries: [], at: 0 };

/** Who is typing right now, and when the server said so (entries older than a few seconds are stale). */
export function getTyping() { return typingState; }
export function onTyping(cb: () => void): () => void {
    typingListeners.add(cb);
    return () => { typingListeners.delete(cb); };
}

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
        let tmark: string | null = null;
        while (running && mine === generation) {
            try {
                const res = await api.wait(marks, tmark);
                if (!running || mine !== generation) break;
                const changed = marks !== null && res.marks !== marks;
                marks = res.marks;
                if (res.tmark !== tmark) {
                    tmark = res.tmark;
                    typingState = { entries: res.typing || [], at: Date.now() };
                    typingListeners.forEach(f => { try { f(); } catch { /* ignore */ } });
                }
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
