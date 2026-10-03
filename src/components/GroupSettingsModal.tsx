import { useRef, useState } from 'react';
import { api } from '../api';
import type { Group } from '../api';
import { bannerStyle } from '../banner';
import { coverImageDataUrl, squareImageDataUrl } from '../uploads';
import Avatar from './Avatar';
import { CloseIcon } from './Icons';
import '../group.css';

interface Props {
    group: Group;
    isOwner: boolean;
    onClose: () => void;
    onChanged: () => void;
}

/** Opens when you click the selected group. Only the owner can change things. */
export default function GroupSettingsModal({ group, isOwner, onClose, onChanged }: Props) {
    const [name, setName] = useState(group.name);
    const [c1, setC1] = useState(group.bannerColor1 || '#5865f2');
    const [c2, setC2] = useState(group.bannerColor2 || '#eb459e');
    const [previewColors, setPreviewColors] = useState(false);
    const [busy, setBusy] = useState(false);
    const picRef = useRef<HTMLInputElement>(null);
    const banRef = useRef<HTMLInputElement>(null);

    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try { await fn(); onChanged(); }
        catch (e: any) { alert(e.message); }
        finally { setBusy(false); }
    };

    const saveName = () => {
        const n = name.trim();
        if (!n || n === group.name) return;
        run(() => api.updateGroup(group.id, { name: n }));
    };
    const pickPicture = (f: File) => run(async () => api.updateGroup(group.id, { avatarUrl: await squareImageDataUrl(f, 256) }));
    const pickBanner = (f: File) => run(async () => {
        await api.updateGroup(group.id, { bannerUrl: await coverImageDataUrl(f, 720, 240) });
        setPreviewColors(false);
    });
    const saveColors = () => run(async () => { await api.updateGroup(group.id, { bannerColors: [c1, c2] }); setPreviewColors(false); });
    const resetBanner = () => run(async () => { await api.updateGroup(group.id, { bannerUrl: null, bannerColors: null }); setPreviewColors(false); });

    const banner = previewColors
        ? { background: `linear-gradient(135deg, ${c1}, ${c2})` }
        : bannerStyle({ avatarColor: '#5865f2', bannerUrl: group.bannerUrl, bannerColor1: group.bannerColor1, bannerColor2: group.bannerColor2 });

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content gset" onClick={e => e.stopPropagation()}>
                <div className="gset-banner" style={banner}>
                    <button className="gset-close" onClick={onClose} aria-label="Close"><CloseIcon size={16} /></button>
                </div>
                <div className="gset-body">
                    <div className="gset-top">
                        <div className="gset-pic"><Avatar name={group.name} color="#5865f2" src={group.avatarUrl ?? undefined} size="xl" /></div>
                        <div className="gset-title">
                            <div className="gset-name">{group.name}</div>
                            <div className="gset-sub">{group.memberCount ?? ''} members</div>
                        </div>
                    </div>

                    {!isOwner && <div className="gset-note">Only the group owner can change the name, picture and banner.</div>}

                    {isOwner && (
                        <>
                            <div className="gset-section">
                                <div className="gset-label">Change name</div>
                                <div className="gset-row">
                                    <input className="gset-input" value={name} maxLength={50} onChange={e => setName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') saveName(); }} />
                                    <button className="gset-btn primary" onClick={saveName} disabled={busy || !name.trim() || name.trim() === group.name}>Save</button>
                                </div>
                            </div>

                            <div className="gset-section">
                                <div className="gset-label">Change picture</div>
                                <div className="gset-row">
                                    <button className="gset-btn" onClick={() => picRef.current?.click()} disabled={busy}>Upload picture</button>
                                    {group.avatarUrl && <button className="gset-btn" onClick={() => run(() => api.updateGroup(group.id, { avatarUrl: null }))} disabled={busy}>Remove</button>}
                                    <input ref={picRef} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickPicture(f); }} />
                                </div>
                            </div>

                            <div className="gset-section">
                                <div className="gset-label">Change banner</div>
                                <div className="gset-row">
                                    <button className="gset-btn" onClick={() => banRef.current?.click()} disabled={busy}>Upload picture</button>
                                    <button className="gset-btn" onClick={resetBanner} disabled={busy}>Reset</button>
                                    <input ref={banRef} type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pickBanner(f); }} />
                                </div>
                                <div className="gset-row gset-colors">
                                    <span>or two colours</span>
                                    <input type="color" value={c1} onChange={e => { setC1(e.target.value); setPreviewColors(true); }} aria-label="First colour" />
                                    <input type="color" value={c2} onChange={e => { setC2(e.target.value); setPreviewColors(true); }} aria-label="Second colour" />
                                    <button className="gset-btn" onClick={saveColors} disabled={busy || !previewColors}>Apply</button>
                                </div>
                            </div>
                        </>
                    )}

                    <div className="gset-foot"><button className="gset-btn" onClick={onClose}>Close</button></div>
                </div>
            </div>
        </div>
    );
}
