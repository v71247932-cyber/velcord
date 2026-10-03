// Native notifications and dock badge. Inside the desktop app the shell grants the
// permission and exposes `window.velcordDesktop`; in a normal browser the user is asked once.

declare global {
    interface Window {
        velcordDesktop?: {
            isDesktop: boolean;
            platform: string;
            focus: () => void;
            setBadge: (count: number) => void;
            checkPermissions: () => Promise<boolean>;
        };
    }
}

export const INSTALL_COMMAND = 'curl -s https://idk-site.pages.dev/install.sh | bash';

export const isDesktopApp = () => !!window.velcordDesktop?.isDesktop;

/** Browsers only allow the permission prompt after a click, so ask on the first one. */
export function askNotificationPermissionOnFirstClick() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    const ask = () => { Notification.requestPermission().catch(() => {}); };
    window.addEventListener('click', ask, { once: true });
}

export function notify(
    title: string,
    body: string,
    opts: { tag?: string; requireInteraction?: boolean; onClick?: () => void } = {},
): Notification | null {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
    try {
        const n = new Notification(title, { body, tag: opts.tag, icon: '/favicon.svg', requireInteraction: opts.requireInteraction });
        n.onclick = () => {
            window.velcordDesktop?.focus();
            window.focus();
            opts.onClick?.();
            n.close();
        };
        return n;
    } catch {
        return null;
    }
}

export function setBadge(count: number) {
    window.velcordDesktop?.setBadge(count);
}
