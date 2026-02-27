const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Game modules are lazy-loaded so a missing/broken module doesn't prevent
// the auto-updater from running (our recovery mechanism).
let fs, Launch, AZauth, copyMod;
let modulesError = null;
try {
    fs = require('fs');
    ({ Launch, AZauth } = require('minecraft-java-core'));
    ({ copyMod } = require('./lib/copyMod'));
} catch (err) {
    modulesError = err.message;
    console.error('[init] Failed to load game modules:', err.message);
    // fs may still be needed for basic operations — try loading it alone
    if (!fs) try { fs = require('fs'); } catch (_) {}
}

app.setName('MatCraft');

const AZAUTH_URL = 'https://matfaction.com';
const MOD_SOURCES = [
    path.resolve(__dirname.replace('app.asar', 'app.asar.unpacked'), 'mods')
];

let mainWindow = null;
let launcher = null;
let GAME_DIR = '';
let authenticatorData = null;
let gameRunning = false;
let tray = null;

function createWindow() {
    GAME_DIR = path.join(app.getPath('appData'), '.matcraft');
    mainWindow = new BrowserWindow({
        width: 500,
        height: 580,
        frame: false,
        resizable: true,
        icon: path.join(__dirname, 'src', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });

    const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

    // Dev: load Vite dev server; Prod: load built files
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
    }
}

function setupAutoUpdater() {
    if (!app.isPackaged) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => {
        console.log('[updater] Checking for update...');
        mainWindow?.webContents.send('updater:checking');
    });
    autoUpdater.on('update-available', (info) => {
        console.log('[updater] Update available:', info.version);
        mainWindow?.webContents.send('updater:update-available', info.version);
    });
    autoUpdater.on('update-not-available', () => {
        console.log('[updater] Already up to date.');
        mainWindow?.webContents.send('updater:not-available');
    });
    autoUpdater.on('download-progress', (progress) => {
        console.log(`[updater] Download: ${Math.round(progress.percent)}%`);
        mainWindow?.webContents.send('updater:download-progress', progress.percent);
    });
    autoUpdater.on('update-downloaded', (info) => {
        console.log('[updater] Update downloaded:', info.version, '— installing now.');
        mainWindow?.webContents.send('updater:update-downloaded');
        setTimeout(() => {
            autoUpdater.quitAndInstall();
        }, 1500);
    });
    autoUpdater.on('error', (err) => {
        console.error('[updater] Error:', err.message);
        mainWindow?.webContents.send('updater:error', err.message);
    });

    autoUpdater.checkForUpdates();
}

app.whenReady().then(() => {
    try {
        createWindow();
    } catch (err) {
        console.error('[init] Window creation failed:', err.message);
    }
    // Auto-updater ALWAYS runs — it's the recovery mechanism
    setupAutoUpdater();
});

app.on('window-all-closed', () => {
    if (!gameRunning) app.quit();
});

// ── Window controls ──
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});
ipcMain.on('window:close', () => {
    if (gameRunning) {
        mainWindow?.hide();
        if (!tray) {
            const iconPath = path.join(__dirname, 'src', 'icon.png');
            tray = new Tray(iconPath);
            tray.setToolTip('MatCraft Launcher');
            const contextMenu = Menu.buildFromTemplate([
                { label: 'Ouvrir MatCraft', click: () => { mainWindow?.show(); } },
                { type: 'separator' },
                { label: 'Quitter', click: () => { gameRunning = false; mainWindow?.close(); app.quit(); } }
            ]);
            tray.setContextMenu(contextMenu);
            tray.on('double-click', () => { mainWindow?.show(); });
        }
    } else {
        authenticatorData = null;
        mainWindow?.close();
    }
});

// ── Window resize (login → launcher) ──
ipcMain.on('window:resize-to-launcher', () => {
    if (!mainWindow) return;
    const { screen } = require('electron');
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const newW = 1280;
    const newH = 760;
    const x = Math.round((screenW - newW) / 2);
    const y = Math.round((screenH - newH) / 2);
    mainWindow.setBounds({ x, y, width: newW, height: newH }, true);
});

