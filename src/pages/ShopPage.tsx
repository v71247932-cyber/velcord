import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import Avatar from '../components/Avatar';
import { DECOS, DECO_BY_ID, setLocalDecoration, useDecorationOf } from '../decorations/store';
import type { Deco } from '../decorations/store';
import './shop.css';

const PAGE = 30;

// a small deterministic shuffle, so "For you" stays the same until Shuffle is pressed
function seeded(seed: number) {
    let s = seed >>> 0 || 1;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function shuffled<T>(list: T[], seed: number): T[] {
    const r = seeded(seed), a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

/** draws its children only while it is on screen: 200 animated drawings at once would be too heavy */
function WhenVisible({ children, size }: { children: React.ReactNode; size: number }) {
    const ref = useRef<HTMLDivElement>(null);
    const [seen, setSeen] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || !('IntersectionObserver' in window)) { setSeen(true); return; }
        const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: '120px' });
        io.observe(el);
        return () => io.disconnect();
    }, []);
    return <div ref={ref} className="shop-slot" style={{ width: size, height: size }}>{seen ? children : null}</div>;
}

export default function ShopPage() {
    const { user } = useAuth();
    const worn = useDecorationOf(user?.username);
    const [theme, setTheme] = useState('all');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<'you' | 'az' | 'new'>('you');
    const [seed, setSeed] = useState(() => (user?.id || 1) * 7919);
    const [limit, setLimit] = useState(PAGE);
    const [open, setOpen] = useState<Deco | null>(null);
    const [busy, setBusy] = useState(false);

    const themes = useMemo(() => [...new Set(DECOS.map(d => d.theme))], []);
    const featured = useMemo(() => {
        const day = Math.floor(Date.now() / 86400000);
        return shuffled(DECOS, day).slice(0, 4);
    }, []);

    const list = useMemo(() => {
        const q = query.trim().toLowerCase();
        let l = DECOS.filter(d => (theme === 'all' || d.theme === theme) && (!q || d.name.toLowerCase().includes(q) || d.tags.some(t => t.toLowerCase().includes(q))));
        if (sort === 'az') l = [...l].sort((a, b) => a.name.localeCompare(b.name));
        else if (sort === 'new') l = [...l].reverse();
        else l = shuffled(l, seed);
        return l;
    }, [theme, query, sort, seed]);

    useEffect(() => { setLimit(PAGE); }, [theme, query, sort, seed]);

    async function equip(id: string | null) {
        if (!user) return;
        setBusy(true);
        try {
            await api.setDecoration(id);
            setLocalDecoration(user.username, id);
        } catch (e: any) {
            alert(e.message || 'Could not save');
        } finally {
            setBusy(false);
        }
    }

    const preview = (d: Deco, size: 'lg' | 'xl') => user && (
        <Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size={size} deco={d.id} />
    );

    const card = (d: Deco, big = false) => (
        <button key={d.id} type="button" className={`shop-card ${big ? 'big' : ''} ${worn === d.id ? 'on' : ''}`} onClick={() => setOpen(d)}>
            <div className="shop-art">
                <WhenVisible size={big ? 110 : 84}>{preview(d, 'xl')}</WhenVisible>
            </div>
            <div className="shop-name">{d.name}</div>
            <div className="shop-sub">{worn === d.id ? 'Equipped' : 'Free'}</div>
            <span
                role="button"
                tabIndex={-1}
                className={`shop-buy ${worn === d.id ? 'off' : ''}`}
                onClick={e => { e.stopPropagation(); equip(worn === d.id ? null : d.id); }}
            >
                {worn === d.id ? 'Remove' : 'Equip'}
            </span>
        </button>
    );

    const openWorn = worn ? DECO_BY_ID.get(worn) : null;

    return (
        <div className="shop-page">
            <div className="shop-top">
                <div className="shop-tabs" role="tablist">
                    <button type="button" className={theme === 'all' ? 'on' : ''} onClick={() => setTheme('all')}>All</button>
                    {themes.map(t => (
                        <button key={t} type="button" className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{t}</button>
                    ))}
                </div>
                <input className="shop-search" type="search" placeholder="Search the Shop" value={query} onChange={e => setQuery(e.target.value)} />
            </div>

            <div className="shop-body">
                {theme === 'all' && !query && (
                    <section className="shop-hero">
                        <div className="shop-hero-text">
                            <div className="shop-kicker">Avatar decorations</div>
                            <h2>{DECOS.length} ways to dress up your avatar</h2>
                            <p>Pick one and everybody in your chats will see it around your picture. Everything here is free.</p>
                            {openWorn && (
                                <div className="shop-now">
                                    <span>You wear <b>{openWorn.name}</b></span>
                                    <button type="button" onClick={() => equip(null)} disabled={busy}>Take it off</button>
                                </div>
                            )}
                        </div>
                        <div className="shop-hero-art">{featured.map(d => (
                            <button key={d.id} type="button" className="shop-hero-item" onClick={() => setOpen(d)} title={d.name}>
                                <WhenVisible size={96}>{preview(d, 'xl')}</WhenVisible>
                                <span>{d.name}</span>
                            </button>
                        ))}</div>
                    </section>
                )}

                <div className="shop-bar">
                    <h3>{theme === 'all' ? 'Find your style' : theme}</h3>
                    <div className="shop-bar-right">
                        <label>Sort by
                            <select value={sort} onChange={e => setSort(e.target.value as 'you' | 'az' | 'new')}>
                                <option value="you">For You</option>
                                <option value="az">A to Z</option>
                                <option value="new">Newest</option>
                            </select>
                        </label>
                        <button type="button" className="shop-shuffle" onClick={() => { setSort('you'); setSeed(s => s + 1); }}>Shuffle!</button>
                    </div>
                </div>

                {list.length === 0 && <div className="shop-empty">Nothing matches “{query}”.</div>}
                <div className="shop-grid">{list.slice(0, limit).map(d => card(d))}</div>
                {limit < list.length && (
                    <div className="shop-more">
                        <div>There’s so much more</div>
                        <button type="button" onClick={() => setLimit(l => l + PAGE)}>Show more</button>
                    </div>
                )}
            </div>

            {open && user && (
                <div className="shop-modal-back" onClick={() => setOpen(null)}>
                    <div className="shop-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label={open.name}>
                        <button type="button" className="shop-x" onClick={() => setOpen(null)} aria-label="Close">×</button>
                        <div className="shop-modal-left">
                            <div className="shop-modal-art"><WhenVisible size={150}>{preview(open, 'xl')}</WhenVisible></div>
                            <h2>{open.name}</h2>
                            <p>Shows around your avatar everywhere in Velcord.</p>
                            <div className="shop-tags">{[open.theme, ...open.tags].map(t => <span key={t}>{t}</span>)}</div>
                            <div className="shop-price">Free</div>
                            <button
                                type="button"
                                className="shop-big-btn"
                                disabled={busy}
                                onClick={() => equip(worn === open.id ? null : open.id)}
                            >
                                {worn === open.id ? 'Remove from my avatar' : 'Equip'}
                            </button>
                        </div>
                        <div className="shop-modal-right">
                            <div className="shop-profile">
                                <div className="shop-profile-banner" style={{ background: user.bannerColor1 && user.bannerColor2 ? `linear-gradient(135deg, ${user.bannerColor1}, ${user.bannerColor2})` : undefined }} />
                                <div className="shop-profile-avatar"><WhenVisible size={108}>{preview(open, 'xl')}</WhenVisible></div>
                                <div className="shop-profile-body">
                                    <div className="shop-profile-name">{user.username}</div>
                                    <div className="shop-profile-sub">This is how it looks on your profile</div>
                                    <div className="shop-profile-msg">Message @{user.username}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
