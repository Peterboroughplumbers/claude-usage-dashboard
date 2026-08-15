import { contextBridge, ipcRenderer } from 'electron';
import type { IPC as SharedIPC, AccountId, DashboardApi, DashboardState, Settings } from '../shared/types';

/**
 * Minimal, typed bridge. The renderer never gets access to Node, Electron,
 * the file system or the browser profiles.
 *
 * NOTE: sandboxed preload scripts cannot `require` project files, so the
 * channel names are repeated here. `satisfies typeof SharedIPC` makes the
 * compiler fail if they ever drift from src/shared/types.ts.
 */
const IPC = {
  getState: 'dashboard:get-state',
  stateChanged: 'dashboard:state-changed',
  refreshAll: 'dashboard:refresh-all',
  refreshOne: 'dashboard:refresh-one',
  login: 'dashboard:login',
  openClaude: 'dashboard:open-claude',
  focusWindow: 'dashboard:focus-window',
  loginNavigate: 'dashboard:login-navigate',
  terminalOpen: 'dashboard:terminal-open',
  addAccount: 'dashboard:add-account',
  removeAccount: 'dashboard:remove-account',
  saveSettings: 'dashboard:save-settings',
  minimize: 'window:minimize',
  close: 'window:close',
} as const satisfies typeof SharedIPC;

const api: DashboardApi = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<DashboardState>,
  refreshAll: () => ipcRenderer.invoke(IPC.refreshAll) as Promise<void>,
  refreshOne: (id: AccountId) => ipcRenderer.invoke(IPC.refreshOne, id) as Promise<void>,
  login: (id: AccountId) => ipcRenderer.invoke(IPC.login, id) as Promise<void>,
  openClaude: (id: AccountId) => ipcRenderer.invoke(IPC.openClaude, id) as Promise<void>,
  focusWindow: (id: AccountId) => ipcRenderer.invoke(IPC.focusWindow, id) as Promise<void>,
  loginNavigate: (id: AccountId, url: string) => ipcRenderer.invoke(IPC.loginNavigate, id, url) as Promise<string | null>,
  terminalOpen: (id: AccountId) => ipcRenderer.invoke(IPC.terminalOpen, id) as Promise<string | null>,
  addAccount: () => ipcRenderer.invoke(IPC.addAccount) as Promise<AccountId | null>,
  removeAccount: (id: AccountId) => ipcRenderer.invoke(IPC.removeAccount, id) as Promise<void>,
  saveSettings: (settings: Settings) => ipcRenderer.invoke(IPC.saveSettings, settings) as Promise<void>,
  minimize: () => ipcRenderer.send(IPC.minimize),
  close: () => ipcRenderer.send(IPC.close),
  onStateChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, state: DashboardState): void => cb(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler);
  },
};

contextBridge.exposeInMainWorld('dashboard', api);
