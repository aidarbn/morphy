// The desktop shell: starts morphy-service, opens the web app in a window, and adds what a
// browser can't offer — native dialogs to open and create databases, and a menu.

import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions, session, shell } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { appPaths, type AppPaths } from './paths';
import { type RunningService, ServiceError, startService } from './service';

// The multi-threaded Stockfish needs SharedArrayBuffer, which needs a cross-origin isolated
// page: these headers on every response of the app's origin
const CROSS_ORIGIN_ISOLATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const DATABASE_EXTENSIONS = ['cbh', '2cbh', 'pgn'];

let paths: AppPaths;
let service: RunningService | null = null;
let mainWindow: BrowserWindow | null = null;
let logFile: string | null = null;

function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}`;
  if (logFile) {
    try {
      appendFileSync(logFile, stamped + '\n');
    } catch {
      // the log is best effort
    }
  }
  if (!app.isPackaged) console.log(stamped);
}

// ---------------------------------------------------------------------------------------------
// The service's API, as the shell calls it

interface DatabaseInfo {
  id: string;
  displayName: string;
  path: string;
  readOnly: boolean;
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!service) throw new Error('The service is not running');
  const res = await fetch(service.origin + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? text;
    } catch {
      // plain text
    }
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function listDatabases(): Promise<DatabaseInfo[]> {
  const body = await api<{ databases: DatabaseInfo[] }>('GET', '/api/databases');
  return body.databases;
}

/** An id for a database file, unique among those registered: from its name, numbered if taken */
function databaseId(file: string, taken: Set<string>): string {
  const base =
    basename(file, extname(file))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'database';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function databasesChanged() {
  mainWindow?.webContents.send('databases-changed');
}

async function openDatabase() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open database',
    properties: ['openFile'],
    filters: [
      { name: 'Chess databases', extensions: DATABASE_EXTENSIONS },
      { name: 'ChessBase (classic)', extensions: ['cbh'] },
      { name: 'ChessBase (new)', extensions: ['2cbh'] },
      { name: 'PGN', extensions: ['pgn'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const file = result.filePaths[0];
  try {
    const existing = await listDatabases();
    const already = existing.find((d) => d.path === file);
    if (already) {
      databasesChanged();
      return;
    }
    const id = databaseId(file, new Set(existing.map((d) => d.id)));
    await api('POST', '/api/databases/register', { id, displayName: basename(file, extname(file)), path: file });
    log(`registered database ${id}: ${file}`);
    databasesChanged();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`opening ${file} failed: ${message}`);
    dialog.showErrorBox('Opening the database failed', message);
  }
}

async function newDatabase() {
  if (!mainWindow) return;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'New database',
    defaultPath: join(app.getPath('documents'), 'New database.2cbh'),
    filters: [
      { name: 'ChessBase (new, .2cbh)', extensions: ['2cbh'] },
      { name: 'ChessBase (classic, .cbh)', extensions: ['cbh'] },
      { name: 'PGN', extensions: ['pgn'] },
    ],
  });
  if (result.canceled || !result.filePath) return;
  let file = result.filePath;
  if (!DATABASE_EXTENSIONS.includes(extname(file).slice(1).toLowerCase())) file += '.2cbh';
  try {
    const existing = await listDatabases();
    const id = databaseId(file, new Set(existing.map((d) => d.id)));
    await api('POST', '/api/databases', { id, displayName: basename(file, extname(file)), path: file });
    log(`created database ${id}: ${file}`);
    databasesChanged();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`creating ${file} failed: ${message}`);
    dialog.showErrorBox('Creating the database failed', message);
  }
}

// ---------------------------------------------------------------------------------------------
// The window and the menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Open Database…', accelerator: 'CmdOrCtrl+O', click: () => void openDatabase() },
        { label: 'New Database…', accelerator: 'CmdOrCtrl+Shift+N', click: () => void newDatabase() },
        { type: 'separator' },
        {
          label: 'Show Data Folder',
          click: () => void shell.openPath(paths.dataDir),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Morphy on GitHub',
          click: () => void shell.openExternal('https://github.com/Yarin78/morphy'),
        },
        {
          label: 'About Morphy',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'About Morphy',
              message: `Morphy ${app.getVersion()}`,
              detail: `Browse, search and edit chess databases.\n\nService: ${service?.origin ?? 'not running'}\nData: ${paths.dataDir}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function splashHtml(message: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Morphy</title>
<style>
  html,body{height:100%;margin:0;font-family:system-ui,sans-serif;background:#2b2b2b;color:#e8e2d6}
  body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
  h1{font-weight:600;font-size:28px;margin:0}
  p{margin:0;opacity:.8}
  .bar{width:200px;height:3px;background:#4a4a4a;border-radius:2px;overflow:hidden}
  .bar i{display:block;width:40%;height:100%;background:#c8a96a;animation:slide 1.2s infinite ease-in-out}
  @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
</style></head><body><h1>Morphy</h1><p>${message}</p><div class="bar"><i></i></div></body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    title: 'Morphy',
    backgroundColor: '#2b2b2b',
    icon: join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  // Links to the outside open in the browser, not in the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (service && url.startsWith(service.origin)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function installIsolationHeaders() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (service && details.url.startsWith(service.origin)) {
      const headers = { ...details.responseHeaders };
      for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION)) headers[name] = [value];
      callback({ responseHeaders: headers });
    } else {
      callback({});
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

async function start() {
  paths = appPaths();
  mkdirSync(paths.dataDir, { recursive: true });
  logFile = join(paths.dataDir, 'morphy-desktop.log');
  log(`Morphy desktop ${app.getVersion()} starting; data in ${paths.dataDir}`);

  ipcMain.handle('open-database', () => openDatabase());
  ipcMain.handle('new-database', () => newDatabase());
  installIsolationHeaders();
  buildMenu();

  mainWindow = createWindow();
  await mainWindow.loadURL(splashHtml('Starting the database service…'));

  try {
    service = await startService(paths, log);
  } catch (err) {
    const message = err instanceof ServiceError ? err.message : `Starting the service failed: ${String(err)}`;
    log(message);
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Morphy could not start',
      message,
      detail: `The log is at ${logFile}`,
    });
    app.quit();
    return;
  }
  if (!mainWindow) return;
  await mainWindow.loadURL(service.origin + '/');

  // --screenshot=<file>: capture the window once the app shows and quit (for checks)
  const shot = process.argv.find((a) => a.startsWith('--screenshot='));
  if (shot) {
    const file = shot.slice('--screenshot='.length);
    setTimeout(async () => {
      const image = await mainWindow!.webContents.capturePage();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, image.toPNG());
      log(`screenshot saved to ${file}`);
      app.quit();
    }, 4000);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && service) {
      mainWindow = createWindow();
      void mainWindow.loadURL(service.origin + '/');
    }
  });
  let stopping: Promise<void> | null = null;
  app.on('will-quit', (event) => {
    if (!service || stopping) return;
    event.preventDefault();
    log('stopping morphy-service');
    stopping = service.stop().then(() => {
      service = null;
      app.quit();
    });
  });
}
