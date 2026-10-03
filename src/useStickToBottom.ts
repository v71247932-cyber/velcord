import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from './api';
import './chatScroll.css';

const NEAR_BOTTOM = 140; // px from the end that still counts as "reading the newest messages"

/**
 * Keeps a chat scrolled to the newest message.
 * - A new message scrolls down by itself while you are at the bottom, and always after you send one.
 * - Pictures, GIFs and players that finish loading later do not push the newest message out of view.
 * - If you scrolled up to read, nothing moves; a "new messages" button counts what you have not seen.
 */
export function useStickToBottom(messages: Message[], meId: number | undefined, resetKey: string | number) {
    const areaRef = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const lastLen = useRef(0);
    const [unseen, setUnseen] = useState(0);

    const toBottom = useCallback((smooth = false) => {
        const el = areaRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    }, []);

    const onScroll = useCallback(() => {
        const el = areaRef.current;
        if (!el) return;
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
        stick.current = near;
        if (near) setUnseen(0);
    }, []);

    // A different conversation: start again at the bottom
    useLayoutEffect(() => {
        lastLen.current = 0;
        stick.current = true;
        setUnseen(0);
    }, [resetKey]);

    useLayoutEffect(() => {
        const n = messages.length;
        const added = n - lastLen.current;
        if (lastLen.current === 0 && n > 0) {
            toBottom(false);
            stick.current = true;
        } else if (added > 0) {
            const newest = messages.slice(-added);
            const mine = newest.some(m => m.sender.id === meId || m.pending);
            if (stick.current || mine) {
                toBottom(added === 1); // one message glides, several jump
                stick.current = true;
            } else {
                const fromOthers = newest.filter(m => m.sender.id !== meId).length;
                if (fromOthers > 0) setUnseen(u => u + fromOthers);
            }
        }
        lastLen.current = n;
    }, [messages, meId, toBottom]);

    // Things that change size after they were added: pictures, GIFs, video posters, players
    useEffect(() => {
        const el = areaRef.current;
        if (!el) return;
        const keep = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
        const ro = new ResizeObserver(keep);
        const watchChildren = () => { for (const c of Array.from(el.children)) ro.observe(c); };
        watchChildren();
        const mo = new MutationObserver(watchChildren);
        mo.observe(el, { childList: true });
        el.addEventListener('load', keep, true);
        el.addEventListener('loadedmetadata', keep, true);
        return () => { ro.disconnect(); mo.disconnect(); el.removeEventListener('load', keep, true); el.removeEventListener('loadedmetadata', keep, true); };
    }, []);

    const jumpToNewest = useCallback(() => {
        toBottom(true);
        stick.current = true;
        setUnseen(0);
    }, [toBottom]);

    return { areaRef, onScroll, unseen, jumpToNewest };
}
