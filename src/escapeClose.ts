// Escape does what clicking the X (or outside the window) does: it closes the top-most dialog.
// Every dialog already closes when its dark backdrop is clicked, so the key just clicks the backdrop.
const BACKDROPS = '.modal-overlay, .avatar-lightbox';

export function startEscapeClose() {
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
        if (document.querySelector('.viewer-top')) return; // the picture viewer handles Escape itself
        const open = Array.from(document.querySelectorAll<HTMLElement>(BACKDROPS));
        if (open.length === 0) return;
        // Top-most = highest z-index, and the later one in the page when they are equal
        let top = open[0];
        let topZ = parseInt(getComputedStyle(top).zIndex) || 0;
        for (const el of open.slice(1)) {
            const z = parseInt(getComputedStyle(el).zIndex) || 0;
            if (z >= topZ) { top = el; topZ = z; }
        }
        e.preventDefault();
        top.click();
    });
}
