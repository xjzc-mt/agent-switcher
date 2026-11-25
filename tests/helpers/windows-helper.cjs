const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('../../scripts/build-windows-helpers.cjs');

// Test credentials have a random target embedded in a test-only binary.
exports.fixtureHelper = (root, name, source) => {
  const file = path.join(root, name + '.cs'), executable = path.join(root, name + '.exe');
  fs.writeFileSync(file, source, { flag: 'wx' });
  compile(file, executable);
  return executable;
};
