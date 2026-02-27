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
};
