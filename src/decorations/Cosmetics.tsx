import { useEffect, useState } from 'react';
import { loadEffectSvgs, loadPlateSvgs, useEffectOf, usePlateOf } from './store';
import './deco.css';

function useSvg(id: string | null, load: () => Promise<Record<string, string>>) {
    const [svg, setSvg] = useState<string | null>(null);
    useEffect(() => {
        let off = false;
        setSvg(null);
        if (!id) return;
        load().then(all => { if (!off) setSvg(all[id] || null); }).catch(() => { /* noop */ });
        return () => { off = true; };
    }, [id, load]);
    return svg;
}

/** an animated scene over a profile card; the card must be position:relative with overflow:hidden */
export function ProfileEffect({ id }: { id: string | null }) {
    const svg = useSvg(id, loadEffectSvgs);
    if (!svg) return null;
    return <div className="profile-fx" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** the effect that belongs to this person */
export function ProfileEffectOf({ name }: { name: string }) {
    return <ProfileEffect id={useEffectOf(name)} />;
}

/** an animated row background behind a name; the row gets the "has-plate" look through CSS (:has) */
export function Nameplate({ id }: { id: string | null }) {
    const svg = useSvg(id, loadPlateSvgs);
    if (!svg) return null;
    return <div className="nameplate-bg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function NameplateOf({ name }: { name: string }) {
    return <Nameplate id={usePlateOf(name)} />;
}
