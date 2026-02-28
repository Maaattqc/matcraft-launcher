const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

/**
 * Compute hash of a file.
 * @param {string} filePath
 * @param {string} [algo='sha256']
 * @returns {Promise<string>}
 */
function hashFile(filePath, algo = 'sha256') {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algo);
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
    return serverMods;
}

/**
 * Create a guard that watches the mods directory and removes unauthorized files.
 * @param {string} modsDir  - absolute path to the mods folder
 * @param {Map<string, string>} allowedMods - Map of name → sha256
 * @returns {{ verify: () => Promise<void>, stop: () => void }}
 */
function createModsGuard(modsDir, allowedMods) {
    let watcher = null;

    async function verify() {
        let files;
        try {
            files = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
        } catch {
            return;
        }

        for (const file of files) {
            const filePath = path.join(modsDir, file);
            const expectedHash = allowedMods.get(file);

            if (!expectedHash) {
                // Not in the allowed list — remove it
                console.log(`[modsGuard] Removing unauthorized mod: ${file}`);
                try { fs.unlinkSync(filePath); } catch {}
                continue;
            }

            // Allowed name — verify hash
            try {
                const actualHash = await hashFile(filePath);
                if (actualHash !== expectedHash) {
                    console.log(`[modsGuard] Hash mismatch for ${file} — removing tampered mod`);
                    try { fs.unlinkSync(filePath); } catch {}
                }
            } catch {
                console.log(`[modsGuard] Cannot hash ${file} — removing`);
                try { fs.unlinkSync(filePath); } catch {}
            }
        }
    }

    // Initial verify + start watching
    verify();

    try {
        watcher = fs.watch(modsDir, { persistent: false }, (_eventType, filename) => {
            if (filename && filename.endsWith('.jar')) {
                console.log(`[modsGuard] Change detected: ${filename}`);
                verify();
            }
        });
        watcher.on('error', (err) => {
            console.error('[modsGuard] Watcher error:', err.message);
        });
        console.log('[modsGuard] Watcher started on', modsDir);
    } catch (err) {
        console.error('[modsGuard] Failed to start watcher:', err.message);
    }

    function stop() {
        if (watcher) {
            watcher.close();
            watcher = null;
            console.log('[modsGuard] Watcher stopped.');
        }
    }

    return { verify, stop };
}

/**
 * Convert a Maven coordinate to a relative JAR path.
 * e.g. "org.ow2.asm:asm:9.9" → "org/ow2/asm/asm/9.9/asm-9.9.jar"
 * @param {string} name
 * @returns {string}
 */
function mavenNameToPath(name) {
    const [groupId, artifactId, version] = name.split(':');
    const groupPath = groupId.replace(/\./g, '/');
    return `${groupPath}/${artifactId}/${version}/${artifactId}-${version}.jar`;
}

/**
 * Verify integrity of Fabric loader libraries using SHA-256 hashes
 * from the installed Fabric version JSON. Re-downloads corrupted files.
 * @param {string} gameDir
 */
async function verifyFabricLoader(gameDir) {
    const versionsDir = path.join(gameDir, 'loader', 'fabric', 'versions');
    if (!fs.existsSync(versionsDir)) {
        console.log('[fabricGuard] No Fabric loader installed yet — skipping.');
        return;
    }

    // Find the Fabric loader version JSON
    let fabricJsonPath = null;
    try {
        const versionDirs = fs.readdirSync(versionsDir);
        for (const dir of versionDirs) {
            const dirPath = path.join(versionsDir, dir);
            if (!fs.statSync(dirPath).isDirectory()) continue;
            const jsonFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
            if (jsonFiles.length > 0) {
                fabricJsonPath = path.join(dirPath, jsonFiles[0]);
                break;
            }
        }
    } catch (err) {
        console.log('[fabricGuard] Cannot read Fabric versions dir:', err.message);
        return;
    }

    if (!fabricJsonPath) {
        console.log('[fabricGuard] No Fabric version JSON found — skipping.');
        return;
    }

    let fabricJson;
    try {
        fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
    } catch (err) {
        console.error('[fabricGuard] Failed to parse Fabric JSON:', err.message);
        return;
    }

    const libraries = fabricJson.libraries;
    if (!Array.isArray(libraries)) {
        console.log('[fabricGuard] No libraries array in Fabric JSON — skipping.');
        return;
    }

    const toVerify = libraries.filter(lib => lib.sha256);
    console.log(`[fabricGuard] Verifying ${toVerify.length} libraries...`);

    const libsDir = path.join(gameDir, 'libraries');

    for (const lib of toVerify) {
        const relPath = mavenNameToPath(lib.name);
        const filePath = path.join(libsDir, relPath);
        const mavenUrl = (lib.url || 'https://maven.fabricmc.net/') + relPath;

        if (!fs.existsSync(filePath)) {
            console.log(`[fabricGuard] Missing: ${lib.name} — downloading`);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            await downloadFile(mavenUrl, filePath);
            const dlHash = await hashFile(filePath);
            if (dlHash !== lib.sha256) {
                try { fs.unlinkSync(filePath); } catch {}
                throw new Error(`[fabricGuard] Hash mismatch after download for ${lib.name}`);
            }
            continue;
        }

        const actualHash = await hashFile(filePath);
        if (actualHash === lib.sha256) continue;

        console.log(`[fabricGuard] Tampered: ${lib.name} — re-downloading`);
        try { fs.unlinkSync(filePath); } catch {}
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        await downloadFile(mavenUrl, filePath);
        const newHash = await hashFile(filePath);
        if (newHash !== lib.sha256) {
            try { fs.unlinkSync(filePath); } catch {}
            throw new Error(`[fabricGuard] Hash mismatch after re-download for ${lib.name}`);
        }
    }

    console.log('[fabricGuard] All libraries OK');
}

