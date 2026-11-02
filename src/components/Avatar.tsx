import { useState } from 'react';
import { useDecorationOf } from '../decorations/store';
import DecoOverlay from '../decorations/DecoOverlay';

export const PROFILE_EVENT = 'velcord:open-profile';
export function openProfile(userId: number) {
    window.dispatchEvent(new CustomEvent<number>(PROFILE_EVENT, { detail: userId }));
}

interface AvatarProps {
    name: string;
    color: string;
    src?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Click opens the picture in a larger view */
    zoomable?: boolean;
    /** With zoomable: a click opens this person's profile window instead of the picture */
    userId?: number;
    /** Shows a green (online) or grey (offline) dot in the corner */
    status?: 'online' | 'offline';
    /** show this decoration instead of the one the person wears (shop previews); null = none */
    deco?: string | null;
}

export default function Avatar({ name, color, src, size = 'md', zoomable = false, userId, status, deco }: AvatarProps) {
    const [open, setOpen] = useState(false);
    const worn = useDecorationOf(name);
    const decoId = deco === undefined ? worn : deco;
    const letter = name.charAt(0).toUpperCase();

    const circle = (
        <div
            className={`avatar avatar-${size} ${zoomable ? 'avatar-zoomable' : ''}`}
            style={{ background: color, overflow: 'hidden' }}
            title={name}
            onClick={zoomable ? (e) => { e.stopPropagation(); if (userId) openProfile(userId); else setOpen(true); } : undefined}
        >
            {src ? (
                <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
                letter
            )}
        </div>
    );

    return (
        <>
            {status || decoId ? (
                <div className={`avatar-wrap avatar-wrap-${size} ${decoId ? 'has-deco' : ''}`}>
                    {circle}
                    {decoId && <DecoOverlay id={decoId} />}
                    {status && <span className={`status-dot status-${status}`} />}
                </div>
            ) : circle}

            {open && (
                <div className="avatar-lightbox" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
                    <div className="avatar-lightbox-card" onClick={e => e.stopPropagation()}>
                        {src ? (
                            <img src={src} alt={name} className="avatar-lightbox-img" />
                        ) : (
                            <div className="avatar-lightbox-img avatar-lightbox-letter" style={{ background: color }}>{letter}</div>
                        )}
                        <div className="avatar-lightbox-name">{name}</div>
                        <button className="avatar-lightbox-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
                    </div>
                </div>
            )}
        </>
    );
}
