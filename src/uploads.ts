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
