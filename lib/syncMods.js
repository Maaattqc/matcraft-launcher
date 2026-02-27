const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

/**
 * Compute SHA-256 hash of a file.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * Download a file from a URL to a destination path.
 * Follows redirects (up to 5). Timeout 30s.
 * @param {string} url
 * @param {string} destPath
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const get = url.startsWith('https') ? https.get : http.get;
        const request = get(url, { timeout: 30000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                downloadFile(res.headers.location, destPath).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Download failed: HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        });
        request.on('timeout', () => {
            request.destroy();
            reject(new Error(`Download timed out: ${url}`));
        });
        request.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

/**
 * Fetch JSON from a URL. Timeout 10s.
 * @param {string} url
 * @returns {Promise<any>}
 */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const get = url.startsWith('https') ? https.get : http.get;
        const request = get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                fetchJson(res.headers.location).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Failed to fetch manifest: HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid manifest JSON'));
                }
            });
        });
        request.on('timeout', () => {
            request.destroy();
            reject(new Error('Manifest fetch timed out — vérifiez votre connexion internet.'));
        });
        request.on('error', (err) => {
            reject(new Error(`Impossible de contacter le serveur : ${err.message}`));
        });
    });
}

/**
 * Synchronize local mods with server manifest.
 * Blocks launch if the server is unreachable.
 *
 * @param {string} gameDir  - e.g. %APPDATA%/.matcraft
 * @param {string} baseUrl  - e.g. https://matfaction.com/launcher
 * @param {(phase: string, current: number, total: number, modName?: string) => void} sendProgress
 */
async function syncMods(gameDir, baseUrl, sendProgress) {
    const modsDir = path.join(gameDir, 'mods');
    if (!fs.existsSync(modsDir)) {
        fs.mkdirSync(modsDir, { recursive: true });
    }

    // 1. Fetch manifest (blocks launch on failure)
    sendProgress('checking', 0, 0, null);
    const manifestUrl = `${baseUrl}/mods/manifest.json`;
    console.log(`[syncMods] Fetching manifest from ${manifestUrl}`);
    const manifest = await fetchJson(manifestUrl);

    // manifest format: { mods: [{ name: "xxx.jar", sha256: "abc..." }, ...] }
    const serverMods = new Map();
    for (const mod of manifest.mods) {
        serverMods.set(mod.name, mod.sha256);
    }

    // 2. Hash local mods
    const localFiles = fs.existsSync(modsDir)
        ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'))
        : [];

    const localHashes = new Map();
    for (const file of localFiles) {
        const filePath = path.join(modsDir, file);
        try {
            const hash = await hashFile(filePath);
            localHashes.set(file, hash);
        } catch {
            // If we can't hash it, treat as corrupted — will be deleted/replaced
            localHashes.set(file, null);
        }
    }

    // 3. Build sync plan
    const toDownload = [];
    const toDelete = [];
    const upToDate = [];

    for (const [name, expectedHash] of serverMods) {
        const localHash = localHashes.get(name);
        if (localHash === expectedHash) {
            upToDate.push(name);
        } else {
            toDownload.push({ name, expectedHash });
        }
    }

    for (const [name] of localHashes) {
        if (!serverMods.has(name)) {
            toDelete.push(name);
        }
    }

    console.log(`[syncMods] Up to date: ${upToDate.length}, to download: ${toDownload.length}, to delete: ${toDelete.length}`);

    // 4. Delete unauthorized mods
    if (toDelete.length > 0) {
        for (let i = 0; i < toDelete.length; i++) {
            const name = toDelete[i];
            sendProgress('deleting', i + 1, toDelete.length, name);
            console.log(`[syncMods] Deleting unauthorized mod: ${name}`);
            try {
                fs.unlinkSync(path.join(modsDir, name));
            } catch (err) {
                console.error(`[syncMods] Failed to delete ${name}:`, err.message);
            }
        }
    }

    // 5. Download missing/modified mods
    if (toDownload.length > 0) {
        for (let i = 0; i < toDownload.length; i++) {
            const { name, expectedHash } = toDownload[i];
            const destPath = path.join(modsDir, name);
            const url = `${baseUrl}/mods/${encodeURIComponent(name)}`;
            sendProgress('downloading', i + 1, toDownload.length, name);
            console.log(`[syncMods] Downloading: ${name}`);

            let success = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await downloadFile(url, destPath);
                    // Verify hash after download
                    const actualHash = await hashFile(destPath);
                    if (actualHash !== expectedHash) {
                        throw new Error(`Hash mismatch for ${name}: expected ${expectedHash}, got ${actualHash}`);
                    }
                    success = true;
                    break;
                } catch (err) {
                    console.error(`[syncMods] Attempt ${attempt + 1} failed for ${name}:`, err.message);
                    // Clean up partial download
                    try { fs.unlinkSync(destPath); } catch {}
                    if (attempt === 1) throw err;
                }
            }
        }
    }

    sendProgress('done', 0, 0, null);
    console.log('[syncMods] Sync complete.');
}

module.exports = { syncMods };
