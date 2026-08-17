import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { IPC, type AccountId, type Settings } from '../shared/types';
import { AccountManager } from './accounts';
import { BrowserManager } from './browser';
import { initLogger, log } from './logger';
import { Store } from './store';
import { sanitizeSettings } from './store';

const WINDOW_WIDTH = 340;
const WINDOW_HEIGHT = 720;
const isDev = process.env['NODE_ENV'] === 'development';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager: AccountManager | null = null;
let quitting = false;
let edgeAutoHide = false;

// Single instance: a second launch just focuses the existing widget.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(bootstrap);
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  initLogger(userData);
  log.info(`Starting Claude Usage Dashboard v${app.getVersion()} (userData=${userData})`);

  const store = new Store(userData);
  const browsers = new BrowserManager(userData);
  const localBin = join(app.getPath('home'), '.local', 'bin');
  manager = new AccountManager(
    store,
    browsers,
    app.getVersion(),
    join(userData, 'helpers'),
    existsSync(localBin) ? localBin : null,
  );

  registerIpc(manager);
  createWindow(store.settings);
  createTray();
  applyStartupSetting(store.settings.launchAtStartup);
  applyEdgeAutoHide(store.settings.edgeAutoHide, true);

  manager.onChange((state) => {
    mainWindow?.webContents.send(IPC.stateChanged, state);
    updateTrayTooltip();
  });
  manager.startTimer();
  // Initial refresh shortly after start (only accounts that have a profile launch a browser).
  setTimeout(() => void manager?.refreshAll(), 1500);
  // Claude Code (terminal) sign-in state per account, in the background.
  setTimeout(() => void manager?.refreshTerminalStatus(), 800);
}

