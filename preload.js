const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
    // Auth
    login: (email, password) => ipcRenderer.invoke('azauth:login', email, password),

    // Launch
    launchGame: (config) => ipcRenderer.invoke('minecraft:launch', config),

    // Events from main process (return cleanup functions)
    onProgress: (cb) => {
        const handler = (_e, progress, size, element) => cb(progress, size, element);
        ipcRenderer.on('launch:progress', handler);
        return () => ipcRenderer.removeListener('launch:progress', handler);
    },
    onSpeed: (cb) => {
        const handler = (_e, speed) => cb(speed);
        ipcRenderer.on('launch:speed', handler);
        return () => ipcRenderer.removeListener('launch:speed', handler);
    },
    onEstimated: (cb) => {
        const handler = (_e, seconds) => cb(seconds);
        ipcRenderer.on('launch:estimated', handler);
        return () => ipcRenderer.removeListener('launch:estimated', handler);
    },
    onExtract: (cb) => {
        const handler = (_e, fileName) => cb(fileName);
        ipcRenderer.on('launch:extract', handler);
        return () => ipcRenderer.removeListener('launch:extract', handler);
    },
    onPatch: (cb) => {
        const handler = (_e, patchName) => cb(patchName);
        ipcRenderer.on('launch:patch', handler);
        return () => ipcRenderer.removeListener('launch:patch', handler);
    },
    onData: (cb) => {
        const handler = (_e, line) => cb(line);
        ipcRenderer.on('launch:data', handler);
        return () => ipcRenderer.removeListener('launch:data', handler);
    },
    onClose: (cb) => {
        const handler = () => cb();
        ipcRenderer.on('launch:close', handler);
        return () => ipcRenderer.removeListener('launch:close', handler);
    },
    onError: (cb) => {
        const handler = (_e, err) => cb(err);
        ipcRenderer.on('launch:error', handler);
        return () => ipcRenderer.removeListener('launch:error', handler);
    },

    // Window controls
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    resizeToLauncher: () => ipcRenderer.send('window:resize-to-launcher')
});
