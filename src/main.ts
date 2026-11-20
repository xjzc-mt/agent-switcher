import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, clipboard, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { ALL_AGENTS, resolveAgent, dashboard, saveAccount, useAccount, removeAccount, previewRemoveAccount, needsUnmanagedChoice, clientSwitchRevision, setCriticalCommitTracker, renameAccount, refreshAccount, prepareLogin, loginStatus, cancelLogin, RemovalPreview } from './accounts';
import { antigravityLogin } from './antigravity-login';
import { assertNativeSwitchReady, retryNativeKeychainAccess } from './antigravity-native';
import { profileDir, withStoreLock } from './store';
import { hasPendingAntigravitySwitch } from './antigravity-switch-recovery';
import { codexLogin } from './codex-login';
import { runningClients, quitClients, openClients, loginInTerminal, findClaudeBinary } from './clients';
import { exportBackup, parseBackup, parseImport, isEncryptedBackup, installBackup, ParsedBackup, BackupItem, previewCredentialUpdate, installCredentialUpdate } from './backup';
import { CredentialBatch, editableBackup, parseCredentialBatch, installCredentialBatch } from './credential-import';
import type { CredentialUpdateTarget } from './accounts';
import { atomicWrite } from './utils';
import { readSettings, saveSettings } from './settings';
import { randomUUID } from 'crypto';
import { minimumWidth, defaultWidth, updateWindowSidebarLayout } from './window-layout';
import { openPrivateBrowser } from './private-browser';
import { CODEX_CLEANUP_PROMPT } from './cleanup-prompt';
import { maintainCredentialStorage } from './storage-maintenance';
import { AppUpdates } from './app-updates';
import { createQuitGuard } from './app-quit';
import { createTrayPanel, type TraySnapshot, type TrayCommand } from './tray-menu';
import { initializeDiagnostics, runDiagnostic, resultDiagnostic, stepDiagnostic, exportDiagnostics, sourceDiagnosticVersion } from './diagnostics';
import type { StatusResult } from './agents/base';
const deletePreviews = new Map<string, { id: string; preview: RemovalPreview; expires: number }>();
let pendingImport: { id: string; parsed?: ParsedBackup; encrypted?: Buffer; target?: CredentialUpdateTarget; batch?: CredentialBatch } | undefined;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayPanel: ReturnType<typeof createTrayPanel> | undefined;
let traySnapshot: TraySnapshot | undefined;
let trayReady = false;
let pendingTrayCommand: TrayCommand | undefined;
let appUpdates: AppUpdates | undefined;
const projectUrl = 'https://github.com/xjzc-mt/agent-switcher';
const rendererFile = path.join(__dirname, '..', 'renderer', 'index.html');
const loginManagers = new Map([['codex', codexLogin], ['agy', antigravityLogin]]);
const isolatedLogin = (id: string) => resolveAgent(id).management().isolatedLogin ? loginManagers.get(id) : undefined;
function endWindowLogin() {
  return Promise.all([...loginManagers.values()].map(login => login.cancel())).catch(() => { console.warn('无法清理独立登录目录'); });
}
const quitGuard = createQuitGuard({
  hasDrafts: () => [...loginManagers.values()].some(login => login.hasLogin()) ||
    !!(pendingImport?.parsed || pendingImport?.encrypted || pendingImport?.batch),
  isDownloading: () => appUpdates?.isDownloading() ?? false,
  confirm: async () => {
    const detail = [
      [...loginManagers.values()].some(login => login.hasLogin()) ? '未保存的登录将取消；需要保留时请返回保存。' : '',
      pendingImport?.parsed || pendingImport?.encrypted || pendingImport?.batch ? '待确认的导入将取消，原文件保留。' : '',
      appUpdates?.isDownloading() ? '未完成的安装包下载将取消，已下载完成的安装包保留。' : '',
    ].filter(Boolean).join('\n');
    const options = { type: 'question' as const, buttons: ['继续使用', '退出 AgentSwitcher'], defaultId: 0, cancelId: 0,
      message: '退出 AgentSwitcher 前还有未完成的操作', detail };
    const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return result.response === 1;
  },
  cleanup: async () => {
    await Promise.all([...loginManagers.values()].map(login => login.cancel()));
    pendingImport = undefined;
    appUpdates?.stop();
  },
  quit: () => app.quit(),
  onError: error => dialog.showErrorBox('暂时无法退出 AgentSwitcher', error.message),
  onWaiting: waiting => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-quit-state', { waiting }); },
});
setCriticalCommitTracker(work => quitGuard.trackCritical(work));
// ── Window ───────────────────────────────────────────────────────────────────

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    show,
    paintWhenInitiallyHidden: false,
    width: defaultWidth,
    height: 700,
    minWidth: minimumWidth(152),
    minHeight: 620,
    title: 'AgentSwitcher',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    roundedCorners: true,
  });

  mainWindow.loadFile(rendererFile);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('did-start-loading', () => { trayReady = false; });
  mainWindow.webContents.on('render-process-gone', () => { resetTrayWindow(); void endWindowLogin(); });
  mainWindow.on('close', event => {
    if (quitGuard.isClosing() && !quitGuard.canQuit()) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    resetTrayWindow();
    pendingImport = undefined;
    deletePreviews.clear();
    void endWindowLogin();
  });
  return mainWindow;
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function resetTrayWindow() {
  pendingTrayCommand = undefined;
  trayReady = false;
  if (traySnapshot) {
    traySnapshot = { ...traySnapshot, refreshing: false, switching: false, windowClosed: true };
    trayPanel?.update();
  }
}