// ── AzAuth Login ──
ipcMain.handle('azauth:login', async (_event, email, password) => {
    if (!AZauth) {
        return { success: false, error: 'Module d\'authentification non disponible. Une mise à jour est peut-être en cours.' };
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
        return { success: false, error: 'Entrée invalide.' };
    }
    if (email.length > 254 || password.length > 128) {
        return { success: false, error: 'Entrée trop longue.' };
    }

    try {
        const azauth = new AZauth(AZAUTH_URL);
        const result = await azauth.login(email, password);

        if (result.A2F) {
            return { success: false, error: 'L\'authentification 2FA n\'est pas encore supportée.' };
        }

        if (result.error) {
            let msg = result.message || '';
            if (msg.toLowerCase().includes('invalid credentials')) {
                msg = 'Adresse e-mail ou mot de passe incorrect.';
            }
            return { success: false, error: msg || 'Identifiants incorrects.' };
        }

        // Store full authenticator for minecraft-java-core
        authenticatorData = result;

        return {
            success: true,
            user: {
                username: result.name,
                uuid: result.uuid
            }
        };
    } catch (err) {
        return { success: false, error: err.message || 'Erreur de connexion au serveur.' };
    }
});

// ── Minecraft Launch ──
ipcMain.handle('minecraft:launch', async (_event, config) => {
    if (!Launch || !copyMod || !fs) {
        return { success: false, error: 'Modules de jeu non disponibles. Une mise à jour est peut-être en cours.' };
    }
    const RAM_PATTERN = /^\d{1,5}[MG]$/;
    if (config.minRam && (typeof config.minRam !== 'string' || !RAM_PATTERN.test(config.minRam))) {
        return { success: false, error: 'Format de RAM invalide.' };
    }
    if (config.maxRam && (typeof config.maxRam !== 'string' || !RAM_PATTERN.test(config.maxRam))) {
        return { success: false, error: 'Format de RAM invalide.' };
    }

    try {
        // Ensure game directory exists
        if (!fs.existsSync(GAME_DIR)) {
            fs.mkdirSync(GAME_DIR, { recursive: true });
        }

        // Copy MatCraft mod to mods folder
        copyMod(GAME_DIR, MOD_SOURCES);

        launcher = new Launch();

        // Forward events to renderer
        launcher.on('progress', (progress, size, element) => {
            mainWindow?.webContents.send('launch:progress', progress, size, element);
        });

        launcher.on('speed', (speed) => {
            mainWindow?.webContents.send('launch:speed', speed);
        });

        launcher.on('estimated', (seconds) => {
            mainWindow?.webContents.send('launch:estimated', seconds);
        });

        launcher.on('extract', (fileName) => {
            mainWindow?.webContents.send('launch:extract', fileName);
        });

        launcher.on('patch', (patchName) => {
            mainWindow?.webContents.send('launch:patch', patchName);
        });

        launcher.on('data', (line) => {
            mainWindow?.webContents.send('launch:data', String(line));
        });

        let gameClosed = false;

        launcher.on('close', () => {
            gameClosed = true;
            gameRunning = false;
            mainWindow?.webContents.send('launch:close');
            if (tray) {
                tray.destroy();
                tray = null;
            }
            if (mainWindow && !mainWindow.isVisible()) {
                mainWindow.show();
            }
        });

        launcher.on('error', (err) => {
            if (gameClosed) return;
            mainWindow?.webContents.send('launch:error', String(err).slice(0, 500));
        });

        const launchOptions = {
            authenticator: authenticatorData,
            path: GAME_DIR,
            version: '1.21.11',
            memory: {
                min: config.minRam || '2G',
                max: config.maxRam || '4G'
            },
            loader: {
                type: 'fabric',
                enable: true,
                build: '0.18.4'
            },
            java: {
                version: '21'
            },
            verify: true,
            ignored: [
                'mods',
                'config',
                'options.txt',
                'servers.dat'
            ],
            downloadFileMultiple: 5
        };

        await launcher.Launch(launchOptions);
        gameRunning = true;
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message || 'Erreur lors du lancement.' };
    }
});

