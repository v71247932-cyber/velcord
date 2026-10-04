import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, User } from './api';
import { onLive } from './live';

interface StatusRow { id: number; deliveredAt: number | null; readAt: number | null }

interface Options {
    /** Unique per conversation, e.g. "dm-5" or "group-2" */
    key: string;
    me: User;
    /** afterId = 0 loads the latest page, otherwise only newer messages */
    fetchMessages: (afterId: number) => Promise<Message[]>;
    sendMessage: (content: string) => Promise<Message>;
    /** Delivery/seen info for my own messages (direct messages only) */
    fetchStatuses?: () => Promise<StatusRow[]>;
}

// Conversations already opened this session show instantly while the refresh runs.
const cache = new Map<string, Message[]>();
const CACHE_LIMIT = 200;
let pendingSeq = 0;

const lastRealId = (list: Message[]) => list.reduce((m, x) => (x.id > m ? x.id : m), 0);

export function useChat({ key, me, fetchMessages, sendMessage, fetchStatuses }: Options) {
    const [messages, setMessages] = useState<Message[]>(() => cache.get(key) ?? []);
    const lastId = useRef(0);
    const fns = useRef({ fetchMessages, fetchStatuses });
    fns.current = { fetchMessages, fetchStatuses };

    // Switching conversation: start from the cached copy (if any)
    useEffect(() => {
        const cached = cache.get(key) ?? [];
        setMessages(cached);
        lastId.current = lastRealId(cached);

        let stopped = false;
        let tick = 0;
        let busy = false;
        let again = false;
        let forceStatus = false;

        const run = async () => {
            if (busy) { again = true; return; } // never stack requests, but do not lose a wake-up
            busy = true;
            try {
                const newMsgs = await fns.current.fetchMessages(lastId.current);
                if (stopped) return;
                if (newMsgs.length > 0) {
                    lastId.current = Math.max(lastId.current, lastRealId(newMsgs));
                    setMessages(prev => {
                        const known = new Set(prev.map(m => m.id));
                        const fresh = newMsgs.filter(m => !known.has(m.id));
                        return fresh.length ? [...prev, ...fresh] : prev;
                    });
                }
                // Ticks on my messages change rarely: refresh them every third round
                const statusFn = fns.current.fetchStatuses;
                if (statusFn && tick > 0 && (forceStatus || tick % 3 === 0)) {
                    forceStatus = false;
                    const rows = await statusFn();
                    if (stopped) return;
                    const byId = new Map(rows.map(r => [r.id, r]));
                    setMessages(prev => {
                        let changed = false;
                        const next = prev.map(m => {
                            const st = byId.get(m.id);
                            if (!st || m.sender.id !== me.id) return m;
                            if ((st.deliveredAt ?? null) === (m.deliveredAt ?? null) && (st.readAt ?? null) === (m.readAt ?? null)) return m;
                            changed = true;
                            return { ...m, deliveredAt: st.deliveredAt, readAt: st.readAt };
                        });
                        return changed ? next : prev;
                    });
                }
            } catch { /* offline: try again next round */ }
            finally {
                busy = false; tick++;
                if (again && !stopped) { again = false; run(); }
            }
        };

        run();
        // The live channel wakes this up the moment something arrives; the timer is only a safety net
        const off = onLive(() => { forceStatus = true; run(); });
        const iv = setInterval(run, 5000);
        return () => { stopped = true; clearInterval(iv); off(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    useEffect(() => {
        cache.set(key, messages.filter(m => !m.pending).slice(-CACHE_LIMIT));
    }, [key, messages]);

    /** Shows the message at once and replaces it with the saved one when the server answers. */
    const send = useCallback(async (content: string) => {
        const tempId = -(++pendingSeq);
        const optimistic: Message = {
            id: tempId, content, createdAt: Math.floor(Date.now() / 1000), pending: true, sender: me,
        };
        setMessages(prev => [...prev, optimistic]);
        try {
            const saved = await sendMessage(content);
            window.dispatchEvent(new Event('velcord:message-sent')); // lets the sidebar re-order its conversations
            lastId.current = Math.max(lastId.current, saved.id);
            setMessages(prev => {
                const withoutTemp = prev.filter(m => m.id !== tempId);
                if (withoutTemp.some(m => m.id === saved.id)) return withoutTemp; // the poll got there first
                const idx = prev.findIndex(m => m.id === tempId);
                const real: Message = { ...saved, sender: me };
                if (idx === -1) return [...withoutTemp, real];
                const copy = [...prev];
                copy[idx] = real;
                return copy;
            });
        } catch (e) {
            setMessages(prev => prev.filter(m => m.id !== tempId));
            throw e;
        }
    }, [me, sendMessage]);

    return { messages, setMessages, send };
}
