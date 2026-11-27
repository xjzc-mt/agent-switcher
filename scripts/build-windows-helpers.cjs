'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helpers = { AgySandbox: 'QuotaProcess', AntigravityCredential: 'AntigravityCredential', DesktopWindows: 'DesktopWindows' };
const hash = data => createHash('sha256').update(data).digest('hex');

// Windows builds use the OS .NET Framework toolchain. Mono mcs also emits Windows .NET Framework assemblies.
function compile(source, executable) {
  const compiler = process.platform === 'win32'
    ? path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : 'mcs';
  execFileSync(compiler, ['-nologo', '-noconfig', '-target:exe', '-platform:anycpu', '-optimize+',
    '-reference:System.dll', '-reference:System.Core.dll', '-reference:System.Xml.dll', '-out:' + executable, source], { stdio: 'inherit', windowsHide: true });
}

async function build(sign) {
  const dist = path.join(root, 'dist');
  const output = path.join(dist, 'windows-helpers');
  fs.mkdirSync(dist, { recursive: true });
  const stage = fs.mkdtempSync(path.join(dist, '.windows-helpers-'));
  try {
    const manifest = {};
    for (const [name, source] of Object.entries(helpers)) {
      const file = name + '.exe';
      compile(path.join(root, 'assets', 'windows', source + '.cs'), path.join(stage, file));
      if (sign) {
        // Sign the staged bytes before pinning their hash. The final helper names are excluded from a second signing pass.
        const staged = path.join(stage, 'staged.exe');
        fs.renameSync(path.join(stage, file), staged);
        await sign(staged);
        fs.renameSync(staged, path.join(stage, file));
      }
      manifest[name] = hash(fs.readFileSync(path.join(stage, file)));
    }
    fs.writeFileSync(path.join(stage, 'sha256.json'), JSON.stringify(manifest) + '\n');
    fs.mkdirSync(output, { recursive: true });
    // Publish the manifest last; a partial build can never pass runtime verification.
    for (const file of [...Object.keys(helpers).map(name => name + '.exe'), 'sha256.json']) {
      fs.renameSync(path.join(stage, file), path.join(output, file));
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

exports.compile = compile;
exports.beforePack = ({ electronPlatformName, packager }) => {
  if (electronPlatformName === 'win32') return build(file => packager.signIf(file));
};
if (require.main === module && process.platform === 'win32') build().catch(error => { console.error(error.message); process.exitCode = 1; });
