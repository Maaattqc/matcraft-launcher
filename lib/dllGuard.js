const { execFile } = require('child_process');
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
 * Get the set of PIDs for all running javaw.exe processes.
 * @returns {Promise<Set<number>>}
 */
async function snapshotJavawPids() {
    try {
        const output = await runPowerShell(
            '(Get-Process javaw -ErrorAction SilentlyContinue).Id -join ","'
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
    for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const currentPids = await snapshotJavawPids();
        for (const pid of currentPids) {
            if (!beforePids.has(pid)) return pid;
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
        console.log('[dllGuard] Guard stopped.');
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
        console.log('[dllGuard] Attempting worker restart...');
        try {
            await worker.start();
            console.log('[dllGuard] Worker restarted successfully.');
            return true;
        } catch (err) {
            console.error('[dllGuard] Worker restart failed:', err.message);
            return false;
        }
    }

    async function learningScan() {
        if (stopped) return;
        let modules;
        try {
            modules = await getModulesViaWorker();
        } catch {
            // Worker or process issue — try restart
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
            console.log(`[dllGuard] Baseline locked: ${baselineModules.size} modules`);
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
            // Worker or process died
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
                console.log(`[dllGuard] VIOLATION — injected DLL detected: ${m}`);
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
                console.log(`[dllGuard] VIOLATION — suspect overlay: ${ov.process} "${ov.title}"`);
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`overlay:${ov.process}:${ov.title}`);
                stop();
                return;
            }
        } catch (err) {
            console.warn('[dllGuard] Overlay scan failed (non-fatal):', err.message);
        }

        // 3. Blacklist check (non-fatal on error)
        try {
            const blResult = await worker.send('scanBlacklist');
            if (blResult && blResult.blacklisted && blResult.blacklisted.length > 0) {
                const proc = blResult.blacklisted[0];
                console.log(`[dllGuard] VIOLATION — blacklisted process: ${proc}`);
                try { process.kill(pid); } catch {}
                if (onViolation) onViolation(`blacklist:${proc}`);
                stop();
                return;
            }
        } catch (err) {
            console.warn('[dllGuard] Blacklist scan failed (non-fatal):', err.message);
        }
    }

    // Start the worker, then begin learning phase
    console.log(`[dllGuard] Starting worker for PID ${pid}`);
    worker.onCrash = async (code) => {
        if (stopped) return;
        console.warn(`[dllGuard] Worker crashed (code ${code}), attempting restart...`);
        const ok = await restartWorker();
        if (!ok) {
            console.error('[dllGuard] Worker unrecoverable, stopping guard silently.');
            stop();
        }
    };

    worker.start().then(() => {
        if (stopped) return;
        console.log('[dllGuard] Worker ready, beginning learning phase');
        timer = setInterval(learningScan, learningInterval);
    }).catch((err) => {
        console.error('[dllGuard] Worker failed to start:', err.message);
        // Don't kill the game — just disable the guard
    });

    return { stop };
}

module.exports = { snapshotJavawPids, findNewPid, createDllGuard };
