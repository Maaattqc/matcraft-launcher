const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const { PsWorker } = require('./psWorker');

/**
 * Get the set of PIDs for all running java/javaw processes.
 * Cross-platform: tasklist.exe on Windows, pgrep on macOS/Linux.
 * @returns {Promise<Set<number>>}
 */
async function snapshotJavawPids() {
    try {
        if (process.platform === 'win32') {
            return new Promise((resolve) => {
                const pids = new Set();
                let remaining = 2;
                const done = () => { if (--remaining === 0) resolve(pids); };

                for (const name of ['java.exe', 'javaw.exe']) {
                    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
                        { timeout: 5000, windowsHide: true }, (err, stdout) => {
                            if (!err && stdout) {
                                for (const line of stdout.split('\n')) {
                                    const m = line.match(/^"[^"]+","(\d+)"/);
                                    if (m) pids.add(parseInt(m[1], 10));
                                }
                            }
                            done();
                        });
                }
            });
        } else {
            // macOS/Linux: use pgrep to find java processes
            return new Promise((resolve) => {
                execFile('pgrep', ['-f', 'java'], { timeout: 5000 }, (err, stdout) => {
                    const pids = new Set();
                    if (!err && stdout) {
                        for (const line of stdout.split('\n')) {
                            const n = parseInt(line.trim(), 10);
                            if (!isNaN(n)) pids.add(n);
                        }
                    }
                    resolve(pids);
                });
            });
        }
    } catch {
        return new Set();
    }
}

// ── Cross-platform blacklist scanning ──

const BLACKLIST_WHITELIST = ['nvidia'];

const BLACKLIST = [
    'cheatengine', 'cheat engine', 'cheatengine-x86_64', 'cheatengine-i386',
    'processhacker', 'systeminformer',
    'x64dbg', 'x32dbg', 'ollydbg',
    'ida', 'ida64', 'idaq', 'idaq64',
    'dnspy', 'de4dot',
    'httpanalyzer', 'fiddler', 'charles'
];

/**
 * List running process names. Cross-platform.
 * @returns {Promise<string[]>} lowercase process names
 */
function listProcessNames() {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
                if (err) return reject(err);
                const names = [];
                for (const line of stdout.split('\n')) {
                    const match = line.match(/^"([^"]+)"/);
                    if (match) names.push(match[1].replace(/\.exe$/i, '').toLowerCase());
                }
                resolve(names);
            });
        } else {
            execFile('ps', ['axo', 'comm'], { timeout: 5000 }, (err, stdout) => {
                if (err) return reject(err);
                const names = stdout.split('\n').slice(1) // skip header
                    .map(l => path.basename(l.trim()).toLowerCase())
                    .filter(Boolean);
                resolve(names);
            });
        }
    });
}

/**
 * Scan running processes against the blacklist using native OS commands.
 * Works on all platforms (no .exe worker needed).
 * @returns {Promise<string[]>} matched process names
 */
async function scanBlacklistNative() {
    const names = await listProcessNames();
    const found = [];
    for (const name of names) {
        if (BLACKLIST_WHITELIST.some(w => name.includes(w))) continue;
        for (const bl of BLACKLIST) {
            if (name.includes(bl) && !found.includes(name)) {
                found.push(name);
                break;
            }
        }
    }
    return found;
}

/**
 * Find a new javaw.exe PID that wasn't in the before-set.
 * Retries up to 5 times with 2s delay.
 * @param {Set<number>} beforePids
 * @returns {Promise<number|null>}
 */
async function findNewPid(beforePids) {
    for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const currentPids = await snapshotJavawPids();
        for (const pid of currentPids) {
            if (!beforePids.has(pid)) {
                return pid;
            }
        }
    }
    return null;
}

/**
 * Create a DLL guard that monitors a javaw.exe process for injected DLLs,
 * suspicious overlays, and blacklisted processes.
 *
 * Uses a persistent PowerShell worker (stdin/stdout) instead of spawning
 * a new process on every scan cycle.
 *
 * Phase 1 (learning): scans every learningInterval ms, accumulates baseline modules.
 * When stableThreshold consecutive scans find no new modules, locks the baseline.
 *
 * Phase 2 (monitoring): scans every scanInterval ms. Each cycle checks:
 *   1. DLL modules — any new DLL triggers violation (dll:<path>)
 *   2. Overlay windows — suspect overlay triggers violation (overlay:<process>:<title>)
 *   3. Blacklisted processes — triggers violation (blacklist:<process>)
 *
 * @param {number} pid
 * @param {object} options
 * @param {number}   [options.learningInterval=2000]
 * @param {number}   [options.scanInterval=5000]
 * @param {number}   [options.stableThreshold=3]
 * @param {(violation: string) => void} [options.onViolation]
 * @param {(moduleCount: number) => void} [options.onLocked]
 * @returns {{ stop: () => void }}
 */
