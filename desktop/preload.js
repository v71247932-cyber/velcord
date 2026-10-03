const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('velcordDesktop', {
    isDesktop: true,
    shellVersion: 2, // 2 = window without title bar
    platform: process.platform,
    focus: () => ipcRenderer.send('window:focus'),
    setBadge: (count) => ipcRenderer.send('app:badge', count),
    checkPermissions: () => ipcRenderer.invoke('permissions:check'),
    retry: () => { const u = new URLSearchParams(location.search).get('url'); if (u) location.href = u; },
});
