import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
    file: File;
    title?: string;
    onCancel: () => void;
    /** Called with the cropped 720x240 picture as a data URL */
    onConfirm: (dataUrl: string) => Promise<void> | void;
}

const RATIO = 3; // banners are 3 : 1
const OUT_W = 720;
const OUT_H = 240;

/** Lets the user pick which part of a picture becomes the banner: drag to move, slider or wheel to zoom. */
export default function BannerCropModal({ file, title = 'Choose the banner area', onCancel, onConfirm }: Props) {
    const url = useMemo(() => URL.createObjectURL(file), [file]);
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [zoom, setZoom] = useState(1);
    const [off, setOff] = useState({ x: 0, y: 0 }); // image centre relative to the frame centre, in frame pixels
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const frameRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
    const [frame, setFrame] = useState({ w: 540, h: 180 });

    useEffect(() => {
        const i = new Image();
        i.onload = () => setImg(i);
        i.onerror = () => setError('Could not read this image');
        i.src = url;
        return () => URL.revokeObjectURL(url);
    }, [url]);

    useEffect(() => {
        const measure = () => {
            const w = Math.min(540, Math.max(240, window.innerWidth - 80));
            setFrame({ w, h: Math.round(w / RATIO) });
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);

    // Scale at zoom 1: the picture just covers the frame
    const base = img ? Math.max(frame.w / img.naturalWidth, frame.h / img.naturalHeight) : 1;
    const scale = base * zoom;

    const clamp = (o: { x: number; y: number }, sc: number) => {
        if (!img) return o;
        const maxX = Math.max(0, (img.naturalWidth * sc - frame.w) / 2);
        const maxY = Math.max(0, (img.naturalHeight * sc - frame.h) / 2);
        return { x: Math.min(maxX, Math.max(-maxX, o.x)), y: Math.min(maxY, Math.max(-maxY, o.y)) };
    };

    const changeZoom = (z: number) => {
        const next = Math.min(4, Math.max(1, z));
        setZoom(next);
        setOff(o => clamp(o, base * next));
    };

    const onPointerDown = (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (!drag.current) return;
        setOff(clamp({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y }, scale));
    };
    const onPointerUp = () => { drag.current = null; };

    useEffect(() => { // wheel needs a non-passive listener to stop the page from scrolling
        const el = frameRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => { e.preventDefault(); changeZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    });

    async function confirm() {
        if (!img) return;
        setBusy(true);
        setError('');
        try {
            const left = frame.w / 2 + off.x - (img.naturalWidth * scale) / 2; // picture's left edge inside the frame
            const top = frame.h / 2 + off.y - (img.naturalHeight * scale) / 2;
            const canvas = document.createElement('canvas');
            canvas.width = OUT_W;
            canvas.height = OUT_H;
            const ctx = canvas.getContext('2d')!;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, -left / scale, -top / scale, frame.w / scale, frame.h / scale, 0, 0, OUT_W, OUT_H);
            await onConfirm(canvas.toDataURL('image/jpeg', 0.88));
        } catch (e: any) {
            setError(e?.message || 'Could not save the banner');
            setBusy(false);
        }
    }

    return (
        <div className="modal-overlay" style={{ zIndex: 2500 }} onClick={() => !busy && onCancel()}>
            <div className="modal-content crop-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header"><h2>{title}</h2></div>
                <div className="modal-body">
                    <p className="crop-hint">Drag the picture to move it. Use the slider or the mouse wheel to zoom.</p>
                    <div
                        ref={frameRef}
                        className="crop-frame"
                        style={{ width: frame.w, height: frame.h }}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                    >
                        {img && (
                            <img
                                src={url}
                                alt=""
                                draggable={false}
                                style={{
                                    width: img.naturalWidth * scale,
                                    height: img.naturalHeight * scale,
                                    transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`,
                                }}
                            />
                        )}
                    </div>
                    <div className="crop-zoom">
                        <span>Zoom</span>
                        <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={e => changeZoom(parseFloat(e.target.value))} />
                    </div>
                    {error && <div className="crop-error">{error}</div>}
                </div>
                <div className="modal-footer">
                    <button className="btn-link" onClick={onCancel} disabled={busy}>Cancel</button>
                    <button className="btn-primary" onClick={confirm} disabled={busy || !img}>{busy ? 'Saving…' : 'Use this area'}</button>
                </div>
            </div>
        </div>
    );
}