/**
 * Recursively list all files in a directory, returning paths relative to base.
 * @param {string} dir - current directory to scan
 * @param {string} base - root directory for relative path computation
 * @returns {string[]}
 */
function walkDirRelative(dir, base) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkDirRelative(fullPath, base));
        } else if (entry.isFile()) {
            results.push(path.relative(base, fullPath).replace(/\\/g, '/'));
        }
    }
    return results;
}

/**
 * Synchronize local config files with server manifest.
 * Downloads missing/modified files and deletes files not in the manifest.
 *
 * @param {string} gameDir  - e.g. %APPDATA%/.matcraft
 * @param {string} baseUrl  - e.g. https://matfaction.com/launcher
 * @param {(phase: string, current: number, total: number, fileName?: string) => void} sendProgress
 */
async function syncConfigs(gameDir, baseUrl, sendProgress) {
    const configDir = path.join(gameDir, 'config');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    // 1. Fetch manifest
    sendProgress('checking-configs', 0, 0, null);
    const manifestUrl = `${baseUrl}/config/manifest.json`;
    console.log(`[syncConfigs] Fetching manifest from ${manifestUrl}`);
    let manifest;
    try {
        manifest = await fetchJson(manifestUrl);
    } catch (err) {
        console.log(`[syncConfigs] Manifest not available, skipping config sync: ${err.message}`);
        sendProgress('configs-done', 0, 0, null);
        return;
    }

    // manifest format: { configs: [{ path: "fancymenu/options.txt", sha256: "abc..." }, ...] }
    const serverConfigs = manifest.configs || [];

    // 2. Build sync plan (download missing or modified files only)
    const toDownload = [];
    const upToDate = [];

    for (const entry of serverConfigs) {
        const localPath = path.join(configDir, entry.path);
        if (fs.existsSync(localPath)) {
            try {
                const localHash = await hashFile(localPath);
                if (localHash === entry.sha256) {
                    upToDate.push(entry.path);
                    continue;
                }
            } catch {
                // Can't hash — treat as needing re-download
            }
        }
        toDownload.push(entry);
    }

    // 3. Delete local files not in the manifest
    const serverPaths = new Set(serverConfigs.map(e => e.path));
    const localFiles = walkDirRelative(configDir, configDir);
    const toDelete = localFiles.filter(f => !serverPaths.has(f));

    console.log(`[syncConfigs] Up to date: ${upToDate.length}, to download: ${toDownload.length}, to delete: ${toDelete.length}`);

    if (toDelete.length > 0) {
        for (let i = 0; i < toDelete.length; i++) {
            const relPath = toDelete[i];
            sendProgress('deleting-configs', i + 1, toDelete.length, relPath.split('/').pop());
            console.log(`[syncConfigs] Deleting: ${relPath}`);
            try {
                fs.unlinkSync(path.join(configDir, relPath));
            } catch (err) {
                console.error(`[syncConfigs] Failed to delete ${relPath}:`, err.message);
            }
        }
    }

    // 4. Download missing/modified configs
    if (toDownload.length > 0) {
        for (let i = 0; i < toDownload.length; i++) {
            const entry = toDownload[i];
            const destPath = path.join(configDir, entry.path);
            const url = `${baseUrl}/config/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
            const displayName = entry.path.split('/').pop();
            sendProgress('downloading-configs', i + 1, toDownload.length, displayName);
            console.log(`[syncConfigs] Downloading: ${entry.path}`);

            // Ensure parent directory exists
            fs.mkdirSync(path.dirname(destPath), { recursive: true });

            let success = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await downloadFile(url, destPath);
                    const actualHash = await hashFile(destPath);
                    if (actualHash !== entry.sha256) {
                        throw new Error(`Hash mismatch for ${entry.path}: expected ${entry.sha256}, got ${actualHash}`);
                    }
                    success = true;
                    break;
                } catch (err) {
                    console.error(`[syncConfigs] Attempt ${attempt + 1} failed for ${entry.path}:`, err.message);
                    try { fs.unlinkSync(destPath); } catch {}
                    if (attempt === 1) throw err;
                }
            }
        }
    }

    sendProgress('configs-done', 0, 0, null);
    console.log('[syncConfigs] Sync complete.');
}

module.exports = { syncMods, syncConfigs, createModsGuard, verifyFabricLoader };
