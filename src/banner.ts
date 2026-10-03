import type { CSSProperties } from 'react';

interface BannerSource {
    avatarColor: string;
    bannerUrl?: string | null;
    bannerColor1?: string | null;
    bannerColor2?: string | null;
}

/** Picture if there is one, else the two chosen colours blended, else a default from the avatar colour. */
export function bannerStyle(u: BannerSource): CSSProperties {
    if (u.bannerUrl) return { background: `center / cover no-repeat url("${u.bannerUrl}"), #1e1f22` };
    if (u.bannerColor1 && u.bannerColor2) return { background: `linear-gradient(135deg, ${u.bannerColor1}, ${u.bannerColor2})` };
    return { background: `linear-gradient(135deg, ${u.avatarColor}, #1e1f22)` };
}
