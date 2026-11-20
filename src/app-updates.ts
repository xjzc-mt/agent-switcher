import fs from 'fs';
import path from 'path';
import { createHash, KeyObject, randomUUID } from 'crypto';
import { session, shell, DownloadItem, Session } from 'electron';
import { manifestName, releaseAssetName, ReleaseManifest, trustedReleaseKey, verifyReleaseManifest } from './release-manifest';

const REPO = 'https://github.com/xjzc-mt/agent-switcher';
const API = 'https://api.github.com/repos/xjzc-mt/agent-switcher/releases/latest';
const DAY = 24 * 60 * 60 * 1000;
const DIRECTORY_PREFIX = 'AgentSwitcher-update-';
const stableVersion = (value: unknown): value is string => typeof value === 'string' && value.length < 80 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function newerVersion(version: string, current: string): boolean {
  if (!stableVersion(version) || !stableVersion(current)) return false;
  const a = version.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export interface UpdateRelease {
  version: string; name: string; size: number; url: string;
  notes: string; publishedAt: string; downloadable: boolean;
}
export interface UpdateState {
  currentVersion: string;
  status: 'idle' | 'checking' | 'available' | 'current' | 'unavailable' | 'error' | 'downloading' | 'verifying' | 'downloaded';
  errorStage?: 'check' | 'download';
  autoCheck: boolean; lastCheckedAt?: number;
  message?: string; progress?: number; release?: UpdateRelease;
}
interface ReleaseRecord { info: UpdateRelease; assetUrl: string; manifest?: ReleaseManifest }
interface Options {
  currentVersion: string; userDataDir: string; downloadsDir: string;
  platform: string; arch: string; onChange: (state: UpdateState) => void;
}
interface ActiveDownload {
  record: ReleaseRecord; directory: string; partial: string; destination: string;
  receivedBytes: number; item?: DownloadItem; timeout?: ReturnType<typeof setTimeout>;
}

function releaseUrl(tag: string) { return `${REPO}/releases/tag/${encodeURIComponent(tag)}`; }
function assetUrl(tag: string, name: string) { return `${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`; }
function validAsset(asset: any, tag: string): boolean {
  return asset?.state === 'uploaded' && typeof asset.name === 'string' && asset.name.length < 160 &&
    Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size < 2 ** 31 &&
    asset.browser_download_url === assetUrl(tag, asset.name);
}
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

/** GitHub metadata and native downloads are isolated from account services and renderer URLs. */
export class AppUpdates {
  private state: UpdateState;
  private record?: ReleaseRecord;
  private downloadedPath?: string;
  private active?: ActiveDownload;
  private checking?: Promise<UpdateState>;
  private request?: AbortController;
  private nextAutomaticCheck = 0;
  private retryAt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly file: string;
  private readonly network: Session;

  constructor(private readonly options: Options, private readonly releaseKey: KeyObject | undefined = trustedReleaseKey()) {
    this.file = path.join(options.userDataDir, 'app-updates.json');
    this.state = { currentVersion: options.currentVersion, status: 'idle', autoCheck: true };
    this.readCache();
    this.network = session.fromPartition('ags-app-updates');
    this.network.on('will-download', (event, item) => this.acceptDownload(event, item));
  }

  getState(): UpdateState {
    return { ...this.state, release: this.record ? { ...this.record.info } : undefined };
  }
  private changed(values: Partial<UpdateState>) {
    Object.assign(this.state, values);
    this.options.onChange(this.getState());
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ autoCheck: this.state.autoCheck,
        lastCheckedAt: this.state.lastCheckedAt, nextAutomaticCheck: this.nextAutomaticCheck,
        retryAt: this.retryAt, record: this.record, downloadedPath: this.downloadedPath }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  private ownedFile(file: unknown, name: string): file is string {
    if (typeof file !== 'string' || path.basename(file) !== name) return false;
    const directory = path.dirname(file);
    if (path.dirname(directory) !== path.resolve(this.options.downloadsDir) || !path.basename(directory).startsWith(DIRECTORY_PREFIX)) return false;
    try { return fs.lstatSync(directory).isDirectory() && fs.lstatSync(file).isFile(); } catch { return false; }
  }
  private readCache() {
    try {
      const cached = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state.autoCheck = cached.autoCheck !== false;
      if (Number.isFinite(cached.lastCheckedAt)) this.state.lastCheckedAt = cached.lastCheckedAt;
      const now = Date.now();
      this.nextAutomaticCheck = Math.min(Number(cached.nextAutomaticCheck) || 0, now + DAY);
      this.retryAt = Math.min(Number(cached.retryAt) || 0, now + DAY);
      const record: ReleaseRecord = cached.record, info = record?.info;
      if (info && info.name !== releaseAssetName(info.version, this.options.platform, this.options.arch)) {
        this.nextAutomaticCheck = 0;
        return;
      }
      if (!info || !newerVersion(info.version, this.options.currentVersion) ||
        ![`v${info.version}`, info.version].some(tag => info.url === releaseUrl(tag) && record.assetUrl === assetUrl(tag, info.name)) ||
        typeof info.name !== 'string' || !Number.isSafeInteger(info.size) || info.size <= 0 ||
        typeof info.notes !== 'string' || typeof info.publishedAt !== 'string') return;
      if (!verifyReleaseManifest(record.manifest, info, this.releaseKey)) record.manifest = undefined;
      info.downloadable = !!record.manifest && this.supported();
      this.record = record;
      if (info.downloadable && this.ownedFile(cached.downloadedPath, info.name)) {
        this.downloadedPath = cached.downloadedPath;
        this.state.status = 'downloaded';
      } else this.state.status = 'available';
    } catch { /* An absent or stale cache must not block the application. */ }
  }
  private supported() { return this.options.platform === 'darwin' && ['arm64', 'x64'].includes(this.options.arch); }
  start() {
    if (this.timer || this.stopped) return;
    void this.check(false);
    this.timer = setInterval(() => void this.check(false), 60 * 60 * 1000);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.cancel();
  }
  setAutoCheck(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('无效的更新检查设置');
    this.state.autoCheck = enabled;
    this.save();
    this.changed({});
  }
  isDownloading() { return !!this.active; }

  check(manual = true): Promise<UpdateState> {
    if (this.checking) return this.checking;
    if (this.stopped || this.active || (!manual && (!this.state.autoCheck || Date.now() < this.nextAutomaticCheck))) return Promise.resolve(this.getState());
    if (Date.now() < this.retryAt) {
      if (manual) this.changed({ message: 'GitHub 暂时限制检查频率，请稍后重试' });
      return Promise.resolve(this.getState());
    }
    this.checking = this.performCheck().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async fetchText(url: string, limit: number): Promise<string> {
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.network.fetch(url, { signal: controller.signal, credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `AgentSwitcher/${this.options.currentVersion}` } });
      if (response.status === 404) throw new Error('暂未取得可用版本：项目可能尚未公开或尚未发布 Release');
      if (response.status === 403 || response.status === 429) {
        const retry = Number(response.headers.get('retry-after')) * 1000;
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        this.retryAt = Math.max(Date.now() + (retry || 60000), reset || 0);
        throw new Error('GitHub 暂时限制检查频率，请稍后重试');
      }
      if (!response.ok) throw new Error('暂时无法连接 GitHub，请稍后重试');
      const body = response.body?.getReader();
      if (!body) throw new Error('未收到发布信息');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          controller.abort();
          throw new Error('发布信息过大，无法读取');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { clearTimeout(timeout); if (this.request === controller) this.request = undefined; }
  }
  private async performCheck(): Promise<UpdateState> {
    this.nextAutomaticCheck = Date.now() + DAY;
    this.changed({ status: 'checking', message: undefined, progress: undefined, errorStage: undefined });
    try {
      const release = JSON.parse(await this.fetchText(API, 1024 * 1024));
      const tag = release.tag_name, version = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
      if (release.draft || release.prerelease || !stableVersion(version) || release.html_url !== releaseUrl(tag)) throw new Error('暂未取得可用的正式版本');
      this.state.lastCheckedAt = Date.now();
      if (!newerVersion(version, this.options.currentVersion)) {
        this.record = undefined; this.downloadedPath = undefined;
        this.changed({ status: 'current', message: '当前已是最新版本' });
      } else {
        const name = releaseAssetName(version, this.options.platform, this.options.arch) ?? '';
        const assets = Array.isArray(release.assets) ? release.assets.filter((asset: any) => validAsset(asset, tag)) : [];
        const matches = assets.filter((asset: any) => asset.name === name);
        const asset = matches.length === 1 ? matches[0] : undefined;
        const manifests = assets.filter((entry: any) => entry.name === manifestName(name));
        let manifest: ReleaseManifest | undefined;
        if (asset && this.supported() && this.releaseKey && manifests.length === 1 && manifests[0].size <= 4096) {
          const text = await this.fetchText(manifests[0].browser_download_url, 4096);
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { /* A malformed manifest cannot authorize a download. */ }
          if (verifyReleaseManifest(parsed, { version, name, size: asset.size }, this.releaseKey) &&
              (asset.digest == null || (typeof asset.digest === 'string' && asset.digest.toLowerCase() === `sha256:${parsed.sha256}`))) manifest = parsed;
        }
        if (!manifest || this.record?.info.version !== version || this.record.manifest?.sha256 !== manifest.sha256) this.downloadedPath = undefined;
        this.record = { info: { version, name, size: asset?.size || 0, url: releaseUrl(tag),
          notes: typeof release.body === 'string' ? release.body.slice(0, 8000) : '',
          publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
          downloadable: !!manifest && this.supported() }, assetUrl: asset?.browser_download_url || '', manifest };
        const message = !this.supported() ? '请前往 GitHub 发布页下载适用于此系统的安装包' :
          !asset ? '此版本没有适用于此 Mac 的安装包，可在 GitHub 项目页查看发布信息' :
          !manifest ? '此版本缺少有效的发布者签名，可在 GitHub 项目页查看发布信息' : undefined;
        this.changed({ status: this.downloadedPath ? 'downloaded' : 'available', message });
      }
      this.save();
    } catch (error) {
      if (!this.stopped) {
        const message = (error as Error).name === 'AbortError' ? '检查新版超时，请稍后重试' : (error as Error).message;
        this.changed({ status: this.downloadedPath ? 'downloaded' : message.startsWith('暂未取得') ? 'unavailable' : 'error', message, errorStage: 'check' });
        try { this.save(); } catch { /* Preserve the usable application if its update cache cannot be saved. */ }
      }
    }
    return this.getState();
  }

  private armDownloadTimeout(active: ActiveDownload, message: string, ms = 60000) {
    clearTimeout(active.timeout);
    active.timeout = setTimeout(() => this.failDownload(active, message), ms);
    active.timeout.unref?.();
  }
  async download(): Promise<UpdateState> {
    if (this.active || this.downloadedPath) return this.getState();
    if (this.stopped || this.checking || !this.record?.info.downloadable || !this.record.manifest) throw new Error('暂无可下载的已校验版本，请先检查新版');
    fs.mkdirSync(this.options.downloadsDir, { recursive: true });
    const directory = fs.mkdtempSync(path.join(path.resolve(this.options.downloadsDir), DIRECTORY_PREFIX));
    const destination = path.join(directory, this.record.info.name);
    const active: ActiveDownload = { record: this.record, directory, destination, partial: `${destination}.partial`, receivedBytes: 0 };
    this.active = active;
    this.changed({ status: 'downloading', progress: 0, message: undefined, errorStage: undefined });
    this.armDownloadTimeout(active, '无法开始下载，请重试，或从 GitHub 项目页下载', 30000);
    try { this.network.downloadURL(active.record.assetUrl); }
    catch { this.failDownload(active, '无法开始下载，请重试，或从 GitHub 项目页下载'); }
    return this.getState();
  }
  private acceptDownload(event: Electron.Event, item: DownloadItem) {
    const active = this.active;
    if (!active || active.item || !item.getURLChain().includes(active.record.assetUrl)) { event.preventDefault(); return; }
    const expected = active.record.info.size, declared = item.getTotalBytes();
    const sizeError = '安装包大小与发布签名不符，已取消下载';
    if ((declared > 0 && declared !== expected) || item.getReceivedBytes() > expected) {
      event.preventDefault();
      this.failDownload(active, sizeError);
      return;
    }
    this.armDownloadTimeout(active, '下载超时，请重试，或从 GitHub 项目页下载');
    active.item = item;
    item.setSavePath(active.partial);
    item.on('updated', (_event, status) => {
      if (this.active !== active) return;
      if (status === 'interrupted') this.failDownload(active, '下载已中断，请重试，或从 GitHub 项目页下载');
      else {
        const received = item.getReceivedBytes();
        if (received > expected) return this.failDownload(active, sizeError);
        if (received > active.receivedBytes) {
          active.receivedBytes = received;
          this.armDownloadTimeout(active, '下载超时，请重试，或从 GitHub 项目页下载');
        }
        this.changed({ progress: Math.min(99, Math.floor(received / active.record.info.size * 100)) });
      }
    });
    item.once('done', (_event, status) => {
      if (this.active !== active) return;
      clearTimeout(active.timeout);
      if (status !== 'completed') this.failDownload(active, '下载未完成，请重试，或从 GitHub 项目页下载');
      else void this.finishDownload(active);
    });
  }
  private cleanup(active: ActiveDownload) {
    try { fs.rmSync(active.partial, { force: true }); fs.rmdirSync(active.directory); } catch { /* Never remove unrelated files. */ }
  }
  private failDownload(active: ActiveDownload, message: string) {
    if (this.active !== active) return;
    this.active = undefined;
    clearTimeout(active.timeout);
    try { active.item?.cancel(); } catch { /* Electron may already have destroyed a completed or interrupted item. */ }
    this.cleanup(active);
    this.changed({ status: 'error', progress: undefined, message, errorStage: 'download' });
  }
  private async finishDownload(active: ActiveDownload) {
    this.changed({ status: 'verifying', progress: 100 });
    try {
      const stat = fs.lstatSync(active.partial);
      if (!stat.isFile() || stat.size !== active.record.info.size || await sha256(active.partial) !== active.record.manifest?.sha256) throw new Error('安装包校验失败，请重新下载');
      if (this.active !== active) return;
      fs.renameSync(active.partial, active.destination);
      this.downloadedPath = active.destination;
      this.active = undefined;
      this.changed({ status: 'downloaded', progress: undefined, message: undefined });
      try { this.save(); }
      catch { this.changed({ message: '安装包已下载，可正常打开；下载记录未能保存，重启后可在下载目录中找到' }); }
    } catch (error) { this.failDownload(active, (error as Error).message); }
  }
  cancel() {
    const active = this.active;
    if (!active) return;
    this.failDownload(active, '已取消下载');
    this.changed({ status: 'available', message: undefined, errorStage: undefined });
  }
  async openDownloaded() {
    const file = this.downloadedPath, record = this.record;
    let message: string | undefined;
    try {
      if (!record?.manifest || !this.ownedFile(file, record.info.name)) message = '安装包不存在，请重新下载';
      else if (fs.statSync(file).size !== record.info.size || await sha256(file) !== record.manifest.sha256) message = '安装包已改变，请重新下载';
    } catch { message = '安装包无法读取，请重新下载'; }
    if (message || !file) {
      this.downloadedPath = undefined;
      this.changed({ status: 'available', message, errorStage: undefined });
      try { this.save(); } catch { /* The invalid in-memory path is already cleared. */ }
      throw new Error(message);
    }
    const error = await shell.openPath(file);
    if (error) throw new Error('无法打开安装包，请在下载目录中手动打开');
  }
}