function revealMainWindow() {
  trayPanel?.hide();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function dispatchTrayCommand(command: TrayCommand) {
  if (quitGuard.isClosing()) return;
  if (command.action === 'quit') { app.quit(); return; }
  const show = command.action !== 'refresh' && command.action !== 'switch';
  const win = mainWindow ?? createWindow(show);
  if (win.webContents.isCrashed()) win.webContents.reload();
  if (show) revealMainWindow();
  if (command.action === 'open') return;
  if (trayReady) win.webContents.send('tray-command', command);
  else if (!pendingTrayCommand || command.action !== 'refresh') {
    pendingTrayCommand = command.action === 'add' && !command.agent ? { ...command, agent: traySnapshot?.selectedAgent } : command;
  }
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  let img: Electron.NativeImage;
  if (fs.existsSync(iconPath)) {
    img = nativeImage.createFromPath(iconPath);
  } else {
    img = nativeImage.createEmpty();
  }
  img.setTemplateImage(true);

  tray = new Tray(img);
  if (process.platform === 'darwin') {
    tray.setToolTip('AgentSwitcher');
    trayPanel = createTrayPanel(tray, () => traySnapshot, dispatchTrayCommand);
    return;
  }
  tray.setToolTip('AgentSwitcher — AI Agent Quota & Account Manager');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open AgentSwitcher',
        click: () => {
          mainWindow ? mainWindow.focus() : createWindow();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
  tray.on('click', () => {
    mainWindow ? mainWindow.focus() : createWindow();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (tray) dispatchTrayCommand({ action: 'open' }); });
app.whenReady().then(async () => {
  const version = app.getVersion();
  const userDataDir = app.getPath('userData');
  initializeDiagnostics(path.join(userDataDir, 'diagnostics'), app.isPackaged ? version : sourceDiagnosticVersion(version));
  if (!app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'packaging', 'app-icon.png'));
  try { await maintainCredentialStorage(); }
  catch (error) { dialog.showErrorBox('账号池安全存储需要处理', (error as Error).message + '\n已有文件已保留；请解锁系统安全存储或恢复备份后重试。'); }
  let downloadsDir: string;
  try { downloadsDir = app.getPath('downloads'); }
  catch { downloadsDir = path.join(userDataDir, 'downloads'); }
  appUpdates = new AppUpdates({
    currentVersion: app.getVersion(), userDataDir, downloadsDir,
    platform: process.platform, arch: process.arch,
    onChange: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-update-state', state); },
  });
  createWindow();
  createTray();
  if (app.isPackaged) appUpdates.start();
  app.on('activate', () => {
    dispatchTrayCommand({ action: 'open' });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', event => {
  if (!app.isReady() || quitGuard.canQuit()) return;
  event.preventDefault();
  void quitGuard.request();
});


// IPC validates its sender once; domain logic is shared with the CLI.
const accountOperations = new Set([
  'save-profile', 'update-from-login', 'delete-profile', 'rename-profile', 'use-profile',
  'export-profiles', 'preview-import', 'unlock-import', 'preview-credentials',
  'preview-credential-update', 'commit-import', 'commit-credential-update', 'launch-login', 'cancel-import', 'cancel-login',
  'save-settings', 'restart-client',
]);
function handle(channel: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame?.url !== pathToFileURL(rendererFile).href) throw new Error('非法调用来源');
    try {
      const invoke = async () => {
        const result = await callback(...args);
        if (result && typeof result === 'object' && 'canceled' in result && result.canceled) resultDiagnostic('canceled');
        return result;
      };
      const execute = async () => accountOperations.has(channel) ? quitGuard.run(invoke) : invoke();
      switch (channel) {
        case 'refresh-account': {
          const trigger = args[3] === 'tray' ? 'tray' : (args[2] || args[3] === 'manual') ? 'manual' : 'automatic';
          return await runDiagnostic('refresh', args[0], trigger, args[1], execute);
        }
        case 'use-profile': return await runDiagnostic('switch', args[0], args[2] === 'tray' ? 'tray' : 'manual', args[1], execute);
        case 'save-profile': return await runDiagnostic('save', args[0], 'manual', args[1], execute);
        case 'update-from-login': return await runDiagnostic('update', args[0], 'manual', args[1], execute);
        case 'commit-credential-update': return await runDiagnostic('update', pendingImport?.target?.agent, 'manual', pendingImport?.target?.profile, execute);
        case 'launch-login': return await runDiagnostic('login', args[0], 'manual', undefined, execute);
        case 'commit-import': return await runDiagnostic('import', undefined, 'manual', undefined, execute);
        case 'export-profiles': return await runDiagnostic('export', undefined, 'manual', undefined, execute);
        case 'delete-profile': return await runDiagnostic('remove', args[0], 'manual', args[1], execute);
        default: return await execute();
      }
    }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  });
}
if (process.platform === 'darwin') {
  function fromMainWindow(event: Electron.IpcMainInvokeEvent) {
    return mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url === pathToFileURL(rendererFile).href;
  }
  ipcMain.handle('tray-reveal-main', event => {
    if (fromMainWindow(event) && !quitGuard.isClosing()) revealMainWindow();
  });
  ipcMain.handle('tray-state', (event, snapshot: TraySnapshot) => {
    if (!fromMainWindow(event)) return;
    traySnapshot = snapshot;
    trayPanel?.update();
  });
  ipcMain.handle('tray-ready', event => {
    if (!fromMainWindow(event)) return;
    trayReady = true;
    if (pendingTrayCommand && !quitGuard.isClosing()) event.sender.send('tray-command', pendingTrayCommand);
    pendingTrayCommand = undefined;
  });
}
function updates() {
  if (!appUpdates) throw new Error('应用更新尚未初始化');
  return appUpdates;
}
handle('get-app-update-state', () => updates().getState());
handle('check-app-updates', () => updates().check());
handle('download-app-update', () => {
  if (quitGuard.isClosing()) throw new Error('AgentSwitcher 正在退出，请稍后重试');
  return updates().download();
});
handle('cancel-app-update', () => { updates().cancel(); return updates().getState(); });
handle('open-app-update', async () => { await updates().openDownloaded(); return { ok: true }; });
handle('set-auto-update-check', (enabled: boolean) => { updates().setAutoCheck(enabled); return updates().getState(); });
handle('quit-for-app-update', () => { setImmediate(() => app.quit()); return { ok: true }; });
handle('open-project-page', async () => {
  await shell.openExternal(projectUrl);
  return { ok: true };
});
handle('get-settings', readSettings);
handle('set-sidebar-layout', (collapsed: boolean, width: number) => updateWindowSidebarLayout(mainWindow, collapsed, width));
handle('save-settings', saveSettings);
handle('copy-cleanup-prompt', () => { clipboard.writeText(CODEX_CLEANUP_PROMPT); return { ok: true }; });
let externalStatusAt = 0;
handle('get-status', async (refresh = false, selectedAgent = 'codex') => {
  // A slow/unavailable unrelated CLI must not delay opening the Codex account pool.
  if (selectedAgent === 'claude' && (refresh === true || !externalStatusAt || Date.now() - externalStatusAt > 30000)) {
    await resolveAgent('claude').status();
    externalStatusAt = Date.now();
  }
  return dashboard();
});
handle('login-status', async (id: string) => {
  const agent = resolveAgent(id);
  const login = isolatedLogin(id);
  if (login) return login.status();
  if (id === 'claude') await agent.status();
  return loginStatus(agent);
});
handle('refresh-account', async (id: string, name?: string, force = false) => {
  if (quitGuard.isClosing()) throw new Error('正在准备退出 AgentSwitcher，请稍后重试');
  const result: StatusResult = await refreshAccount(resolveAgent(id), name, force);
  if (result.authFailure) stepDiagnostic(result.authFailure);
  const outcome = result.state === 'ok' ? 'ok' : result.state === 'unsupported' ? 'unsupported' :
    result.state === 'expired' ? 'expired' : result.state === 'unverified' ? 'waiting' : 'failed';
  resultDiagnostic(outcome, result.fetchedAt);
  return result;
});
handle('export-diagnostics', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow!, {
    title: '导出故障报告', defaultPath: 'AGS-故障报告.json', filters: [{ name: 'JSON', extensions: ['json'] }],
    message: '保存后可将这份脱敏报告发给维护者。',
  });
  if (canceled || !filePath) return { canceled: true };
  const temporary = path.join(path.dirname(filePath), `.ags-report-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(exportDiagnostics(), null, 2), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
  } finally { await fs.promises.rm(temporary, { force: true }); }
  return { ok: true };
});
handle('save-profile', (id: string, name: string, attempt?: number) => {
  if (id === 'agy') retryNativeKeychainAccess();
  return isolatedLogin(id)?.save(name, attempt) ?? saveAccount(resolveAgent(id), name);
});
handle('update-from-login', (id: string, name: string, attempt: number) => {
  const login = isolatedLogin(id);
  if (!login) throw new Error('此平台暂不支持通过重新登录更新凭据');
  return login.update(name, attempt);
});
handle('preview-delete-profile', async (id: string, name: string) => {
  const preview = await previewRemoveAccount(resolveAgent(id), name);
  for (const [key, item] of deletePreviews) if (item.expires < Date.now()) deletePreviews.delete(key);
  // Keep the most recent confirmation for each selected account, including large restored pools.
  const previewId = randomUUID();
  deletePreviews.set(`${id}/${name}`, { id: previewId, preview, expires: Date.now() + 5 * 60000 });
  return { id: previewId, profiles: preview.profiles, current: preview.current, logoutUnsupported: preview.logoutUnsupported };
});
handle('delete-profile', async (id: string, name: string, options: { previewId: string; logout: boolean }) => {
  const key = `${id}/${name}`, pending = deletePreviews.get(key);
  if (!pending || pending.id !== options?.previewId || pending.expires < Date.now() || typeof options.logout !== 'boolean' ||
      pending.preview.agent !== id || pending.preview.profile !== name) throw new Error('删除预览已失效，请重新核对');
  const agent = resolveAgent(id);
  let closedClients: string[] = [];
  if (options.logout) {
    const fresh = await previewRemoveAccount(agent, name);
    if (fresh.signature !== pending.preview.signature || fresh.liveRevision !== pending.preview.liveRevision ||
        !pending.preview.current || !fresh.current || fresh.logoutUnsupported) {
      throw new Error(fresh.logoutUnsupported || '账号或删除范围已变化，请重新核对');
    }
    const clients = await runningClients(id);
    if (clients.length) {
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'question', buttons: ['取消', '退出并移除'], defaultId: 0, cancelId: 0,
        message: `退出 ${clients.join('、')} 并移除此账号？`, detail: '请先完成或停止正在运行的任务。客户端将保持关闭。',
      });
      if (response !== 1) return { canceled: true };
      await quitClients(clients);
      closedClients = clients;
    }
  }
  let result;
  try { result = await removeAccount(agent, name, { preview: pending.preview, logout: options.logout }); }
  catch (error) {
    try {
      if (closedClients.length && agent.identity()?.id === pending.preview.identity) await openClients(closedClients);
    } catch { /* Identity reads and relaunches are best effort after removal fails. */ }
    throw error;
  }
  if (deletePreviews.get(key) === pending) deletePreviews.delete(key);
  // Do not discard an unsaved authorization when an obsolete removal fails.
  try { await isolatedLogin(id)?.cancelIdentity(pending.preview.identity); }
  catch { return { ...result, warning: '账号已移除；独立登录临时副本尚未清理，请关闭添加窗口或重启 AGS 后复查' }; }
  return result;
});
handle('rename-profile', (id: string, oldName: string, newName: string) => renameAccount(resolveAgent(id), oldName, newName));
handle('use-profile', async (id: string, name: string) => {
  const agent = resolveAgent(id);
  // Reject unsupported adapters before prompting to quit or touching a client.
  const unsupported = agent.switchSupport();
  if (unsupported) throw new Error(unsupported);
  if (id === 'agy') retryNativeKeychainAccess();
  const native = id === 'agy' && agent.management().storage === 'keychain';
  const closed = new Set<string>();
  function confirmSwitch(options: Electron.MessageBoxOptions) {
    stepDiagnostic('confirm');
    revealMainWindow();
    return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
  }
  async function closeForSwitch(clients: string[]) {
    await quitClients(clients);
    for (const client of clients) closed.add(client);
  }
  async function switchFromWindow() {
    if (native && hasPendingAntigravitySwitch()) {
      const clients = await runningClients(id, { failClosed: true });
      if (clients.length) {
        const { response } = await confirmSwitch({
          type: 'question', buttons: ['取消', '退出并恢复'], defaultId: 0, cancelId: 0,
          message: '上次 Antigravity 切换中断，需要先核对登录',
          detail: '请先完成正在运行的任务。核对后会继续本次切换，结束时重新打开桌面客户端。',
        });
        if (response !== 1) return { canceled: true };
        await closeForSwitch(clients);
      }
      await withStoreLock(async () => {
        if ((await runningClients(id, { failClosed: true })).length) throw new Error('Antigravity 已重新打开，请先退出后重试');
        await agent.recoverInterruptedSwitch?.();
      });
    }

    const expectedCurrentRevision = clientSwitchRevision(agent);
    let saveUnmanaged: boolean | undefined;
    if (needsUnmanagedChoice(agent, name)) {
      const { response } = await confirmSwitch({
        type: 'question', buttons: ['取消', '不保存并切换', '保存后切换'], defaultId: 2, cancelId: 0,
        message: '当前账号未保存在 AGS，是否先保存？',
        detail: '包括曾从 AGS 移除的账号；只有选择保存才会加入账号池。不保存可能需要重新登录才能再次使用。',
      });
      if (response === 0) return { canceled: true };
      saveUnmanaged = response === 2;
    }
    const clients = await runningClients(id, { failClosed: native });
    const allowFileMigration = native && assertNativeSwitchReady(agent.credentials(profileDir(id, name))[agent.authFiles[0]]) === 'files';
    if (clients.length || allowFileMigration) {
      const details = [];
      if (clients.length) details.push('请先完成或停止正在运行的任务。切换完成后会重新打开客户端。');
      if (allowFileMigration) details.push('完整凭据将保存到 Antigravity 桌面和 CLI 的两个本机认证文件（权限 0600）。两份文件核对成功后，AGS 才会移除该平台原有的个人登录钥匙串项。');
      const { response } = await confirmSwitch({
        type: 'question', buttons: ['取消', clients.length ? '退出并切换' : '使用文件并切换'], defaultId: 0, cancelId: 0,
        message: clients.length ? `需要退出 ${clients.join('、')} 才能切换账号` : '使用官方文件保存长凭据并切换账号？',
        detail: details.join('\n'),
      });
      if (response !== 1) return { canceled: true };
      if (clients.length) await closeForSwitch(clients);
    }
    return useAccount(agent, name, { saveUnmanaged, expectedCurrentRevision, allowFileMigration });
  }
  let result;
  try { result = await switchFromWindow(); }
  catch (error) {
    if (closed.size) { try { await openClients([...closed]); } catch { /* Preserve the original switch error. */ } }
    throw error;
  }
  if (closed.size) {
    stepDiagnostic('client-restart');
    try { await openClients([...closed]); }
    catch {
      const message = `自动重试 2 次后仍无法打开 ${[...closed].join('、')}，请手动启动`;
      if ('canceled' in result) throw new Error(`已取消切换。${message}`);
      revealMainWindow();
      return { ...result, clientRestartError: `账号已切换。${message}` };
    }
  }
  return result;
});
handle('restart-client', async (id: string) => {
  resolveAgent(id);
  const clients = await runningClients(id);
  if (!clients.length) return { ok: true, message: '没有需要重启的桌面客户端；终端会话请手动重启' };
  const { response } = await dialog.showMessageBox(mainWindow!, {
    type: 'question', buttons: ['取消', '重启'], defaultId: 0, cancelId: 0,
    message: `重启 ${clients.join('、')}？`, detail: '请先完成或停止正在运行的任务。',
  });
  if (response !== 1) return { canceled: true };
  await quitClients(clients);
  try { await openClients(clients); }
  catch { throw new Error('自动重试 2 次后仍无法打开客户端，请手动启动'); }
  return { ok: true, message: '客户端已重启' };
});
async function exportItems(items: BackupItem[], password: string) {
  if (!items.length) throw new Error('没有可导出的账号');
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow!, {
    title: '导出加密账号备份', defaultPath: `agent-switcher-${new Date().toISOString().slice(0, 10)}.ags`,
    filters: [{ name: '加密账号备份', extensions: ['ags'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  atomicWrite(filePath, await exportBackup(items, password));
  return { ok: true, count: items.length };
}
handle('export-profiles', exportItems);
function importPreview(parsed: ParsedBackup, pending: typeof pendingImport) {
  if (pendingImport !== pending) return { canceled: true };
  const batch = editableBackup(parsed);
  if (batch) {
    pendingImport = { id: randomUUID(), batch };
    return { id: pendingImport.id, kind: 'credentials', items: batch.items };
  }
  pendingImport = {id:randomUUID(),parsed};
  return {id:pendingImport.id,items:parsed.items};
}
handle('preview-import', async (kind = 'backup', agent?: string) => {
  if (kind === 'credentials') {
    if (agent) resolveAgent(agent);
    const pending = { id: randomUUID() };
    pendingImport = pending;
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
      title: '选择账号凭据', properties: ['openFile'],
      filters: [{ name: '客户端凭据', extensions: ['json', 'jsonl', 'ndjson', 'jsonc'] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (pendingImport !== pending) return { canceled: true };
    if (canceled || !filePaths.length) {
      pendingImport = undefined;
      return { canceled: true };
    }
    if (filePaths.length !== 1) throw new Error('请选择一个凭据文件，文件中可以包含多个账号');
    const file = filePaths[0], stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('请选择凭据文件');
    if (stat.size > 32 * 1024 * 1024) throw new Error('凭据文件超过 32 MB');
    const batch = await parseCredentialBatch(await fs.promises.readFile(file), agent, path.basename(file));
    if (pendingImport !== pending) return { canceled: true };
    pendingImport = { id: randomUUID(), batch };
    return { id: pendingImport.id, kind: 'credentials', items: batch.items };
  }
  const pending = { id: randomUUID() };
  pendingImport = pending;
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
    title: '导入账号或备份', properties: ['openFile'],
    filters: [{ name: '账号备份', extensions: ['ags', 'zip'] }],
  });
  if (canceled || !filePaths[0]) return { canceled: true };
  if ((await fs.promises.stat(filePaths[0])).size > 32 * 1024 * 1024) throw new Error('文件过大');
  const data = await fs.promises.readFile(filePaths[0]);
  if (pendingImport !== pending) return { canceled: true };
  if (isEncryptedBackup(data)) {
    pendingImport = {id:randomUUID(),encrypted:data};
    return {id:pendingImport.id,needsPassword:true,fileName:path.basename(filePaths[0])};
  }
  return importPreview(await parseImport(data), pending);
});
handle('unlock-import', async (id: string, password: string) => {
  if (!pendingImport?.encrypted || pendingImport.id !== id) throw new Error('请重新选择备份文件');
  const pending = pendingImport;
  return importPreview(await parseBackup(pending.encrypted!, password), pending);
});
handle('preview-credentials', async (text: string, id: string) => {
  resolveAgent(id);
  const pending = { id: randomUUID() };
  pendingImport = pending;
  if (typeof text !== 'string') throw new Error('请输入客户端凭据 JSON');
  const batch = await parseCredentialBatch(Buffer.from(text), id);
  if (pendingImport !== pending) return { canceled: true };
  if (batch.items[0].state === 'error' && !batch.items[0].sourceIndex) throw new Error(batch.items[0].error);
  pendingImport = { id: randomUUID(), batch };
  return { id: pendingImport.id, kind: 'credentials', items: batch.items };
});
handle('commit-import', async (id: string, keys: string[], names?: Record<string, string>) => {
  if (pendingImport?.batch && pendingImport.id === id) {
    const pending = pendingImport;
    const result = await installCredentialBatch(pending.batch!, keys, names || {});
    if (pendingImport === pending) pendingImport = undefined;
    return { ok: true, ...result };
  }
  if (!pendingImport?.parsed || pendingImport.target || pendingImport.id !== id) throw new Error('请重新选择备份文件');
  const pending = pendingImport;
  const result = await installBackup(pending.parsed!, keys);
  if (pendingImport === pending) pendingImport = undefined;
  return { ok: true, ...result };
});
handle('preview-credential-update', async (id: string, name: string, text?: string) => {
  const pending = { id: randomUUID() };
  pendingImport = pending;
  resolveAgent(id);
  let data: Buffer;
  if (text === undefined) {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow!, {
      title: '选择新的账号凭据', properties: ['openFile'], filters: [{ name: '客户端凭据', extensions: ['json'] }],
    });
    if (canceled || !filePaths[0]) return { canceled: true };
    if ((await fs.promises.stat(filePaths[0])).size > 1024 * 1024) throw new Error('凭据文件过大');
    data = await fs.promises.readFile(filePaths[0]);
  } else {
    if (typeof text !== 'string') throw new Error('请输入客户端凭据 JSON');
    data = Buffer.from(text);
  }
  if (pendingImport !== pending) return { canceled: true };
  const { parsed, target } = await previewCredentialUpdate(data, id, name);
  if (pendingImport !== pending) return { canceled: true };
  pendingImport = { id: randomUUID(), parsed, target };
  return { id: pendingImport.id, items: parsed.items, updating: true, profile: target.profile };
});
handle('commit-credential-update', async (id: string) => {
  if (!pendingImport?.parsed || !pendingImport.target || pendingImport.id !== id) throw new Error('请重新选择更新凭据');
  const pending = pendingImport;
  const result = await installCredentialUpdate(pending.parsed!, pending.target!);
  if (pendingImport === pending) pendingImport = undefined;
  return result;
});
handle('cancel-import', () => { pendingImport = undefined; });
handle('cancel-login', async (id?: string) => {
  for (const agent of id ? [resolveAgent(id)] : ALL_AGENTS) {
    const login = loginManagers.get(agent.id);
    if (login) await login.cancel(); else cancelLogin(agent);
  }
  return { ok: true };
});
handle('launch-login', async (id: string, mode: 'open' | 'copy' | 'private' = 'open', seenAttempt?: number, updateProfile?: string) => {
  const agent = resolveAgent(id);
  if (!['open', 'copy', 'private'].includes(mode)) throw new Error('未知登录方式');
  const login = isolatedLogin(id);
  if (login) {
    let deliveryMessage: string | undefined;
    const result = await login.useLink(async url => {
      if (mode === 'private') {
        if (readSettings().openPrivateLogin) {
          try {
            const browser = await app.getApplicationInfoForProtocol(url);
            if (await openPrivateBrowser(browser.path, url)) {
              deliveryMessage = '已打开无痕窗口，请完成登录';
              return;
            }
          } catch { /* Preserve the same login link for manual use. */ }
          deliveryMessage = '未能自动打开无痕窗口，链接已复制，可手动粘贴';
        } else deliveryMessage = '链接已复制，可在本机无痕窗口中打开';
        clipboard.writeText(url);
        return;
      }
      if (mode === 'copy') {
        clipboard.writeText(url);
        return;
      }
      try { await shell.openExternal(url); }
      catch { throw new Error('无法打开默认浏览器，可使用旁边的无痕登录入口'); }
    }, seenAttempt, updateProfile);
    if (result.canceled) return result;
    if (result.completed) return { ok: true, message: updateProfile !== undefined ? '登录已完成，请核对账号后更新' : '登录已完成，可保存账号' };
    return { ok: true, message: deliveryMessage || (mode === 'copy' ? '链接已复制，可在本机无痕窗口中打开' : updateProfile !== undefined ? '已打开浏览器，请登录待更新账号' : '已打开浏览器，登录后即可保存账号') };
  }
  if (updateProfile !== undefined) throw new Error('此平台暂不支持通过重新登录更新凭据');
  if (mode !== 'open') throw new Error('此平台不支持无痕登录入口');
  await prepareLogin(agent);
  if (id === 'claude') await loginInTerminal(findClaudeBinary(), ['auth', 'login'], { CLAUDE_CONFIG_DIR: agent.homeDir });
  else await openClients(['Antigravity']);
  externalStatusAt = 0;
  return { ok: true, message: agent.management().canSaveCurrent ? '请在官方客户端完成登录，再返回保存账号' : id === 'claude' ? '已打开 Claude Code 官方登录；完成后刷新登录状态' : '已打开 Antigravity，请在客户端中管理登录账号' };
});
