const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Game modules are lazy-loaded so a missing/broken module doesn't prevent
// the auto-updater from running (our recovery mechanism).
let fs, crypto, Launch, AZauth, syncMods, syncConfigs, createModsGuard, verifyFabricLoader, snapshotJavawPids, findNewPid, createDllGuard, createBlacklistGuard;
let modulesError = null;
try {
    fs = require('fs');
    crypto = require('crypto');
    ({ Launch, AZauth } = require('minecraft-java-core'));
    ({ syncMods, syncConfigs, createModsGuard, verifyFabricLoader } = require('./lib/syncMods'));
    ({ snapshotJavawPids, findNewPid, createDllGuard, createBlacklistGuard } = require('./lib/dllGuard'));
} catch (err) {
    modulesError = err.message;
    console.error('[init] Failed to load game modules:', err.message);
    // fs may still be needed for basic operations — try loading it alone
    if (!fs) try { fs = require('fs'); } catch (_) {}
}

app.setName('MatCraft');

const AZAUTH_URL = 'https://matfaction.com';

let mainWindow = null;
let GAME_DIR = '';
let authenticatorData = null;
let tray = null;

// Multi-instance support: each running game is tracked by account UUID
const activeInstances = new Map(); // instanceId (uuid) -> { launcher, modsGuard, dllGuard }

function createWindow() {
    GAME_DIR = path.join(app.getPath('appData'), '.matcraft');

    // ASAR integrity check (production only)
    if (app.isPackaged) {
        const asarPath = path.join(process.resourcesPath, 'app.asar');
        const integrityPath = path.join(process.resourcesPath, 'asar-integrity.json');
        try {
            const expected = JSON.parse(fs.readFileSync(integrityPath, 'utf8')).sha256;
            const actual = crypto.createHash('sha256')
                .update(fs.readFileSync(asarPath))
                .digest('hex');
            if (actual !== expected) {
                const { dialog } = require('electron');
                dialog.showErrorBox('Erreur', 'Fichiers de l\'application corrompus. Veuillez réinstaller le launcher.');
                app.quit();
                return;
            }
        } catch {
            // Si le fichier d'intégrité manque, on laisse passer (rétro-compatibilité)
        }
    }

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

    // Disable DevTools in production
    if (!isDev) {
        mainWindow.webContents.on('devtools-opened', () => {
            mainWindow.webContents.closeDevTools();
        });
    }

    // Block external navigation and new windows
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('http://localhost:') && !url.startsWith('file://')) {
            event.preventDefault();
        }
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
    if (activeInstances.size === 0) app.quit();
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
    if (activeInstances.size > 0) {
        mainWindow?.hide();
        if (!tray) {
            const iconPath = path.join(__dirname, 'src', 'icon.png');
            tray = new Tray(iconPath);
            tray.setToolTip('MatCraft Launcher');
            const contextMenu = Menu.buildFromTemplate([
                { label: 'Ouvrir MatCraft', click: () => { mainWindow?.show(); } },
                { type: 'separator' },
                { label: 'Quitter', click: () => {
                    // Stop all instances
                    for (const [, inst] of activeInstances) {
                        if (inst.dllGuard) inst.dllGuard.stop();
                        if (inst.modsGuard) inst.modsGuard.stop();
                    }
                    activeInstances.clear();
                    mainWindow?.close();
                    app.quit();
                } }
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
        const msg = err.message || '';
        if (msg.includes('Unexpected token') || msg.includes('is not valid JSON') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
            return { success: false, error: 'Serveur de login non accessible. Réessaie dans quelques minutes.' };
        }
        return { success: false, error: msg || 'Erreur de connexion au serveur.' };
    }
});

// ── Repair ──
ipcMain.handle('app:repair', async () => {
    if (!app.isPackaged) {
        return { success: false, error: 'Réparation non disponible en mode développement.' };
    }
    try {
        autoUpdater.currentVersion = '0.0.0';
        await autoUpdater.checkForUpdates();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message || 'Échec de la réparation.' };
    }
});

