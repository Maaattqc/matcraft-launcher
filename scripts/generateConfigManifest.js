#!/usr/bin/env node
/**
 * Generate a configs manifest.json from a local directory.
 *
 * Usage:
 *   node scripts/generateConfigManifest.js <configsDir> [outputFile]
 *
 * Example:
 *   node scripts/generateConfigManifest.js ./fancymenu-configs ./manifest.json
 *
 * This scans <configsDir> recursively and produces a JSON manifest with
 * relative paths and SHA-256 hashes, ready to upload alongside the config
 * files to the server at configs/manifest.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

function walkDir(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkDir(fullPath));
        } else if (entry.isFile()) {
            results.push(fullPath);
        }
    }
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node scripts/generateConfigManifest.js <configsDir> [outputFile]');
        console.error('Example: node scripts/generateConfigManifest.js ./fancymenu-configs ./manifest.json');
        process.exit(1);
    }

    const configsDir = path.resolve(args[0]);
    const outputFile = args[1] ? path.resolve(args[1]) : path.join(configsDir, 'manifest.json');

    if (!fs.existsSync(configsDir) || !fs.statSync(configsDir).isDirectory()) {
        console.error(`Error: "${configsDir}" is not a valid directory.`);
        process.exit(1);
    }

    const files = walkDir(configsDir);
    const configs = [];

    for (const filePath of files) {
        const relativePath = path.relative(configsDir, filePath).replace(/\\/g, '/');
        // Skip the manifest itself if it exists in the directory
        if (relativePath === 'manifest.json') continue;

        const sha256 = await hashFile(filePath);
        configs.push({ path: relativePath, sha256 });
        console.log(`  ${relativePath} → ${sha256.slice(0, 12)}...`);
    }

    configs.sort((a, b) => a.path.localeCompare(b.path));

    const manifest = { configs };
    fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nManifest written to ${outputFile} (${configs.length} files)`);
}

main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
