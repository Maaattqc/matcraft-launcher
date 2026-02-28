const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'tools', 'confuserex');
const CLI_EXE = path.join(TOOLS_DIR, 'Confuser.CLI.exe');
const CRPROJ = path.join(ROOT, 'confuser.crproj');

const CONFUSEREX_VERSION = '1.6.0';
const CONFUSEREX_URL = `https://github.com/mkaring/ConfuserEx/releases/download/v${CONFUSEREX_VERSION}/ConfuserEx-CLI.zip`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'matcraft-launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function ensureConfuserEx() {
  if (fs.existsSync(CLI_EXE)) {
    console.log('ConfuserEx CLI already present.');
    return;
  }

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const zipPath = path.join(TOOLS_DIR, 'ConfuserEx-CLI.zip');

  console.log(`Downloading ConfuserEx v${CONFUSEREX_VERSION}...`);
  await download(CONFUSEREX_URL, zipPath);
  console.log('Download complete.');

  console.log('Extracting...');
  // Use PowerShell to extract on Windows
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${TOOLS_DIR}'"`,
    { stdio: 'inherit' }
  );

  fs.unlinkSync(zipPath);

  if (!fs.existsSync(CLI_EXE)) {
    throw new Error(`Confuser.CLI.exe not found after extraction at ${CLI_EXE}`);
  }
  console.log('ConfuserEx ready.');
}

async function main() {
  await ensureConfuserEx();

  console.log('Running ConfuserEx...');
  execSync(`"${CLI_EXE}" "${CRPROJ}"`, { stdio: 'inherit', cwd: ROOT });

  console.log('C# obfuscation complete.');
}

main().catch((err) => {
  console.error('C# obfuscation failed:', err.message);
  process.exit(1);
});
