import { contextBridge, ipcRenderer } from 'electron';
import type { TrayCommand, TraySnapshot } from './tray-menu';
contextBridge.exposeInMainWorld('api', {
  ...(process.platform === 'darwin' && {
    updateTray: (snapshot: TraySnapshot) => ipcRenderer.invoke('tray-state', snapshot),
    trayReady: () => ipcRenderer.invoke('tray-ready'),
    revealTrayMain: () => ipcRenderer.invoke('tray-reveal-main'),
    onTrayCommand: (callback: (command: TrayCommand) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: TrayCommand) => callback(command);
      ipcRenderer.on('tray-command', listener);
      return () => ipcRenderer.removeListener('tray-command', listener);
    },
  }),
  getAppUpdateState: () => ipcRenderer.invoke('get-app-update-state'),
  checkAppUpdates: () => ipcRenderer.invoke('check-app-updates'),
  downloadAppUpdate: () => ipcRenderer.invoke('download-app-update'),
  cancelAppUpdate: () => ipcRenderer.invoke('cancel-app-update'),
  openAppUpdate: () => ipcRenderer.invoke('open-app-update'),
  setAutoUpdateCheck: (enabled: boolean) => ipcRenderer.invoke('set-auto-update-check', enabled),
  quitForAppUpdate: () => ipcRenderer.invoke('quit-for-app-update'),
  openProjectPage: () => ipcRenderer.invoke('open-project-page'),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  onAppUpdateState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state);
    ipcRenderer.on('app-update-state', listener);
    return () => ipcRenderer.removeListener('app-update-state', listener);
  },
  onAppQuitState: (callback: (state: { waiting?: boolean }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { waiting?: boolean }) => callback(state);
    ipcRenderer.on('app-quit-state', listener);
    return () => ipcRenderer.removeListener('app-quit-state', listener);
  },
  getStatus: (refresh = false, selectedAgent = 'codex') => ipcRenderer.invoke('get-status', refresh, selectedAgent),
  setSidebarLayout: (collapsed: boolean, width: number) => ipcRenderer.invoke('set-sidebar-layout', collapsed, width),
  refreshAccount: (id: string, name?: string, force = false, source?: string) => ipcRenderer.invoke('refresh-account', id, name, force, source),
  loginStatus: (id: string) => ipcRenderer.invoke('login-status', id),
  saveProfile: (id: string, name: string, attempt?: number) => ipcRenderer.invoke('save-profile', id, name, attempt),
  updateFromLogin: (id: string, name: string, attempt: number) => ipcRenderer.invoke('update-from-login', id, name, attempt),
  useProfile: (id: string, name: string, source?: string) => ipcRenderer.invoke('use-profile', id, name, source),
  previewDeleteProfile: (id: string, name: string) => ipcRenderer.invoke('preview-delete-profile', id, name),
  deleteProfile: (id: string, name: string, options: { previewId: string; logout: boolean }) => ipcRenderer.invoke('delete-profile', id, name, options),
  renameProfile: (id: string, oldName: string, newName: string) => ipcRenderer.invoke('rename-profile', id, oldName, newName),
  exportProfiles: (items: Array<{ agent: string; profile: string }>, password: string) => ipcRenderer.invoke('export-profiles', items, password),
  previewImport: (kind: string, agent?: string) => ipcRenderer.invoke('preview-import', kind, agent),
  unlockImport: (id: string, password: string) => ipcRenderer.invoke('unlock-import', id, password),
  previewCredentials: (text: string, id: string) => ipcRenderer.invoke('preview-credentials', text, id),
  commitImport: (id: string, keys: string[], names?: Record<string, string>) => ipcRenderer.invoke('commit-import', id, keys, names),
  previewCredentialUpdate: (id: string, name: string, text?: string) => ipcRenderer.invoke('preview-credential-update', id, name, text),
  commitCredentialUpdate: (id: string) => ipcRenderer.invoke('commit-credential-update', id),
  cancelImport: () => ipcRenderer.invoke('cancel-import'),
  cancelLogin: (id?: string) => ipcRenderer.invoke('cancel-login', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  copyCleanupPrompt: () => ipcRenderer.invoke('copy-cleanup-prompt'),
  launchLogin: (id: string, mode: 'open' | 'copy' | 'private' = 'open', seenAttempt?: number, updateProfile?: string) => ipcRenderer.invoke('launch-login', id, mode, seenAttempt, updateProfile),
  restartClient: (id: string) => ipcRenderer.invoke('restart-client', id),
});
