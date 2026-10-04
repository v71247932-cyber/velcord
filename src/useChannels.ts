import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Channel } from './api';

/** The channels of one group, refreshed every few seconds (voice channels show who is in them). */
export function useChannels(groupId: number | null) {
    const [channels, setChannels] = useState<Channel[]>([]);
    const [loadedFor, setLoadedFor] = useState<number | null>(null);
    const current = useRef<number | null>(groupId);
    current.current = groupId;

    const reload = useCallback(async () => {
        const gid = current.current;
        if (!gid) return;
        try {
            const r = await api.getChannels(gid);
            if (current.current === gid) { setChannels(r.channels); setLoadedFor(gid); } // ignore answers for a group that is no longer open
        } catch { /* try again on the next round */ }
    }, []);

    useEffect(() => {
        setChannels([]);
        setLoadedFor(null);
        if (!groupId) return;
        reload();
        const iv = setInterval(reload, 8000);
        return () => clearInterval(iv);
    }, [groupId, reload]);

    return { channels, reload, loaded: loadedFor === groupId };
}
