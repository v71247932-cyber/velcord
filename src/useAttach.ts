import { useCallback, useEffect, useRef, useState } from 'react';
import { isVideoFile, uploadAsMessage, uploadVideoAsMessage } from './uploads';

/** Sending pictures and video clips: progress, cancel, and the message content once uploaded. */
export function useAttach(send: (content: string) => Promise<void>) {
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<number | null>(null); // 0..1 for clips
    const [label, setLabel] = useState('');
    const abort = useRef<AbortController | null>(null);
    const busy = useRef(false); // a ref, so several dropped files can be sent one after another

    const attach = useCallback(async (file: File) => {
        if (busy.current) return;
        busy.current = true;
        setUploading(true);
        setLabel(file.name);
        try {
            if (isVideoFile(file)) {
                abort.current = new AbortController();
                setProgress(0);
                const content = await uploadVideoAsMessage(file, setProgress, abort.current.signal);
                await send(content);
            } else {
                setProgress(null);
                await send(await uploadAsMessage(file));
            }
        } catch (e: any) {
            if (e?.message !== 'Upload cancelled') alert(e?.message || 'Upload failed');
        } finally {
            abort.current = null;
            busy.current = false;
            setUploading(false);
            setProgress(null);
        }
    }, [send]);

    const cancel = useCallback(() => abort.current?.abort(), []);

    return { uploading, progress, label, attach, cancel };
}


const isMedia = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/') || isVideoFile(f);

/** Drag pictures or clips from the computer onto the chat to send them. */
export function useDropZone(attach: (file: File) => Promise<void>, enabled = true) {
    const [dragging, setDragging] = useState(false);
    const depth = useRef(0);
    const latest = useRef(attach);
    latest.current = attach;

    // A file dropped next to the chat would make the browser open it and leave the app
    useEffect(() => {
        const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
        window.addEventListener('dragover', stop);
        window.addEventListener('drop', stop);
        return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
    }, []);

    const hasFiles = (e: React.DragEvent) => enabled && Array.from(e.dataTransfer.types).includes('Files');

    const zoneProps = {
        onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setDragging(true); },
        onDragOver: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
        onDragLeave: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setDragging(false);
        },
        onDrop: async (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current = 0;
            setDragging(false);
            const files = Array.from(e.dataTransfer.files).filter(isMedia);
            if (files.length === 0) { alert('Drop a picture or a video.'); return; }
            for (const f of files.slice(0, 5)) await latest.current(f); // one after another
        },
    };
    return { dragging, zoneProps };
}