function createDllGuard(pid, options = {}) {
    const {
        learningInterval = 2000,
        scanInterval = 5000,
        stableThreshold = 3,
        onViolation,
        onLocked
    } = options;

    // Trusted OS/runtime directories — late-loaded DLLs from these paths
    // are normal (lazy loading) and should never trigger a violation.
    const gameDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.matcraft');
    const trustedPrefixes = [
        'c:\\windows\\',
        'c:\\program files\\',
        'c:\\program files (x86)\\',
        'c:\\programdata\\',
        gameDir.toLowerCase() + '\\',
        os.tmpdir().toLowerCase() + '\\'
    ];
    function isTrustedPath(p) {
        return trustedPrefixes.some(prefix => p.startsWith(prefix));
    }

    const baselineModules = new Set();
    let stableCount = 0;
    let timer = null;
    let stopped = false;
    let workerRestartAttempted = false;

    const worker = new PsWorker();

    function stop() {
        if (stopped) return;
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
        worker.stop();
    }

    async function getModulesViaWorker() {
        const result = await worker.send('getModules', { pid });
        const modules = new Set();
        if (result && result.modules) {
            for (const m of result.modules) {
                const trimmed = (typeof m === 'string') ? m.trim() : '';
                if (trimmed) modules.add(trimmed.toLowerCase());
            }
        }
        return modules;
    }

    async function restartWorker() {
        if (workerRestartAttempted) return false;
        workerRestartAttempted = true;
        try {
            await worker.start();
            return true;
        } catch {
            return false;
        }
    }

    async function learningScan() {
        if (stopped) return;
        let modules;
        try {
            modules = await getModulesViaWorker();
        } catch {
            if (worker.alive) { stop(); return; }
            const ok = await restartWorker();
            if (!ok) { stop(); return; }
            return; // skip this cycle, retry next interval
        }

        let foundNew = false;
        for (const m of modules) {
            if (!baselineModules.has(m)) {
                baselineModules.add(m);
                foundNew = true;
            }
        }

        if (foundNew) {
            stableCount = 0;
        } else {
            stableCount++;
        }

        if (stableCount >= stableThreshold) {
            clearInterval(timer);
            timer = null;
            if (onLocked) onLocked(baselineModules.size);
            startMonitoring();
        }
    }

    function startMonitoring() {
        if (stopped) return;
        timer = setInterval(monitoringScan, scanInterval);
    }

    async function monitoringScan() {
        if (stopped) return;

        // 1. DLL module check
        let modules;
        try {
            modules = await getModulesViaWorker();
        } catch {
            if (!worker.alive) {
                const ok = await restartWorker();
                if (!ok) { stop(); return; }
            } else {
                stop();
            }
            return;
        }

        for (const m of modules) {
            if (!baselineModules.has(m)) {
                if (isTrustedPath(m)) {
                    baselineModules.add(m);
                    continue;
                }
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`dll:${m}`);
                stop();
                return;
            }
        }

        // 2. Overlay check (non-fatal on error)
        try {
            const overlayResult = await worker.send('scanOverlays');
            if (overlayResult && overlayResult.overlays && overlayResult.overlays.length > 0) {
                const ov = overlayResult.overlays[0];
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`overlay:${ov.process}:${ov.title}`);
                stop();
                return;
            }
        } catch {
            // non-fatal
        }

        // 3. Blacklist check (non-fatal on error)
        try {
            const blResult = await worker.send('scanBlacklist');
            if (blResult && blResult.blacklisted && blResult.blacklisted.length > 0) {
                const proc = blResult.blacklisted[0];
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`blacklist:${proc}`);
                stop();
                return;
            }
        } catch {
            // non-fatal
        }
    }

    worker.onCrash = async () => {
        if (stopped) return;
        const ok = await restartWorker();
        if (!ok) stop();
    };

    worker.start().then(() => {
        if (stopped) return;
        timer = setInterval(learningScan, learningInterval);
    }).catch(() => {
        // Don't kill the game — just disable the guard
    });

    return { stop };
}

/**
 * Lightweight blacklist-only guard for macOS/Linux.
 * Scans running processes at regular intervals — no DLL or overlay checks.
 * Same interface as createDllGuard ({ stop }).
 *
 * @param {number} pid - The game process PID (used to kill it on violation)
 * @param {object} options
 * @param {number}   [options.scanInterval=5000]
 * @param {(violation: string) => void} [options.onViolation]
 * @returns {{ stop: () => void }}
 */
function createBlacklistGuard(pid, options = {}) {
    const { scanInterval = 5000, onViolation } = options;

    let timer = null;
    let stopped = false;

    function stop() {
        if (stopped) return;
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
    }

    async function scan() {
        if (stopped) return;
        try {
            const found = await scanBlacklistNative();
            if (found.length > 0) {
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`blacklist:${found[0]}`);
                stop();
            }
        } catch {
            // non-fatal — retry on next interval
        }
    }

    // Start scanning immediately
    timer = setInterval(scan, scanInterval);

    return { stop };
}

module.exports = { snapshotJavawPids, findNewPid, createDllGuard, createBlacklistGuard };
