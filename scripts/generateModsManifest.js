#!/usr/bin/env node
/**
 * Génère un manifest.json avec noms de mods obfusqués.
 *
 * Usage:
 *   node scripts/generateModsManifest.js [modsDir] [outputDir]
 *
 * Par défaut:
 *   modsDir   = ./mods
 *   outputDir = ./mods-obfuscated
 *
 * Le script :
 * 1. Lit tous les .jar dans modsDir
 * 2. Génère un nom obfusqué pour chaque mod (hash du nom original)
 * 3. Copie les fichiers avec les noms obfusqués dans outputDir
 * 4. Génère manifest.json dans outputDir
 *
 * Il suffit ensuite d'uploader le contenu de outputDir sur le serveur
 * dans /launcher/mods/.
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

/**
 * Génère un nom obfusqué à partir du nom original.
 * Utilise SHA256 du nom original, tronqué à 12 caractères hex.
 */
function obfuscateName(originalName) {
    const hash = crypto.createHash('sha256').update(originalName).digest('hex');
    return hash.slice(0, 12) + '.jar';
}

async function main() {
    const args = process.argv.slice(2);
    const modsDir = path.resolve(args[0] || './mods');
    const outputDir = path.resolve(args[1] || './mods-obfuscated');

    if (!fs.existsSync(modsDir) || !fs.statSync(modsDir).isDirectory()) {
        console.error(`Erreur: "${modsDir}" n'est pas un dossier valide.`);
        process.exit(1);
    }

    // Créer le dossier de sortie
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const jarFiles = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));

    if (jarFiles.length === 0) {
        console.error('Aucun fichier .jar trouvé dans', modsDir);
        process.exit(1);
    }

    console.log(`\nObfuscation de ${jarFiles.length} mod(s)...\n`);

    const mods = [];
    const nameMap = new Map(); // Pour détecter les collisions

    for (const originalName of jarFiles) {
        const srcPath = path.join(modsDir, originalName);
        const obfuscated = obfuscateName(originalName);

        // Vérifier les collisions (très improbable avec 12 chars hex)
        if (nameMap.has(obfuscated)) {
            console.error(`Collision de hash ! ${originalName} et ${nameMap.get(obfuscated)} → ${obfuscated}`);
            process.exit(1);
        }
        nameMap.set(obfuscated, originalName);

        // Hash du contenu pour le manifest
        const sha256 = await hashFile(srcPath);

        // Copier avec le nom obfusqué
        const destPath = path.join(outputDir, obfuscated);
        fs.copyFileSync(srcPath, destPath);

        mods.push({ name: obfuscated, sha256 });
        console.log(`  ${originalName} → ${obfuscated}  (${sha256.slice(0, 12)}...)`);
    }

    mods.sort((a, b) => a.name.localeCompare(b.name));

    // Générer le manifest
    const manifest = { mods };
    const manifestPath = path.join(outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    console.log(`\nManifest écrit dans ${manifestPath} (${mods.length} mods)`);
    console.log(`\nPour déployer, uploadez le contenu de ${outputDir}/ vers le serveur dans /launcher/mods/`);
}

main().catch((err) => {
    console.error('Erreur fatale:', err.message);
    process.exit(1);
});
