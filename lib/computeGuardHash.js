const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const exePath = path.join(__dirname, 'dllGuardWorker.exe');
if (!fs.existsSync(exePath)) {
    console.error('[computeGuardHash] dllGuardWorker.exe not found');
    process.exit(1);
}
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex');
fs.writeFileSync(path.join(__dirname, 'guardHash.json'), JSON.stringify({ sha256 }) + '\n');
console.log('[computeGuardHash] SHA-256:', sha256);
