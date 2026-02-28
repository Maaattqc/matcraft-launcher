const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'main.js',
  'preload.js',
  'lib/dllGuard.js',
  'lib/syncMods.js',
  'lib/psWorker.js',
];

const CONFIG = {
  target: 'node',
  // Renaming
  renameGlobals: false,
  identifierNamesGenerator: 'hexadecimal',
  // String encryption
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1,
  splitStrings: true,
  splitStringsChunkLength: 5,
  // Control flow
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  // Dead code
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  // Misc
  numbersToExpressions: true,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  selfDefending: false,
};

for (const relPath of FILES) {
  const filePath = path.join(ROOT, relPath);
  const code = fs.readFileSync(filePath, 'utf8');
  console.log(`Obfuscating ${relPath} (${code.length} bytes)...`);
  const result = JavaScriptObfuscator.obfuscate(code, CONFIG);
  const obfuscated = result.getObfuscatedCode();
  fs.writeFileSync(filePath, obfuscated, 'utf8');
  console.log(`  -> ${obfuscated.length} bytes`);
}

console.log('JS obfuscation complete.');
