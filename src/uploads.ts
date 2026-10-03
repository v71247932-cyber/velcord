import { api } from './api';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // what the user may pick
const SERVER_LIMIT = 1_250_000; // what we actually send (server stores up to 1.3 MB)
const MAX_SIDE = 1600;

function loadImage(file: Blob): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image')); };
        img.src = url;
    });
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) =>
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', quality));
}

/** Shrinks any image (up to 10 MB) so it fits the server limit, keeping the aspect ratio. */
export async function prepareImage(file: File): Promise<Blob> {
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('File too large (max 10 MB)');
    if (file.type === 'image/gif' && file.size <= SERVER_LIMIT) return file; // keep animation

    const img = await loadImage(file);
    let scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    for (let attempt = 0; attempt < 6; attempt++) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const q of [0.86, 0.72, 0.58]) {
            const blob = await toBlob(canvas, q);
            if (blob.size <= SERVER_LIMIT) return blob;
        }
        scale *= 0.75;
    }
    throw new Error('Could not shrink this image enough');
}

export const IMAGE_TOKEN = /^\[img:([a-f0-9]{32})\]$/;

/** Uploads an image and returns the message content that references it. */
export async function uploadAsMessage(file: File): Promise<string> {
    const blob = await prepareImage(file);
    const { id } = await api.uploadImage(blob);
    return `[img:${id}]`;
}

/** Crops to a centered square and shrinks to `size` px; used for profile and group pictures. */
export async function squareImageDataUrl(file: File, size = 256): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('File too large (max 10 MB)');
    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.88);
}


// ------------------------------------------------------------------ video clips
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const VIDEO_TOKEN = /^\[vid:([a-f0-9]{32})\]$/;
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'];

function videoMime(file: File): string {
    if (VIDEO_TYPES.includes(file.type)) return file.type;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'mp4') return 'video/mp4';
    if (ext === 'm4v') return 'video/x-m4v';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'webm') return 'video/webm';
    if (ext === 'ogv' || ext === 'ogg') return 'video/ogg';
    return '';
}

export const isVideoFile = (file: File) => file.type.startsWith('video/') || videoMime(file) !== '';

function putChunk(id: string, n: number, blob: Blob, onBytes: (loaded: number) => void, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `${import.meta.env.VITE_API_URL || ''}/api/videos/${id}/chunks/${n}`);
        const token = localStorage.getItem('velcord_token');
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = e => onBytes(e.loaded);
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
            let msg = 'Upload failed';
            try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
            reject(Object.assign(new Error(msg), { permanent: xhr.status >= 400 && xhr.status < 500 }));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { permanent: true }));
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(blob);
    });
}

/** Uploads a clip (max 200 MB) in 5 MB pieces and returns the message content that references it. */
export async function uploadVideoAsMessage(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<string> {
    const mime = videoMime(file);
    if (!mime) throw new Error('Unsupported video type. Use MP4, MOV or WebM.');
    if (file.size > VIDEO_MAX_BYTES) throw new Error('Video too large (max 200 MB)');
    if (file.size === 0) throw new Error('This file is empty');

    const { id, chunkSize, chunks } = await api.initVideo(file.size, mime);
    for (let n = 0; n < chunks; n++) {
        const blob = file.slice(n * chunkSize, Math.min(file.size, (n + 1) * chunkSize));
        for (let attempt = 1; ; attempt++) {
            try {
                await putChunk(id, n, blob, loaded => onProgress((n * chunkSize + loaded) / file.size), signal);
                break;
            } catch (e: any) {
                if (e.permanent || attempt >= 3 || signal.aborted) throw e;
                await new Promise(r => setTimeout(r, 600 * attempt)); // brief pause, then retry the same piece
            }
        }
        onProgress(Math.min(1, ((n + 1) * chunkSize) / file.size));
    }
    await api.completeVideo(id);
    return `[vid:${id}]`;
}


/** Crops an image to fill w x h (like CSS "cover") and returns it as a small JPEG data URL. */
export async function coverImageDataUrl(file: File, w = 720, h = 240): Promise<string> {
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file');
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('File too large (max 10 MB)');
    const img = await loadImage(file);
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const sw = w / scale, sh = h / scale;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.86);
}
