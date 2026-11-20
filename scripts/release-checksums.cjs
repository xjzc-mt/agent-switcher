const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto');

async function main() {
  const args = process.argv.slice(2);
  let privateKey, signing;
  if (args[0] === '--sign-key') {
    const keyFile = args[1];
    if (!keyFile) throw new Error('请传入仓库外的 Ed25519 私钥文件路径');
    args.splice(0, 2);
    signing = require('../dist/release-manifest');
    privateKey = createPrivateKey(fs.readFileSync(keyFile));
    const trusted = signing.trustedReleaseKey();
    if (privateKey.asymmetricKeyType !== 'ed25519' || !trusted || !trusted.equals(createPublicKey(privateKey))) {
      throw new Error('发布私钥与应用内置的 Ed25519 公钥不匹配');
    }
  }
  const files = args.map(file => path.resolve(file));
  if (!files.length) throw new Error('请传入本次发布的 DMG 路径');
  const directory = path.dirname(files[0]);
  if (new Set(files).size !== files.length || files.some(file =>
    path.dirname(file) !== directory || !/^[\w.-]+\.dmg$/.test(path.basename(file)))) {
    throw new Error('请选择同一目录中的 DMG，文件名只使用字母、数字、点、下划线和连字符，不重复选择');
  }
  const lines = [], manifests = [];
  for (const file of files) {
    const name = path.basename(file);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) { size += chunk.length; hash.update(chunk); }
    const sha256 = hash.digest('hex');
    lines.push(`${sha256}  ${name}`);
    if (privateKey) {
      const version = /^AgentSwitcher-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-arm64\.dmg$/.exec(name)?.[1];
      if (!version || version.length >= 80 || size <= 0 || size >= 2 ** 31) throw new Error('请选择受应用内更新支持的稳定版本、文件名和大小');
      const asset = { version, name, size };
      const signature = sign(null, signing.releaseSigningBytes(asset, sha256), privateKey).toString('base64');
      manifests.push({ ...asset, sha256, signature });
    }
  }
  const target = path.join(directory, 'SHA256SUMS');
  fs.writeFileSync(target, lines.join('\n') + '\n');
  console.log(target);
  for (const manifest of manifests) {
    const file = path.join(directory, signing.manifestName(manifest.name));
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(file);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
