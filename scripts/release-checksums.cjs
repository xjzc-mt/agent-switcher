const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto');

const RETIRED_VERSIONS = new Set(['1.0.0', '1.0.1']);
const TARGETS = [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']];

function loadSigning(keyFile) {
  if (!keyFile) throw new Error('请传入仓库外的 Ed25519 私钥文件路径');
  const signing = require('../dist/release-manifest');
  const privateKey = createPrivateKey(fs.readFileSync(keyFile));
  const trusted = signing.trustedReleaseKey();
  if (privateKey.asymmetricKeyType !== 'ed25519' || !trusted || !trusted.equals(createPublicKey(privateKey))) {
    throw new Error('发布私钥与应用内置的 Ed25519 公钥不匹配');
  }
  return { signing, privateKey, trusted };
}

function writeManifests(directory, entries, auth) {
  const sumsFile = path.join(directory, 'SHA256SUMS');
  fs.writeFileSync(sumsFile, entries.map(e => `${e.sha256}  ${e.name}`).join('\n') + '\n');
  console.log(sumsFile);
  const written = [sumsFile];
  if (!auth) return written;
  const { signing, privateKey, trusted } = auth;
  for (const { version, name, size, sha256 } of entries) {
    const asset = { version, name, size };
    const signature = sign(null, signing.releaseSigningBytes(asset, sha256), privateKey).toString('base64');
    const manifest = { ...asset, sha256, signature };
    if (!signing.verifyReleaseManifest(manifest, asset, trusted)) throw new Error(`签名清单自检未通过: ${name}`);
    const file = path.join(directory, signing.manifestName(name));
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    console.log(file);
    written.push(file);
  }
  return written;
}

function signGithubRelease({ releaseTag, keyFile, commit, repo = 'xjzc-mt/agent-switcher', publish = false }, exec = execFileSync) {
  const auth = loadSigning(keyFile || process.env.AGS_RELEASE_SIGN_KEY);
  const version = String(releaseTag || '').replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.length >= 80 || RETIRED_VERSIONS.has(version)) {
    throw new Error('发布版本号无效或属于已退役版本');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GitHub 仓库标识格式无效');
  const tag = `v${version}`;
  const expectedSha = (commit || exec('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('目标构建提交必须是完整的 40 位 SHA');

  const releases = JSON.parse(exec('gh', ['api', `repos/${repo}/releases?per_page=30`], { encoding: 'utf8' }));
  const matches = Array.isArray(releases) ? releases.filter(r => r && r.tag_name === tag) : [];
  if (matches.length !== 1) throw new Error(`未找到唯一的 GitHub Release (${tag})`);
  const release = matches[0];
  if (String(release.target_commitish || '').toLowerCase() !== expectedSha) {
    throw new Error(`Release ${tag} 构建提交 (${release.target_commitish}) 与预期提交 (${expectedSha}) 不一致`);
  }

  const runsDoc = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/workflows/release-build.yml/runs?head_sha=${expectedSha}&status=completed`], { encoding: 'utf8' }));
  const runs = Array.isArray(runsDoc?.workflow_runs) ? runsDoc.workflow_runs : [];
  if (!runs.some(r => String(r.head_sha || '').toLowerCase() === expectedSha && r.conclusion === 'success')) {
    throw new Error(`未找到提交 ${expectedSha} 已成功的 release-build.yml 打包记录`);
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const entries = TARGETS.map(([platform, arch]) => {
    const name = auth.signing.releaseAssetName(version, platform, arch);
    const uploaded = assets.filter(a => a && a.name === name && a.state === 'uploaded');
    if (uploaded.length !== 1) throw new Error(`Release ${tag} 缺少已上传的安装包: ${name}`);
    const { size, digest } = uploaded[0];
    const match = /^sha256:([a-f0-9]{64})$/i.exec(String(digest || ''));
    if (!Number.isSafeInteger(size) || size <= 0 || size >= 2 ** 31 || !match) {
      throw new Error(`安装包 ${name} 缺少有效的大小或 GitHub SHA-256 摘要`);
    }
    return { version, name, size, sha256: match[1].toLowerCase() };
  });

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ags-release-sign-'));
  fs.chmodSync(stage, 0o700);
  try {
    const written = writeManifests(stage, entries, auth);
    exec('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...written], { stdio: 'inherit' });
    if (publish) {
      exec('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease=false', '--latest'], { stdio: 'inherit' });
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let hasSignKey = false, keyFile = '', releaseTag = '', commit = '', publish = false;
  let repo = process.env.AGS_GITHUB_REPO || 'xjzc-mt/agent-switcher';
  const rawFiles = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sign-key') { hasSignKey = true; keyFile = args[++i] || ''; }
    else if (arg === '--github-release') releaseTag = args[++i] || '';
    else if (arg === '--commit') commit = args[++i] || '';
    else if (arg === '--repo') repo = args[++i] || '';
    else if (arg === '--publish') publish = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
    else rawFiles.push(arg);
  }

  if (releaseTag) {
    if (rawFiles.length) throw new Error('--github-release 免下载模式无需传入本地安装包路径');
    return signGithubRelease({ releaseTag, keyFile, commit, repo, publish });
  }

  const auth = hasSignKey ? loadSigning(keyFile) : null;
  const files = rawFiles.map(file => path.resolve(file));
  if (!files.length) throw new Error('请传入本次发布的 DMG/EXE 路径，或使用 --github-release <tag>');
  const directory = path.dirname(files[0]);
  if (new Set(files).size !== files.length || files.some(file =>
    path.dirname(file) !== directory || !/^[\w.-]+\.(dmg|exe)$/.test(path.basename(file)))) {
    throw new Error('请选择同一目录中的 DMG 或 EXE，文件名只使用字母、数字、点、下划线和连字符，不重复选择');
  }
  const entries = [];
  for (const file of files) {
    const name = path.basename(file);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) { size += chunk.length; hash.update(chunk); }
    const sha256 = hash.digest('hex');
    let version = '';
    if (auth) {
      const [, parsed, arch, ext] = /-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-(arm64|x64)\.(dmg|exe)$/.exec(name) || [];
      version = parsed || '';
      if (!version || version.length >= 80 || RETIRED_VERSIONS.has(version) ||
          name !== auth.signing.releaseAssetName(version, ext === 'dmg' ? 'darwin' : 'win32', arch) ||
          size <= 0 || size >= 2 ** 31) throw new Error('安装包的版本、文件名或大小不符合发布要求');
      if (entries.length && entries[0].version !== version) throw new Error('一次只能为同一版本的安装包签名');
    }
    entries.push({ version, name, size, sha256 });
  }
  writeManifests(directory, entries, auth);
}

module.exports = { signGithubRelease };
if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
