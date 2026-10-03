import { useCallback, useRef, useState } from 'react';
import { isVideoFile, uploadAsMessage, uploadVideoAsMessage } from './uploads';

/** Sending pictures and video clips: progress, cancel, and the message content once uploaded. */
export function useAttach(send: (content: string) => Promise<void>) {
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<number | null>(null); // 0..1 for clips
    const [label, setLabel] = useState('');
    const abort = useRef<AbortController | null>(null);

    const attach = useCallback(async (file: File) => {
        if (uploading) return;
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
            setUploading(false);
            setProgress(null);
        }
    }, [uploading, send]);

    const cancel = useCallback(() => abort.current?.abort(), []);

    return { uploading, progress, label, attach, cancel };
}
