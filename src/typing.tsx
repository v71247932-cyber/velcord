import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { getTyping, onTyping } from './live';
import './typing.css';

const STALE_MS = 6000; // the server keeps a "typing" signal for 5 s

/** Names of the people typing in this conversation right now. */
export function useTypingNames(kind: 'dm' | 'group', id: number): string[] {
    const [names, setNames] = useState<string[]>([]);
    useEffect(() => {
        const compute = () => {
            const { entries, at } = getTyping();
            const fresh = Date.now() - at < STALE_MS;
            const list = !fresh ? [] : entries
                .filter(e => (kind === 'dm' ? e.groupId == null && e.userId === id : e.groupId === id))
                .map(e => e.username);
            setNames(prev => (prev.join('\n') === list.join('\n') ? prev : list));
        };
        compute();
        const off = onTyping(compute);
        const iv = setInterval(compute, 1000); // lets a stale "typing" line clear itself
        return () => { off(); clearInterval(iv); };
    }, [kind, id]);
    return names;
}

/** Call on every keystroke; it tells the server at most once every 2.5 seconds. */
export function useTypingPing(kind: 'dm' | 'group', id: number) {
    const last = useRef(0);
    return useCallback(() => {
        const now = Date.now();
        if (now - last.current < 2500) return;
        last.current = now;
        api.typing(kind === 'dm' ? { to: id } : { group: id }).catch(() => {});
    }, [kind, id]);
}

export function TypingLine({ names }: { names: string[] }) {
    if (names.length === 0) return <div className="typing-line" />;
    const text = names.length === 1
        ? <><b>{names[0]}</b> is typing…</>
        : names.length === 2
            ? <><b>{names[0]}</b> and <b>{names[1]}</b> are typing…</>
            : <>Several people are typing…</>;
    return (
        <div className="typing-line">
            <span className="typing-dots"><i /><i /><i /></span>
            <span>{text}</span>
        </div>
    );
}