function createWindow(settings: Settings): void {
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 300,
    minHeight: 420,
    maxWidth: 520,
    x: workArea.x + workArea.width - WINDOW_WIDTH - 16,
    y: workArea.y + 16,
    title: 'Claude Usage Dashboard',
    frame: false,
    resizable: true,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    // Transparent window: the renderer paints its own (adjustable) background so the
    // desktop can show through ("glass" mode).
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    icon: iconPath(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  void mainWindow.loadFile(join(__dirname, '../ui/renderer/index.html'));
  const startHidden = (process.argv.includes('--hidden') && settings.minimizeToTray) || settings.edgeAutoHide;
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow?.show();
  });

  // Forward renderer errors to the log so UI problems are diagnosable in production.
  mainWindow.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      log.warn(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });

  // Block any navigation / new windows inside the widget.
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('close', (e) => {
    if (quitting) return;
    if (manager?.getState().settings.minimizeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

function iconPath(): string {
  return join(app.getAppPath(), 'assets', 'icon.png');
}

function createTray(): void {
  let image = nativeImage.createFromPath(iconPath());
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Claude Usage Dashboard');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Dashboard', click: () => showWindow() },
      { label: 'Refresh Now', click: () => void manager?.refreshAll() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function updateTrayTooltip(): void {
  if (!tray || !manager) return;
  const state = manager.getState();
  const lines = state.accounts.map((a) => {
    if (a.usage) return `${a.name}: S ${fmt(a.usage.sessionPercent)} / W ${fmt(a.usage.weeklyPercent)}`;
    return `${a.name}: ${a.error === 'login_required' ? 'Login required' : 'Unable to read'}`;
  });
  tray.setToolTip(['Claude Usage Dashboard', ...lines].join('\n'));
}

function fmt(v: number | null): string {
  return v === null ? '–' : `${v}%`;
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ------------------------- edge auto-hide (hover) -------------------------- */

const EDGE_POLL_MS = 100;
const EDGE_TRIGGER_PX = 2; // how close to the right screen edge the cursor must be
const EDGE_LEAVE_MARGIN_PX = 24; // slack around the window before it counts as "left"
const EDGE_HIDE_DELAY_MS = 700;
let edgeTimer: NodeJS.Timeout | null = null;
let edgeLeftSince: number | null = null;

/** Docks the window flush against the right edge of the primary display (keeps its y). */
function dockToRightEdge(): void {
  if (!mainWindow) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = mainWindow.getSize();
  const [, y] = mainWindow.getPosition();
  const maxY = workArea.y + workArea.height - h;
  mainWindow.setPosition(workArea.x + workArea.width - w, Math.max(workArea.y, Math.min(y, maxY)));
}

function revealFromEdge(): void {
  if (!mainWindow || mainWindow.isVisible()) return;
  dockToRightEdge();
  // Do not steal focus from whatever the user is working in – just peek in.
  mainWindow.showInactive();
  mainWindow.moveTop();
  edgeLeftSince = null;
}

function edgeTick(): void {
  if (!mainWindow || !edgeAutoHide) return;
  const cursor = screen.getCursorScreenPoint();
  const { bounds } = screen.getPrimaryDisplay();
  const atRightEdge =
    cursor.x >= bounds.x + bounds.width - EDGE_TRIGGER_PX &&
    cursor.y >= bounds.y &&
    cursor.y < bounds.y + bounds.height;

  if (!mainWindow.isVisible()) {
    if (atRightEdge) revealFromEdge();
    return;
  }

  const b = mainWindow.getBounds();
  const inside =
    cursor.x >= b.x - EDGE_LEAVE_MARGIN_PX &&
    cursor.x <= b.x + b.width + EDGE_LEAVE_MARGIN_PX &&
    cursor.y >= b.y - EDGE_LEAVE_MARGIN_PX &&
    cursor.y <= b.y + b.height + EDGE_LEAVE_MARGIN_PX;
  if (inside || atRightEdge) {
    edgeLeftSince = null;
    return;
  }
  edgeLeftSince ??= Date.now();
  if (Date.now() - edgeLeftSince >= EDGE_HIDE_DELAY_MS) {
    edgeLeftSince = null;
    mainWindow.hide();
  }
}

function applyEdgeAutoHide(enabled: boolean, initial = false): void {
  edgeAutoHide = enabled;
  if (edgeTimer) {
    clearInterval(edgeTimer);
    edgeTimer = null;
  }
  edgeLeftSince = null;
  if (!mainWindow) return;
  if (enabled) {
    // The widget has to float above other windows to be usable as a hover-in panel.
    mainWindow.setAlwaysOnTop(true, 'floating');
    dockToRightEdge(); // it hides by itself once the cursor leaves it
    edgeTimer = setInterval(edgeTick, EDGE_POLL_MS);
  } else {
    mainWindow.setAlwaysOnTop(manager?.getState().settings.alwaysOnTop ?? false, 'floating');
    if (!initial && !mainWindow.isVisible()) showWindow();
  }
}

function applyStartupSetting(enabled: boolean): void {
  if (isDev || !app.isPackaged) return; // avoid registering the dev electron binary
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] });
  } catch (err) {
    log.warn('Could not update login item settings', err);
  }
}

function registerIpc(m: AccountManager): void {
  const isAccountId = (v: unknown): v is AccountId => typeof v === 'number' && Number.isInteger(v) && m.hasAccount(v);
  ipcMain.handle(IPC.getState, () => m.getState());
  ipcMain.handle(IPC.refreshAll, () => m.refreshAll());
  ipcMain.handle(IPC.refreshOne, (_e, id: unknown) => (isAccountId(id) ? m.refreshOne(id) : undefined));
  ipcMain.handle(IPC.login, (_e, id: unknown) => (isAccountId(id) ? m.login(id) : undefined));
  ipcMain.handle(IPC.openClaude, (_e, id: unknown) => (isAccountId(id) ? m.openClaude(id) : undefined));
  ipcMain.handle(IPC.focusWindow, (_e, id: unknown) => (isAccountId(id) ? m.focusWindow(id) : undefined));
  ipcMain.handle(IPC.loginNavigate, (_e, id: unknown, url: unknown) =>
    isAccountId(id) && typeof url === 'string' ? m.loginNavigate(id, url) : 'Invalid request',
  );
  ipcMain.handle(IPC.terminalOpen, (_e, id: unknown) => (isAccountId(id) ? m.openTerminal(id) : 'Invalid request'));
  ipcMain.handle(IPC.addAccount, () => m.addAccount());
  ipcMain.handle(IPC.removeAccount, (_e, id: unknown) => (isAccountId(id) ? m.removeAccount(id) : undefined));
  ipcMain.handle(IPC.saveSettings, (_e, raw: unknown) => {
    const settings = sanitizeSettings(raw);
    m.applySettings(settings);
    mainWindow?.setAlwaysOnTop(settings.alwaysOnTop || settings.edgeAutoHide, 'floating');
    applyStartupSetting(settings.launchAtStartup);
    if (settings.edgeAutoHide !== edgeAutoHide) applyEdgeAutoHide(settings.edgeAutoHide);
  });
  ipcMain.on(IPC.minimize, () => {
    if (m.getState().settings.minimizeToTray) mainWindow?.hide();
    else mainWindow?.minimize();
  });
  ipcMain.on(IPC.close, () => mainWindow?.close());
}

app.on('window-all-closed', () => {
  // Keep running in tray unless quitting explicitly.
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (e) => {
  if (manager) {
    const m = manager;
    manager = null;
    e.preventDefault();
    void m.shutdown().finally(() => app.quit());
  }
});

app.on('activate', () => showWindow());

process.on('uncaughtException', (err) => log.error('Uncaught exception', err));
process.on('unhandledRejection', (err) => log.error('Unhandled rejection', err));