// ── Minecraft Launch ──
ipcMain.handle('minecraft:launch', async (_event, config) => {
    if (!Launch || !syncMods || !syncConfigs || !createModsGuard || !verifyFabricLoader || !fs) {
        return { success: false, error: 'Modules de jeu non disponibles. Une mise à jour est peut-être en cours.' };
    }
    const RAM_PATTERN = /^\d{1,5}[MG]$/;
    if (config.minRam && (typeof config.minRam !== 'string' || !RAM_PATTERN.test(config.minRam))) {
        return { success: false, error: 'Format de RAM invalide.' };
    }
    if (config.maxRam && (typeof config.maxRam !== 'string' || !RAM_PATTERN.test(config.maxRam))) {
        return { success: false, error: 'Format de RAM invalide.' };
    }

    // Use the account UUID as the instance identifier
    const instanceId = authenticatorData?.uuid;
    if (!instanceId) {
        return { success: false, error: 'Aucun compte connecté.' };
    }

    // Prevent launching twice on the same account
    if (activeInstances.has(instanceId)) {
        return { success: false, error: 'Ce compte a déjà une instance en cours.' };
    }

    let instanceModsGuard = null;

    try {
        // Ensure game directory exists
        if (!fs.existsSync(GAME_DIR)) {
            fs.mkdirSync(GAME_DIR, { recursive: true });
        }

        // Diagnostic logger: sends to both Node console and launcher UI console panel
        const diagLog = (msg) => {
            const line = `[diag] ${msg}`;
            console.log(line);
            mainWindow?.webContents.send('launch:data', line, instanceId);
        };

        // Check if another launcher process already has a game running
        const lockFile = path.join(GAME_DIR, '.matcraft.lock');
        const lockFileExists = fs.existsSync(lockFile);
        const isFirstInstance = !lockFileExists && activeInstances.size === 0;
        diagLog(`START isFirstInstance=${isFirstInstance} lockFileExists=${lockFileExists} activeInstances=${activeInstances.size}`);

        // Write lock file immediately so other launches (including same process)
        // know to skip heavy verification
        if (isFirstInstance) {
            try { fs.writeFileSync(lockFile, instanceId); } catch {}
        }

        // Sync mods with server manifest (anti-cheat)
        // Non-first instances skip hashing to avoid blocking on Windows file locks
        const MODS_BASE_URL = `${AZAUTH_URL}/launcher`;
        const sendSyncProgress = (phase, current, total, modName) => {
            mainWindow?.webContents.send('launch:sync-progress', { phase, current, total, modName, instanceId });
        };
        diagLog(`syncMods START (skipVerify=${!isFirstInstance})`);
        const allowedMods = await syncMods(GAME_DIR, MODS_BASE_URL, sendSyncProgress, {
            skipVerify: !isFirstInstance
        });
        diagLog('syncMods DONE');

        // Sync FancyMenu configs from server
        diagLog('syncConfigs START');
        await syncConfigs(GAME_DIR, MODS_BASE_URL, sendSyncProgress);
        diagLog('syncConfigs DONE');

        // Start watching the mods directory for unauthorized changes
        // All instances get a watcher; only the first does the initial hash verify
        // (subsequent instances skip it to avoid blocking on Windows file locks)
        const modsDir = path.join(GAME_DIR, 'mods');
        diagLog(`createModsGuard (skipInitialVerify=${!isFirstInstance})`);
        instanceModsGuard = createModsGuard(modsDir, allowedMods, {
            skipInitialVerify: !isFirstInstance
        });

        const launcher = new Launch();

        // Forward events to renderer (tagged with instanceId)
        launcher.on('progress', (progress, size, element) => {
            mainWindow?.webContents.send('launch:progress', progress, size, element, instanceId);
        });

        launcher.on('speed', (speed) => {
            mainWindow?.webContents.send('launch:speed', speed, instanceId);
        });

        launcher.on('estimated', (seconds) => {
            mainWindow?.webContents.send('launch:estimated', seconds, instanceId);
        });

        launcher.on('extract', (fileName) => {
            mainWindow?.webContents.send('launch:extract', fileName, instanceId);
        });

        launcher.on('patch', (patchName) => {
            mainWindow?.webContents.send('launch:patch', patchName, instanceId);
        });

        launcher.on('data', (line) => {
            mainWindow?.webContents.send('launch:data', String(line), instanceId);
        });

        let gameClosed = false;

        launcher.on('close', () => {
            gameClosed = true;
            const inst = activeInstances.get(instanceId);
            if (inst?.dllGuard) { inst.dllGuard.stop(); }
            if (inst?.modsGuard) { inst.modsGuard.stop(); }
            activeInstances.delete(instanceId);
            // Remove lock file if no more instances in this process
            if (activeInstances.size === 0) {
                try { fs.unlinkSync(path.join(GAME_DIR, '.matcraft.lock')); } catch {}
            }
            mainWindow?.webContents.send('launch:close', instanceId);
            if (activeInstances.size === 0) {
                if (tray) {
                    tray.destroy();
                    tray = null;
                }
                if (mainWindow && !mainWindow.isVisible()) {
                    mainWindow.show();
                }
            }
        });

        launcher.on('error', (err) => {
            if (gameClosed) return;
            mainWindow?.webContents.send('launch:error', String(err).slice(0, 500), instanceId);
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
                'saves',
                'resourcepacks',
                'shaderpacks',
                'screenshots',
                'logs',
                'log_configs',
                'zoomify.json',
                'options.txt',
                'servers.dat'
            ],
            JVM_ARGS: [
                '-XX:+DisableAttachMechanism'
            ],
            downloadFileMultiple: 5
        };

        // Final integrity check right before launching
        // Skip if another launcher already verified — files may be locked by Java on Windows
        if (isFirstInstance) {
            diagLog('pre-launch verify START');
            await instanceModsGuard.verify();
            await verifyFabricLoader(GAME_DIR);
            diagLog('pre-launch verify DONE');
        } else {
            diagLog('pre-launch verify SKIPPED (not first instance)');
        }

        // Snapshot java PIDs before launch (cross-platform)
        let pidsBefore = null;
        if (snapshotJavawPids) {
            pidsBefore = await snapshotJavawPids();
        }

        diagLog('launcher.Launch START');
        await launcher.Launch(launchOptions);
        diagLog('launcher.Launch DONE');

        // Track this instance
        activeInstances.set(instanceId, { launcher, modsGuard: instanceModsGuard, dllGuard: null });

        // Start anti-cheat guard after launch
        if (pidsBefore && findNewPid) {
            const onViolation = (violation) => {
                let message;
                if (violation.startsWith('dll:')) {
                    message = 'Un logiciel non autorisé a été détecté (injection DLL). Le jeu a été fermé.';
                } else if (violation.startsWith('overlay:')) {
                    message = 'Un overlay suspect a été détecté. Le jeu a été fermé.';
                } else if (violation.startsWith('blacklist:')) {
                    message = 'Un logiciel interdit a été détecté. Le jeu a été fermé.';
                } else {
                    message = 'Violation anti-triche détectée. Le jeu a été fermé.';
                }
                mainWindow?.webContents.send('launch:error', message, instanceId);
            };

            findNewPid(pidsBefore).then((pid) => {
                if (!pid || !activeInstances.has(instanceId)) return;
                const inst = activeInstances.get(instanceId);
                if (process.platform === 'win32' && createDllGuard) {
                    // Windows: full guard (DLL + overlay + blacklist via .exe worker)
                    inst.dllGuard = createDllGuard(pid, { onViolation });
                } else if (createBlacklistGuard) {
                    // macOS/Linux: blacklist-only guard (native JS)
                    inst.dllGuard = createBlacklistGuard(pid, { onViolation });
                }
            }).catch(() => {});
        }

        return { success: true };
    } catch (err) {
        if (instanceModsGuard) { instanceModsGuard.stop(); }
        // Clean up from map if it was added
        const inst = activeInstances.get(instanceId);
        if (inst) {
            if (inst.dllGuard) inst.dllGuard.stop();
            activeInstances.delete(instanceId);
        }
        return { success: false, error: err.message || 'Erreur lors du lancement.' };
    }
});

