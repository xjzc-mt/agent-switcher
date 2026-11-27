import { contextBridge, ipcRenderer } from 'electron';
import type { TrayCommand, TraySnapshot } from './tray-menu';

// Replies from an earlier opening must not resize or operate on the next panel.
let opening = 0;
contextBridge.exposeInMainWorld('trayPanel', {
  ready: () => ipcRenderer.invoke('tray-panel-ready'),
  onState: (callback: (state: TraySnapshot, reset: boolean) => void) => {
    ipcRenderer.on('tray-panel-state', (_event, state, reset, generation: number) => {
      opening = generation;
      callback(state, reset);
    });
  },
  onRefresh: (callback: () => void) => { ipcRenderer.on('tray-panel-refresh', () => callback()); },
  resize: (height: number) => ipcRenderer.invoke('tray-panel-resize', height, opening),
  close: () => ipcRenderer.invoke('tray-panel-close', opening),
  action: (command: TrayCommand) => ipcRenderer.invoke('tray-panel-action', command, opening),
});
