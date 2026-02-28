const fs = require('fs');
const path = require('path');

const UNNECESSARY_FILES = [
  'LICENSES.chromium.html',
  'dxcompiler.dll',
  'dxil.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
];

exports.default = async function (context) {
  for (const name of UNNECESSARY_FILES) {
    const file = path.join(context.appOutDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  // Generate ASAR integrity hash
  const asarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (fs.existsSync(asarPath)) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256')
      .update(fs.readFileSync(asarPath))
      .digest('hex');
    const integrityPath = path.join(context.appOutDir, 'resources', 'asar-integrity.json');
    fs.writeFileSync(integrityPath, JSON.stringify({ sha256: hash }));
    console.log(`[afterPack] ASAR integrity hash: ${hash}`);
  }
};
