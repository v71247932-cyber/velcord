import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../AuthContext';
import Avatar from '../components/Avatar';
import { Nameplate, ProfileEffect } from '../decorations/Cosmetics';
import { COMBOS, DECOS, EFFECTS, PLATES, setLocalItem, useDecorationOf, useEffectOf, usePlateOf } from '../decorations/store';
import type { Combo, Deco, ItemKind } from '../decorations/store';
import './shop.css';

const PAGE = 30;
const CATALOG: Record<ItemKind, Deco[]> = { deco: DECOS, effect: EFFECTS, plate: PLATES, combo: COMBOS };
const TAB_LABEL: Record<ItemKind, string> = { deco: 'Avatar decorations', effect: 'Profile effects', plate: 'Nameplates', combo: 'Combos' };
const KINDS: ItemKind[] = ['deco', 'effect', 'plate', 'combo'];
const HERO: Record<ItemKind, { title: string; text: string }> = {
    deco: { title: 'ways to dress up your avatar', text: 'Pick one and everybody in your chats will see it around your picture. Everything here is free.' },
    effect: { title: 'scenes for your profile', text: 'A little animation that plays over your profile card whenever somebody opens it. Everything here is free.' },
    plate: { title: 'backgrounds for your name', text: 'An animated strip behind your name in the friends, messages and member lists. Everything here is free.' },
    combo: { title: 'ready-made looks', text: 'Each one is a decoration, a nameplate and a profile effect picked to go together. One click and you wear all three. Everything here is free.' },
};

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

/** draws its children only while it is on screen: hundreds of animated drawings at once would be too heavy */
function WhenVisible({ children, w, h }: { children: React.ReactNode; w: number | string; h: number }) {
    const ref = useRef<HTMLDivElement>(null);
    const [seen, setSeen] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || !('IntersectionObserver' in window)) { setSeen(true); return; }
        const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: '160px' });
        io.observe(el);
        return () => io.disconnect();
    }, []);
    return <div ref={ref} className="shop-slot" style={{ width: w, height: h }}>{seen ? children : null}</div>;
}

