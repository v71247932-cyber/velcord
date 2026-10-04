// Velcord desktop: a thin native shell around the Velcord web app.
// It adds what a browser tab cannot do well: native notifications, microphone and
// screen-share permissions asked up front, a screen picker, a dock/taskbar badge.
const {
    app, BrowserWindow, Menu, Notification, shell, session, systemPreferences,
    desktopCapturer, dialog, ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_URL = 'https://idk-site.pages.dev/app';
const OLD_ORIGIN = 'https://idk-site.pages.dev'; // the old address still serves the page
const NEW_ORIGIN = 'https://velcord.scrisoricupovesti.ro';
const isOurs = (origin) => origin === ORIGIN || origin === OLD_ORIGIN || origin === NEW_ORIGIN;

function readConfig() {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
    catch { return {}; }
}
const APP_URL = process.env.VELCORD_URL || readConfig().url || DEFAULT_URL;
const ORIGIN = new URL(APP_URL).origin;
const IS_MAC = process.platform === 'darwin';

app.setName('Velcord');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;

// ---------------------------------------------------------------- window

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#313338',
        title: '',
        icon: path.join(__dirname, 'icon.png'),
        // No title bar text. On macOS the window keeps its rounded corners and the red/yellow/green
        // buttons sit on top of the page. Elsewhere the window buttons are drawn over the page too.
        titleBarStyle: 'hidden',
        ...(IS_MAC
            ? { trafficLightPosition: { x: 14, y: 8 } }
            : { titleBarOverlay: { color: '#1e1f22', symbolColor: '#b5bac1', height: 28 } }),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
            backgroundThrottling: false, // keep calls and polling alive when the window is hidden
        },
    });

    win.setTitle('');
    win.on('page-title-updated', (e) => e.preventDefault()); // keep the title empty
    win.once('ready-to-show', () => win.show());
    win.loadURL(APP_URL);

    win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: APP_URL } });
    });

    // Links leave the app and open in the normal browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file:') && new URL(url).origin !== ORIGIN && new URL(url).origin !== OLD_ORIGIN) {
            e.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        }
    });

    win.on('closed', () => { win = null; });
}

function showWindow() {
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

// ---------------------------------------------------------------- permissions

const ALLOWED = new Set([
    'media', 'audioCapture', 'videoCapture', 'display-capture',
    'notifications', 'fullscreen', 'clipboard-sanitized-write',
]);

// A small log next to the app's data, to see why something failed (Velcord > Open log in the menu)
function log(...parts) {
    try {
        const line = `${new Date().toISOString()} ${parts.map(p => (p && p.stack) ? p.stack : (typeof p === 'object' ? JSON.stringify(p) : String(p))).join(' ')}\n`;
        fs.appendFileSync(path.join(app.getPath('userData'), 'velcord-desktop.log'), line);
    } catch { /* ignore */ }
}

function originOf(urlLike) {
    try { return new URL(urlLike).origin; } catch { return ''; }
}

function setupSession() {
    const ses = session.defaultSession;

    // Present as a normal Chrome plus a marker the web app can recognise
    const ua = ses.getUserAgent()
        .replace(/\s*Electron\/\S+/i, '')
        .replace(/\s*velcord\S*\/\S+/i, '');
    ses.setUserAgent(`${ua} VelcordDesktop/1.0`);

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        const origin = originOf(details && details.requestingUrl ? details.requestingUrl : wc.getURL());
        if (!(isOurs(origin) && ALLOWED.has(permission))) { callback(false); return; }
        if (!IS_MAC || permission !== 'media') { callback(true); return; }
        // The microphone and the camera are asked for only now, when a call really uses them
        (async () => {
            const types = (details && details.mediaTypes) || [];
            let ok = true;
            for (const [type, device] of [['audio', 'microphone'], ['video', 'camera']]) {
                if (!types.includes(type)) continue;
                try {
                    if (systemPreferences.getMediaAccessStatus(device) !== 'granted') ok = (await systemPreferences.askForMediaAccess(device)) && ok;
                } catch (e) { log('media access failed', device, e); }
            }
            callback(ok);
        })();
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => (
        isOurs(originOf(requestingOrigin)) && ALLOWED.has(permission)
    ));

    // getDisplayMedia(): always our own picker, so it works the same on every macOS version
    ses.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
            if (IS_MAC && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
                // Looking at the screens once makes macOS show its permission prompt
                try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch (e) { log('getSources probe failed', e); }
                const status = systemPreferences.getMediaAccessStatus('screen');
                log('screen access status', status);
                if (status !== 'granted') {
                    await explainScreenPermission();
                    callback({});
                    return;
                }
            }
            const source = await pickSource();
            if (!source) { callback({}); return; }
            callback({ video: source });
        } catch (e) {
            log('display media request failed', e);
            callback({});
        }
    }, { useSystemPicker: false });
}

function statePath() { return path.join(app.getPath('userData'), 'desktop-state.json'); }
function readState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } }
function writeState(patch) {
    try { fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch })); } catch { /* ignore */ }
}

async function explainScreenPermission() {
    const { response } = await dialog.showMessageBox(win || undefined, {
        type: 'info',
        buttons: ['Open System Settings', 'Restart Velcord', 'Not now'],
        defaultId: 0,
        cancelId: 2,
        title: 'Screen sharing needs permission',
        message: 'Allow Velcord to record your screen',
        detail: '1. Press "Open System Settings" and turn Velcord on in Screen & System Audio Recording.\n2. Come back and press "Restart Velcord" (macOS needs a restart of the app once). Then share again.',
    });
    if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    if (response === 1) { app.relaunch(); app.exit(0); }
}

