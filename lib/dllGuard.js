const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const { PsWorker } = require('./psWorker');

/**
 * Run a PowerShell command and return stdout.
 * Used only for pre-launch PID snapshots (outside gameplay).
 * @param {string} command
 * @returns {Promise<string>}
 */
function runPowerShell(command) {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            timeout: 10000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve(stdout.trim());
        });
    });
}

/**
 * Get the set of PIDs for all running java/javaw processes.
 * Zulu JDK uses java.exe instead of javaw.exe, so we check both.
 * @returns {Promise<Set<number>>}
 */
async function snapshotJavawPids() {
    try {
        const output = await runPowerShell(
            '(Get-Process java,javaw -ErrorAction SilentlyContinue).Id -join ","'
        );
        const pids = new Set();
        if (output) {
            for (const s of output.split(',')) {
                const n = parseInt(s.trim(), 10);
                if (!isNaN(n)) pids.add(n);
            }
        }
        return pids;
    } catch {
        return new Set();
    }
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

module.exports = { snapshotJavawPids, findNewPid, createDllGuard };
