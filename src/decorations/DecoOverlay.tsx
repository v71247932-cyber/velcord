import { useEffect, useState } from 'react';
import { loadSvgs } from './store';
import './deco.css';

/** the animated drawing around an avatar; sits on top of the avatar, 1.5 times its size */
export default function DecoOverlay({ id }: { id: string }) {
    const [svg, setSvg] = useState<string | null>(null);
    useEffect(() => {
        let off = false;
        setSvg(null);
        loadSvgs().then(all => { if (!off) setSvg(all[id] || null); }).catch(() => { /* noop */ });
        return () => { off = true; };
    }, [id]);
    if (!svg) return null;
    return <span className="avatar-deco" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
