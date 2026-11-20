import { createPublicKey, KeyObject, verify } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ReleaseAsset { version: string; name: string; size: number }
export interface ReleaseManifest extends ReleaseAsset { sha256: string; signature: string }
export const manifestName = (assetName: string) => `${assetName}.signed.json`;

export function releaseAssetName(version: string, platform: string, arch: string): string | undefined {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `AgentSwitcher-${version}-${arch}.dmg`;
  if (platform === 'win32' && arch === 'x64') return `AgentSwitcher-Setup-${version}-x64.exe`;
}

export function trustedReleaseKey(): KeyObject | undefined {
  try {
    const key = createPublicKey(fs.readFileSync(path.join(__dirname, '../assets/release-signing-public.pem')));
    if (key.asymmetricKeyType === 'ed25519') return key;
  } catch { /* Releases can still be viewed if the installed trust anchor is unavailable. */ }
}

/** A fixed field order and domain bind the signed bytes independently of JSON formatting. */
export function releaseSigningBytes(asset: ReleaseAsset, sha256: string): Buffer {
  return Buffer.from(JSON.stringify(['com.agent-switcher.app/release/v1', asset.version, asset.name, asset.size, sha256]));
}

export function verifyReleaseManifest(manifest: unknown, asset: ReleaseAsset, key: KeyObject | undefined): manifest is ReleaseManifest {
  if (!key || key.asymmetricKeyType !== 'ed25519' || !manifest || typeof manifest !== 'object') return false;
  const m = manifest as Partial<ReleaseManifest>;
  if (m.version !== asset.version || m.name !== asset.name || m.size !== asset.size ||
      typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) ||
      typeof m.signature !== 'string' || m.signature.length !== 88) return false;
  const signature = Buffer.from(m.signature, 'base64');
  return signature.length === 64 && signature.toString('base64') === m.signature &&
    verify(null, releaseSigningBytes(asset, m.sha256), key, signature);
}