// Asks for everything once, right after install, so nothing interrupts the first call.
async function askForPermissions({ force = false } = {}) {
    if (!force && readState().permissionsAsked) return;

    const result = { microphone: 'unknown', screen: 'unknown', notifications: 'unknown' };

    // Only the explicit "Check permissions" asks for the microphone and the screen up front.
    // On the first start just the notifications are asked for; the rest comes when a call needs it.
    if (IS_MAC && force) {
        try {
            const ok = await systemPreferences.askForMediaAccess('microphone');
            result.microphone = ok ? 'granted' : 'denied';
        } catch { /* ignore */ }

        try {
            // Capturing once makes macOS list Velcord under Screen Recording and show its prompt
            if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
                await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
            }
            result.screen = systemPreferences.getMediaAccessStatus('screen');
        } catch { /* ignore */ }
    } else {
        result.microphone = 'granted';
        result.screen = 'granted';
    }

    if (Notification.isSupported()) {
        try {
            const n = new Notification({ title: 'Velcord', body: 'Notifications are on. You will see calls and new messages here.' });
            n.on('click', showWindow);
            n.show();
            result.notifications = 'shown';
        } catch { /* ignore */ }
    }

    writeState({ permissionsAsked: true });

    if (IS_MAC && force && result.screen !== 'granted') {
        // The screen prompt can only be answered in System Settings the first time
        await explainScreenPermission();
    }
}

// ---------------------------------------------------------------- screen picker

function pickSource() {
    return new Promise(async (resolve) => {
        let sources = [];
        try {
            sources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                thumbnailSize: { width: 480, height: 300 },
                fetchWindowIcons: false,
            });
        } catch (e) { log('getSources failed', e); }
        if (!sources.length) {
            log('no screens or windows were returned');
            dialog.showMessageBox(win || undefined, {
                type: 'warning', buttons: ['Open System Settings', 'Close'], defaultId: 0, cancelId: 1,
                title: 'Screen sharing',
                message: 'Velcord cannot see any screen',
                detail: 'In System Settings > Privacy & Security > Screen & System Audio Recording, select Velcord and press the minus button, then press plus and add Velcord from the Applications folder. Quit Velcord completely (Cmd+Q) and open it again.',
            }).then(({ response }) => { if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'); });
            resolve(null);
            return;
        }

        const items = sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen: s.id.startsWith('screen:') }));
        const byId = new Map(sources.map(s => [s.id, s]));
        let settled = false;

        const picker = new BrowserWindow({
            parent: win || undefined,
            modal: !!win,
            width: 800,
            height: 580,
            resizable: false,
            minimizable: false,
            maximizable: false,
            title: 'Share your screen',
            backgroundColor: '#2b2d31',
            autoHideMenuBar: true,
            webPreferences: {
                contextIsolation: true,
                sandbox: true,
                preload: path.join(__dirname, 'picker-preload.js'),
            },
        });

        const finish = (id) => {
            if (settled) return;
            settled = true;
            ipcMain.removeHandler('picker:sources');
            ipcMain.removeAllListeners('picker:choose');
            if (!picker.isDestroyed()) picker.close();
            resolve(id ? byId.get(id) || null : null);
        };

        ipcMain.handle('picker:sources', () => items);
        ipcMain.on('picker:choose', (_e, id) => finish(id));
        picker.on('closed', () => finish(null));
        picker.loadFile(path.join(__dirname, 'picker.html'));
    });
}

// ---------------------------------------------------------------- ipc from the web app

ipcMain.on('window:focus', showWindow);
ipcMain.on('app:badge', (_e, count) => {
    const n = Math.max(0, Math.min(999, Number(count) || 0));
    app.setBadgeCount(n);
});
ipcMain.handle('permissions:check', async () => { await askForPermissions({ force: true }); return true; });

// ---------------------------------------------------------------- menu + lifecycle

function buildMenu() {
    const template = [
        ...(IS_MAC ? [{
            label: 'Velcord',
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { label: 'Check permissions…', click: () => askForPermissions({ force: true }) },
                { label: 'Open log', click: () => shell.openPath(path.join(app.getPath('userData'), 'velcord-desktop.log')) },
                { type: 'separator' },
                { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        }] : []),
        { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
        ...(!IS_MAC ? [{ label: 'Help', submenu: [{ label: 'Check permissions…', click: () => askForPermissions({ force: true }) }] }] : []),
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });

app.whenReady().then(async () => {
    setupSession();
    buildMenu();
    createWindow();

    if (process.env.VELCORD_SMOKE) {
        // Used by the installer tests: load the page, report, quit
        win.webContents.once('did-finish-load', async () => {
            const title = await win.webContents.executeJavaScript('document.title');
            const ua = await win.webContents.executeJavaScript('navigator.userAgent');
            console.log('SMOKE title=' + title);
            console.log('SMOKE ua=' + ua);
            console.log('SMOKE bridge=' + await win.webContents.executeJavaScript('JSON.stringify(window.velcordDesktop && {d: window.velcordDesktop.isDesktop})'));
            app.quit();
        });
        return;
    }

    // Wait for the window so the permission dialogs appear on top of it
    win.once('show', () => setTimeout(() => askForPermissions(), 800));
});
