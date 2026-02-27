const { spawn } = require('child_process');
const { createInterface } = require('readline');
const path = require('path');

/**
 * Persistent native worker that communicates via NDJSON on stdin/stdout.
 * Spawns a compiled C# exe and reuses it for all commands.
 */
class PsWorker {
    constructor() {
        this._proc = null;
        this._rl = null;
        this._pending = new Map(); // id → { resolve, reject, timer }
        this._nextId = 1;
        this._ready = false;
        this.onCrash = null;
    }

    get alive() {
        return this._proc !== null && !this._proc.killed && this._ready;
    }

    /**
     * Spawn the guard worker process and wait for the "ready" signal.
     * @param {object} [options]
     * @param {number} [options.startupTimeout=5000]
     * @returns {Promise<void>}
     */
    start(options = {}) {
        const { startupTimeout = 5000 } = options;

        return new Promise((resolve, reject) => {
            const exePath = path.join(
                __dirname.replace('app.asar', 'app.asar.unpacked'),
                'dllGuardWorker.exe'
            );

            this._proc = spawn(exePath, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            this._rl = createInterface({ input: this._proc.stdout });

            let started = false;
            const startupTimer = setTimeout(() => {
                if (!started) {
                    started = true;
                    this.stop();
                    reject(new Error('Guard worker startup timeout'));
                }
            }, startupTimeout);

            // Handle first line as ready signal
            const onFirstLine = (line) => {
                try {
                    const msg = JSON.parse(line);
                    if (msg.status === 'ready') {
                        started = true;
                        clearTimeout(startupTimer);
                        this._ready = true;
                        // Switch to normal message handler
                        this._rl.removeListener('line', onFirstLine);
                        this._rl.on('line', (l) => this._onLine(l));
                        resolve();
                    }
                } catch {
                    // ignore non-JSON during startup (e.g. PS warnings)
                }
            };
            this._rl.on('line', onFirstLine);

            this._proc.on('exit', (code) => {
                this._ready = false;
                // Reject all pending commands
                for (const [, entry] of this._pending) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error(`Guard worker exited (code ${code})`));
                }
                this._pending.clear();
                this._proc = null;
                this._rl = null;

                if (!started) {
                    started = true;
                    clearTimeout(startupTimer);
                    reject(new Error(`Guard worker exited during startup (code ${code})`));
                } else if (this.onCrash) {
                    this.onCrash(code);
                }
            });

            this._proc.on('error', (err) => {
                this._ready = false;
                if (!started) {
                    started = true;
                    clearTimeout(startupTimer);
                    reject(err);
                }
            });

            // Consume stderr silently
            this._proc.stderr?.resume();
        });
    }

    /**
     * Send a command to the worker and return the result.
     * @param {string} cmd
     * @param {object} [params={}]
     * @param {number} [timeout=10000]
     * @returns {Promise<object>}
     */
    send(cmd, params = {}, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.alive) {
                return reject(new Error('Guard worker not alive'));
            }

            const id = this._nextId++;
            const timer = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`Guard command timeout: ${cmd}`));
            }, timeout);

            this._pending.set(id, { resolve, reject, timer });

            const line = JSON.stringify({ id, cmd, params }) + '\n';
            try {
                this._proc.stdin.write(line);
            } catch (err) {
                this._pending.delete(id);
                clearTimeout(timer);
                reject(err);
            }
        });
    }

    /**
     * Gracefully stop the worker. Force-kills after 2s.
     */
    stop() {
        this._ready = false;

        if (!this._proc) return;

        const proc = this._proc;

        // Try graceful exit
        try {
            proc.stdin.write(JSON.stringify({ id: 0, cmd: 'exit' }) + '\n');
            proc.stdin.end();
        } catch {
            // stdin may already be closed
        }

        const killTimer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch {}
        }, 2000);

        proc.on('exit', () => clearTimeout(killTimer));
    }

    /** @private */
    _onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return; // ignore non-JSON output
        }

        const entry = this._pending.get(msg.id);
        if (!entry) return;

        this._pending.delete(msg.id);
        clearTimeout(entry.timer);

        if (msg.error) {
            entry.reject(new Error(msg.error));
        } else {
            entry.resolve(msg.result);
        }
    }
}

module.exports = { PsWorker };
