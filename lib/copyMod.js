const path = require('path');
const defaultFs = require('fs');

/**
 * Copies .jar mod files from source directories to the game mods directory.
 * Skips -sources.jar files. Creates the mods directory if it doesn't exist.
 * @param {string} gameDir
 * @param {string[]} modSources
 * @param {object} [_fs] - optional fs override for testing
 */
function copyMod(gameDir, modSources, _fs) {
    const fs = _fs || defaultFs;
    const modsDir = path.join(gameDir, 'mods');
    if (!fs.existsSync(modsDir)) {
        fs.mkdirSync(modsDir, { recursive: true });
    }

    for (const source of modSources) {
        if (!fs.existsSync(source)) continue;
        const jars = fs.readdirSync(source).filter(f => f.endsWith('.jar') && !f.includes('-sources'));
        for (const jar of jars) {
            const src = path.join(source, jar);
            if (fs.lstatSync(src).isSymbolicLink()) continue;
            const dest = path.join(modsDir, jar);
            fs.copyFileSync(src, dest);
        }
    }
}

module.exports = { copyMod };