export default function ShopPage() {
    const { user } = useAuth();
    const wornDeco = useDecorationOf(user?.username);
    const wornEffect = useEffectOf(user?.username);
    const wornPlate = usePlateOf(user?.username);
    const worn: Record<ItemKind, string | null> = { deco: wornDeco, effect: wornEffect, plate: wornPlate, combo: null };
    const isOn = (d: Deco) => kind === 'combo'
        ? (wornDeco === (d as Combo).deco && wornPlate === (d as Combo).plate && wornEffect === (d as Combo).effect)
        : worn[kind] === d.id;

    const [kind, setKind] = useState<ItemKind>('deco');
    const [theme, setTheme] = useState('all');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<'you' | 'az' | 'new'>('you');
    const [seed, setSeed] = useState(() => (user?.id || 1) * 7919);
    const [limit, setLimit] = useState(PAGE);
    const [open, setOpen] = useState<Deco | null>(null);
    const [busy, setBusy] = useState(false);

    const items = CATALOG[kind];
    const themes = useMemo(() => [...new Set(items.map(d => d.theme))], [items]);
    const featured = useMemo(() => shuffled(items, Math.floor(Date.now() / 86400000) + kind.length).slice(0, 4), [items, kind]);

    const list = useMemo(() => {
        const q = query.trim().toLowerCase();
        let l = items.filter(d => (theme === 'all' || d.theme === theme) && (!q || d.name.toLowerCase().includes(q) || d.tags.some(t => t.toLowerCase().includes(q))));
        if (sort === 'az') l = [...l].sort((a, b) => a.name.localeCompare(b.name));
        else if (sort === 'new') l = [...l].reverse();
        else l = shuffled(l, seed);
        return l;
    }, [items, theme, query, sort, seed]);

    useEffect(() => { setLimit(PAGE); }, [kind, theme, query, sort, seed]);
    useEffect(() => { setTheme('all'); setQuery(''); setOpen(null); }, [kind]);

    async function equipCombo(c: Combo | null) {
        if (!user) return;
        setBusy(true);
        try {
            await api.setDecoration(c ? c.deco : null);
            await api.setCosmetic('plate', c ? c.plate : null);
            await api.setCosmetic('effect', c ? c.effect : null);
            setLocalItem('deco', user.username, c ? c.deco : null);
            setLocalItem('plate', user.username, c ? c.plate : null);
            setLocalItem('effect', user.username, c ? c.effect : null);
        } catch (e: any) {
            alert(e.message || 'Could not save');
        } finally {
            setBusy(false);
        }
    }

    // one click on a card or a button: wear it, or take it off if it is already worn
    function toggle(d: Deco) {
        if (kind === 'combo') { equipCombo(isOn(d) ? null : (d as Combo)); return; }
        equip(isOn(d) ? null : d.id);
    }

    async function equip(id: string | null) {
        if (!user || kind === 'combo') return;
        setBusy(true);
        try {
            if (kind === 'deco') await api.setDecoration(id); else await api.setCosmetic(kind, id);
            setLocalItem(kind, user.username, id);
        } catch (e: any) {
            alert(e.message || 'Could not save');
        } finally {
            setBusy(false);
        }
    }

    // what one item looks like on this person
    const preview = (d: Deco, where: 'card' | 'hero' | 'modal') => {
        if (!user) return null;
        if (kind === 'combo') {
            const c = d as Combo;
            const w = where === 'modal' ? 220 : where === 'hero' ? 78 : 150;
            const h = Math.round(w * 1.4);
            const ph = where === 'hero' ? 24 : 38;
            return (
                <WhenVisible w={w} h={h + ph + 6}>
                    <div className="shop-combo" style={{ width: w }}>
                        <div className="shop-mini" style={{ width: w, height: h }}>
                            <div className="shop-mini-banner" />
                            <div className="shop-mini-av"><Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="md" deco={c.deco} /></div>
                            <div className="shop-mini-name">{user.username}</div>
                            <ProfileEffect id={c.effect} />
                        </div>
                        <div className="shop-plate" style={{ width: w, height: ph }}>
                            <Nameplate id={c.plate} />
                            <span>{user.username}</span>
                        </div>
                    </div>
                </WhenVisible>
            );
        }
        if (kind === 'deco') {
            const slot = where === 'modal' ? 150 : where === 'hero' ? 96 : 84;
            return <WhenVisible w={slot} h={slot}><Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="xl" deco={d.id} /></WhenVisible>;
        }
        if (kind === 'effect') {
            const w = where === 'modal' ? 220 : where === 'hero' ? 78 : 150;
            return (
                <WhenVisible w={w} h={Math.round(w * 1.4)}>
                    <div className="shop-mini" style={{ width: w, height: Math.round(w * 1.4) }}>
                        <div className="shop-mini-banner" />
                        <div className="shop-mini-av"><Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="md" deco={null} /></div>
                        <div className="shop-mini-name">{user.username}</div>
                        <ProfileEffect id={d.id} />
                    </div>
                </WhenVisible>
            );
        }
        const w = where === 'modal' ? 260 : where === 'hero' ? 130 : 200;
        return (
            <WhenVisible w={w} h={where === 'hero' ? 40 : 48}>
                <div className="shop-plate" style={{ width: w, height: where === 'hero' ? 40 : 48 }}>
                    <Nameplate id={d.id} />
                    <Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="sm" deco={null} />
                    <span>{user.username}</span>
                </div>
            </WhenVisible>
        );
    };

    const card = (d: Deco) => (
        <button key={d.id} type="button" className={`shop-card kind-${kind} ${isOn(d) ? 'on' : ''}`} onClick={() => setOpen(d)}>
            <div className="shop-art">{preview(d, 'card')}</div>
            <div className="shop-name">{d.name}</div>
            <div className="shop-sub">{isOn(d) ? 'Equipped' : 'Free'}</div>
            <span
                role="button"
                tabIndex={-1}
                className={`shop-buy ${isOn(d) ? 'off' : ''}`}
                onClick={e => { e.stopPropagation(); toggle(d); }}
            >
                {isOn(d) ? 'Remove' : kind === 'combo' ? 'Equip all' : 'Equip'}
            </span>
        </button>
    );

    const wornItem = items.find(d => isOn(d)) ?? null;

    return (
        <div className="shop-page">
            <div className="shop-kinds" role="tablist">
                {KINDS.map(k => (
                    <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{TAB_LABEL[k]} <span>{CATALOG[k].length}</span></button>
                ))}
            </div>
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
                            <div className="shop-kicker">{TAB_LABEL[kind]}</div>
                            <h2>{items.length} {HERO[kind].title}</h2>
                            <p>{HERO[kind].text}</p>
                            {wornItem && (
                                <div className="shop-now">
                                    <span>You wear <b>{wornItem.name}</b></span>
                                    <button type="button" onClick={() => toggle(wornItem)} disabled={busy}>Take it off</button>
                                </div>
                            )}
                        </div>
                        <div className={`shop-hero-art kind-${kind}`}>{featured.map(d => (
                            <button key={d.id} type="button" className="shop-hero-item" onClick={() => setOpen(d)} title={d.name}>
                                {preview(d, 'hero')}
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
                <div className={`shop-grid kind-${kind}`}>{list.slice(0, limit).map(d => card(d))}</div>
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
                            {kind === 'deco' && <div className="shop-modal-art">{preview(open, 'modal')}</div>}
                            {kind === 'combo' && (() => { const c = open as Combo; const nm = (list: Deco[], id: string) => list.find(x => x.id === id)?.name || id; return (
                                <ul className="shop-combo-parts">
                                    <li><span>Avatar decoration</span><b>{nm(DECOS, c.deco)}</b></li>
                                    <li><span>Nameplate</span><b>{nm(PLATES, c.plate)}</b></li>
                                    <li><span>Profile effect</span><b>{nm(EFFECTS, c.effect)}</b></li>
                                </ul>); })()}
                            <h2>{open.name}</h2>
                            <p>{kind === 'deco' ? 'Shows around your avatar everywhere in Velcord.' : kind === 'effect' ? 'Plays over your profile card whenever somebody opens it.' : kind === 'combo' ? 'Puts all three on your account at once. They replace what you wear now.' : 'Shows behind your name in the friends, messages and member lists.'}</p>
                            <div className="shop-tags">{[...new Set([open.theme, ...open.tags])].map(t => <span key={t}>{t}</span>)}</div>
                            <div className="shop-price">Free</div>
                            <button
                                type="button"
                                className="shop-big-btn"
                                disabled={busy}
                                onClick={() => toggle(open)}
                            >
                                {isOn(open) ? 'Remove' : kind === 'combo' ? 'Equip all three' : 'Equip'}
                            </button>
                        </div>
                        <div className="shop-modal-right">
                            {kind === 'combo' ? (
                                <div className="shop-combo-big">
                                    <div className="shop-profile">
                                        <div className="shop-profile-banner" style={{ background: user.bannerColor1 && user.bannerColor2 ? `linear-gradient(135deg, ${user.bannerColor1}, ${user.bannerColor2})` : undefined }} />
                                        <div className="shop-profile-avatar"><Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="xl" deco={(open as Combo).deco} /></div>
                                        <div className="shop-profile-body">
                                            <div className="shop-profile-name">{user.username}</div>
                                            <div className="shop-profile-sub">This is how it looks on your profile</div>
                                            <div className="shop-profile-msg">Message @{user.username}</div>
                                        </div>
                                        <ProfileEffect id={(open as Combo).effect} />
                                    </div>
                                    <div className="shop-plate" style={{ width: 300, height: 48 }}>
                                        <Nameplate id={(open as Combo).plate} />
                                        <Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="sm" deco={(open as Combo).deco} />
                                        <span>{user.username}</span>
                                    </div>
                                </div>
                            ) : kind === 'plate' ? (
                                <div className="shop-list-preview">
                                    <div className="shop-list-row"><span className="dot" />Friend one</div>
                                    <div className="shop-list-row mine"><div className="shop-plate" style={{ width: '100%', height: 48 }}>
                                        <Nameplate id={open.id} />
                                        <Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="sm" deco={null} />
                                        <span>{user.username}</span>
                                    </div></div>
                                    <div className="shop-list-row"><span className="dot" />Friend two</div>
                                </div>
                            ) : (
                                <div className="shop-profile">
                                    <div className="shop-profile-banner" style={{ background: user.bannerColor1 && user.bannerColor2 ? `linear-gradient(135deg, ${user.bannerColor1}, ${user.bannerColor2})` : undefined }} />
                                    <div className="shop-profile-avatar"><Avatar name={user.username} color={user.avatarColor} src={user.avatarUrl} size="xl" deco={kind === 'deco' ? open.id : null} /></div>
                                    <div className="shop-profile-body">
                                        <div className="shop-profile-name">{user.username}</div>
                                        <div className="shop-profile-sub">This is how it looks on your profile</div>
                                        <div className="shop-profile-msg">Message @{user.username}</div>
                                    </div>
                                    {kind === 'effect' && <ProfileEffect id={open.id} />}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
