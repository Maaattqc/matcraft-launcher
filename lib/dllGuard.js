const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

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

// ── Module scanning via tasklist.exe ──

/** Known Windows system DLL name patterns — never flag these as injections. */
const TRUSTED_DLL_PATTERNS = [
    /^api-ms-win-/i,
    /^ext-ms-/i,
    /^vcruntime/i,
    /^msvcp/i,
    /^ucrtbase/i,
    /^ntdll/i,
    /^kernel32/i,
    /^kernelbase/i,
    /^msvcrt/i,
    /^clr/i,
    /^coreclr/i,
    /^d3d\d/i,
    /^dxgi/i,
    /^opengl32/i,
    /^gdi32/i,
    /^user32/i,
    /^advapi32/i,
    /^shell32/i,
    /^ole32/i,
    /^combase/i,
    /^ws2_32/i,
    /^crypt32/i,
    /^secur32/i,
    /^bcrypt/i,
    /^nsi/i,
    /^iphlpapi/i,
    /^mswsock/i,
    /^wldap32/i,
    /^dbghelp/i,
    /^version/i,
    /^winmm/i,
    /^imm32/i,
    /^setupapi/i,
    /^cfgmgr32/i,
    /^wintrust/i,
    /^msasn1/i,
    /^nvidia/i,
    /^nv[a-z]/i,
];

/**
 * Check if a DLL name is a known trusted system DLL.
 * @param {string} name - lowercase DLL name
 * @returns {boolean}
 */
function isTrustedDll(name) {
    return TRUSTED_DLL_PATTERNS.some(p => p.test(name));
}

/**
 * Get the list of DLL modules loaded by a process via tasklist.exe /M.
 * @param {number} pid
 * @returns {Promise<Set<string>>} lowercase module names
 */
function getProcessModules(pid) {
    return new Promise((resolve) => {
        execFile('tasklist.exe', ['/M', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { timeout: 5000, windowsHide: true }, (err, stdout) => {
                const modules = new Set();
                if (!err && stdout) {
                    for (const line of stdout.split('\n')) {
                        const m = line.match(/^"[^"]+","\d+","(.+)"/);
                        if (m) {
                            const name = m[1].trim().toLowerCase();
                            if (name && name !== 'n/a') modules.add(name);
                        }
                    }
                }
                resolve(modules);
            });
    });
}

/**
 * Find a new javaw.exe PID that wasn't in the before-set.
 * Retries up to 15 times with 3s delay.
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
 * Create a DLL guard that monitors a javaw.exe process for injected DLLs
 * and blacklisted processes. Pure Node.js — no external .exe needed.
 *
 * Phase 1 (learning): scans every learningInterval ms, accumulates baseline modules.
 * When stableThreshold consecutive scans find no new modules, locks the baseline.
 *
 * Phase 2 (monitoring): scans every scanInterval ms. Each cycle checks:
 *   1. DLL modules — any new DLL triggers violation (dll:<name>)
 *   2. Blacklisted processes — triggers violation (blacklist:<process>)
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

    const baselineModules = new Set();
    let stableCount = 0;
    let timer = null;
    let stopped = false;

    function stop() {
        if (stopped) return;
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
    }

    async function learningScan() {
        if (stopped) return;
        let modules;
        try {
            modules = await getProcessModules(pid);
        } catch {
            return; // skip this cycle, retry next interval
        }

        if (modules.size === 0) return; // process may not be ready yet

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
            modules = await getProcessModules(pid);
        } catch {
            return; // non-fatal, retry next cycle
        }

        if (modules.size === 0) {
            // Process may have exited
            stop();
            return;
        }

        for (const m of modules) {
            if (!baselineModules.has(m)) {
                if (isTrustedDll(m)) {
                    baselineModules.add(m);
                    continue;
                }
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`dll:${m}`);
                stop();
                return;
            }
        }

        // 2. Blacklist check (non-fatal on error)
        try {
            const found = await scanBlacklistNative();
            if (found.length > 0) {
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`blacklist:${found[0]}`);
                stop();
            }
        } catch {
            // non-fatal
        }
    }

    // Start learning immediately
    timer = setInterval(learningScan, learningInterval);

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
