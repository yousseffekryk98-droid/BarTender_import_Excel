'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { TemplateStore } = require('./store.cjs');
const { PrintService } = require('./print-service.cjs');
const { AutomationService } = require('./automation/index.cjs');
const v = require('./ipc-validate.cjs');

const APP_NAME = 'Excel Label Studio';
const DEV_URL = !app.isPackaged ? process.env.ELECTRON_START_URL : '';
const DIST_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const MAX_DATA_FILE = 50 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.excellabelstudio.app');
if (process.env.ELS_DATA_DIR) app.setPath('userData', path.resolve(process.env.ELS_DATA_DIR));

const singleInstance = process.env.ELS_ALLOW_MULTIPLE === '1' || app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow = null;
let allowClose = false;
let store; let printer; let automation;
const pendingRenders = new Map();

function dataRoot() { return app.getPath('userData'); }

// ---------- security ----------

function isAppUrl(url) {
  if (!url) return false;
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith(pathToFileURL(path.join(__dirname, '..', 'dist')).href);
}

function verify(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Request rejected: unknown sender.');
  const url = event.senderFrame?.url || '';
  if (!isAppUrl(url)) throw new Error('Request rejected: untrusted frame.');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    verify(event);
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message || String(error), code: error.code || error.name || 'error', details: error.details }; }
  });
}

function hardenSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['clipboard-sanitized-write', 'local-fonts']);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(allowed.has(permission) && isAppUrl(wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission) && Boolean(wc && isAppUrl(wc.getURL())));
  ses.on('will-download', (event) => event.preventDefault());
  if (!DEV_URL) {
    // Block all network requests in production: the app is fully offline.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const ok = details.url.startsWith('file:') || details.url.startsWith('data:') || details.url.startsWith('devtools:') || details.url.startsWith('blob:');
      callback({ cancel: !ok });
    });
  }
}

app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(github\.com|www\.bartendersoftware\.com)\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) e.preventDefault(); });
});

// ---------- window ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1100, minHeight: 680,
    title: APP_NAME, backgroundColor: '#f3f4f6', show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: false, devTools: !app.isPackaged || process.env.ELS_DEVTOOLS === '1'
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => { mainWindow?.show(); if (process.env.ELS_MAXIMIZE !== '0') mainWindow?.maximize(); });
  let closeRequestedAt = 0;
  mainWindow.on('close', (event) => {
    if (allowClose || !mainWindow) return;
    // If the renderer did not answer an earlier close request within 5 s, close anyway.
    if (closeRequestedAt && Date.now() - closeRequestedAt > 5000) return;
    event.preventDefault();
    closeRequestedAt = Date.now();
    mainWindow.webContents.send('app:close-requested');
  });
  ipcMain.removeAllListeners('app:cancel-close');
  ipcMain.on('app:cancel-close', (event) => { try { verify(event); closeRequestedAt = 0; } catch { /* ignore */ } });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('Renderer crashed:', details.reason);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });
  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(DIST_INDEX);
}

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

// ---------- secrets ----------

async function settingsSnapshot() { return store ? store.getSettings() : {}; }
let cachedSettings = {};

function loadToken() {
  const s = cachedSettings.automationToken;
  if (!s) return '';
  try {
    if (s.startsWith('enc:') && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('plain:')) return s.slice(6);
  } catch { return ''; }
  return '';
}
function saveToken(token) {
  const value = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(token).toString('base64') : 'plain:' + token;
  cachedSettings = { ...cachedSettings, automationToken: value };
  void store.updateSettings({ automationToken: value });
}

// ---------- renderer render bridge (automation) ----------

function renderInApp(request) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(Object.assign(new Error('The Excel Label Studio window is not open.'), { retryable: true }));
    const id = request.requestId || randomUUID();
    const timer = setTimeout(() => { pendingRenders.delete(id); reject(Object.assign(new Error('Rendering timed out.'), { retryable: true })); }, 180_000);
    pendingRenders.set(id, { resolve, reject, timer });
    mainWindow.webContents.send('automation:render', { ...request, requestId: id });
  });
}

ipcMain.on('automation:render-result', (event, requestId, result) => {
  try { verify(event); } catch { return; }
  const pending = pendingRenders.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRenders.delete(requestId);
  pending.resolve(result);
});

// ---------- data files (renderer never supplies paths) ----------

async function rememberDataFile(filePath) {
  const settings = await store.getSettings();
  const existing = (settings.dataFiles || []).find((f) => f.path === filePath);
  const token = existing?.token || randomUUID();
  const entry = { token, path: filePath, name: path.basename(filePath), lastOpened: new Date().toISOString() };
  const dataFiles = [entry, ...(settings.dataFiles || []).filter((f) => f.path !== filePath)].slice(0, 20);
  await store.updateSettings({ dataFiles });
  return token;
}

async function readDataFile(filePath) {
  const info = await fs.stat(filePath);
  if (!info.isFile()) throw new Error('Not a file.');
  if (info.size > MAX_DATA_FILE) throw new Error('The file is larger than 50 MB.');
  const bytes = await fs.readFile(filePath);
  return { name: path.basename(filePath), size: info.size, modifiedAt: info.mtime.toISOString(), bytes: new Uint8Array(bytes) };
}

function sniffImage(buffer) {
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function registerIpc() {
  handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged, dataDir: dataRoot(), simulatedPrinter: Boolean(process.env.ELS_SIMULATED_PRINTER_DIR), crashed: store.previousSessionCrashed }));
  ipcMain.on('app:confirm-close', (event) => { try { verify(event); } catch { return; } allowClose = true; mainWindow?.close(); });

  // templates
  handle('store:list', () => store.list());
  handle('store:get', (id) => store.get(v.str(id, 'id', { pattern: v.TEMPLATE_ID })));
  handle('store:save', (template, options) => store.save(v.obj(template, 'template', { maxBytes: 16 * 1024 * 1024 }), {
    baseRevision: options?.baseRevision === undefined || options?.baseRevision === null ? undefined : v.num(options.baseRevision, 'revision', { min: 0, integer: true }),
    force: Boolean(options?.force), createOnly: Boolean(options?.createOnly)
  }));
  handle('store:duplicate', (id, name) => store.duplicate(v.str(id, 'id', { pattern: v.TEMPLATE_ID }), v.optStr(name, 'name', { max: 120 })));
  handle('store:rename', (id, name, rev) => store.rename(v.str(id, 'id', { pattern: v.TEMPLATE_ID }), v.str(name, 'name', { min: 1, max: 120 }), rev === undefined ? undefined : v.num(rev, 'revision', { min: 0, integer: true })));
  handle('store:remove', (id) => store.remove(v.str(id, 'id', { pattern: v.TEMPLATE_ID })));
  handle('store:trash', () => store.listTrash());
  handle('store:restore', (entry) => store.restore(v.str(entry, 'entry', { max: 200 })));
  handle('store:purge', (entry) => store.purge(v.str(entry, 'entry', { max: 200 })));
  handle('store:history', (id) => store.history(v.str(id, 'id', { pattern: v.TEMPLATE_ID })));
  handle('store:version', (id, version) => store.getVersion(v.str(id, 'id', { pattern: v.TEMPLATE_ID }), v.str(version, 'version', { max: 120 })));
  handle('store:favorite', (id, fav) => store.setFavorite(v.str(id, 'id', { pattern: v.TEMPLATE_ID }), Boolean(fav)));
  handle('store:import-legacy', (list) => {
    if (!Array.isArray(list) || list.length > 200) throw new Error('Invalid legacy template list.');
    return store.importData(list, { keepIds: true });
  });
  handle('store:import-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import label templates', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Label templates', extensions: ['elslabel', 'json'] }] });
    if (result.canceled) return { canceled: true };
    const all = { imported: [], failed: [] };
    for (const file of result.filePaths.slice(0, 50)) {
      try {
        const info = await fs.stat(file);
        if (info.size > 16 * 1024 * 1024) throw new Error('File is larger than 16 MB.');
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        const r = await store.importData(parsed);
        all.imported.push(...r.imported); all.failed.push(...r.failed.map((f) => ({ ...f, file: path.basename(file) })));
      } catch (error) { all.failed.push({ file: path.basename(file), error: error.message }); }
    }
    return all;
  });
  handle('store:export-dialog', async (ids, suggested) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Error('Choose templates to export.');
    ids.forEach((id) => v.str(id, 'id', { pattern: v.TEMPLATE_ID }));
    const single = ids.length === 1;
    const data = single ? await store.get(ids[0]) : await store.exportBundle(ids);
    const name = String(suggested || (single ? data.name : 'label-templates')).replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').slice(0, 80) || 'label-template';
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export label template', defaultPath: name + '.elslabel', filters: [{ name: 'Label template', extensions: ['elslabel'] }, { name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8');
    return { path: result.filePath };
  });

  // settings & autosave
  handle('settings:get', async () => { const s = await store.getSettings(); const { automationToken, dataFiles, ...rest } = s; return { ...rest, recentDataFiles: (dataFiles || []).map(({ token, name, lastOpened, path: p }) => ({ token, name, lastOpened, folder: path.dirname(p) })) }; });
  handle('settings:update', async (patch) => { const next = await store.updateSettings(v.settingsPatch(patch)); cachedSettings = next; return true; });
  handle('autosave:write', (payload) => store.writeAutosave(v.obj(payload, 'autosave', { maxBytes: 32 * 1024 * 1024 })));
  handle('autosave:read', () => store.readRecovery());
  handle('autosave:clear', () => store.clearAutosave());

  // data sources
  handle('data:open-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Open Excel or CSV data', properties: ['openFile'], filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = await readDataFile(result.filePaths[0]);
    return { ...file, token: await rememberDataFile(result.filePaths[0]), folder: path.dirname(result.filePaths[0]) };
  });
  handle('data:reload', async (token) => {
    v.str(token, 'token', { pattern: v.UUID });
    const settings = await store.getSettings();
    const entry = (settings.dataFiles || []).find((f) => f.token === token);
    if (!entry) throw new Error('This data file is no longer in the recent list. Open it again.');
    try { const file = await readDataFile(entry.path); await rememberDataFile(entry.path); return { ...file, token, folder: path.dirname(entry.path) }; }
    catch (error) { if (error.code === 'ENOENT') throw new Error('The file "' + entry.name + '" was moved or deleted. Open it again.'); throw error; }
  });
  handle('data:forget', async (token) => {
    const settings = await store.getSettings();
    await store.updateSettings({ dataFiles: (settings.dataFiles || []).filter((f) => f.token !== token) });
    return true;
  });
  handle('image:open-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose an image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const info = await fs.stat(result.filePaths[0]);
    if (info.size > MAX_IMAGE) throw new Error('Images must be smaller than 2 MB. Resize the image and try again.');
    const buffer = await fs.readFile(result.filePaths[0]);
    const mime = sniffImage(buffer);
    if (!mime) throw new Error('This file is not a supported image (PNG, JPEG, GIF, BMP or WebP).');
    return { name: path.basename(result.filePaths[0]), dataUri: 'data:' + mime + ';base64,' + buffer.toString('base64') };
  });

  // printing
  handle('print:printers', (refresh) => printer.listPrinters({ refreshStatus: Boolean(refresh) }));
  handle('print:job', (request) => printer.print(v.printRequest(request)));
  handle('print:cancelled', (jobId) => printer.markCancelled(v.str(jobId, 'job id', { pattern: v.UUID })));
  handle('print:pdf-dialog', async (request) => {
    const html = v.str(request?.html, 'document', { min: 20, max: 40 * 1024 * 1024 });
    const pageSize = v.page(request?.page);
    const name = String(request?.suggestedName || 'labels').replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-').slice(0, 80);
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Save labels as PDF', defaultPath: name + '.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const buffer = await printer.pdf(html, pageSize);
    await fs.writeFile(result.filePath, buffer);
    return { path: result.filePath, bytes: buffer.length };
  });
  handle('print:pdf-buffer', async (request) => {
    const buffer = await printer.pdf(v.str(request?.html, 'document', { min: 20, max: 40 * 1024 * 1024 }), v.page(request?.page));
    return new Uint8Array(buffer);
  });
  handle('print:history', () => printer.history());
  handle('print:reprint', (jobId, options) => printer.reprint(v.str(jobId, 'job id', { pattern: v.UUID }), { printerName: options?.printerName === undefined ? undefined : v.optStr(options.printerName, 'printer', { max: 300 }), showDialog: Boolean(options?.showDialog) }));
  handle('print:clear-history', () => printer.clearHistory());
  handle('shell:show-file', async (filePath) => {
    // only files this app just wrote (PDF exports) or the data folder
    const p = v.str(filePath, 'path', { max: 1000 });
    if (!path.isAbsolute(p) || !/\.(pdf|elslabel|json)$/i.test(p)) throw new Error('Not allowed.');
    shell.showItemInFolder(p);
    return true;
  });
  handle('shell:open-data-folder', async () => { await shell.openPath(dataRoot()); return true; });

  // automation
  handle('automation:get', () => automation.getConfig());
  handle('automation:set', (config) => automation.setConfig(v.obj(config, 'automation settings', { maxBytes: 200_000 })));
  handle('automation:token', (regenerate) => (regenerate || !loadToken() ? automation.regenerateToken() : loadToken()));
  handle('automation:jobs', () => automation.queue.list().map((j) => automation.publicJob(j)));
  handle('automation:logs', () => automation.readLogs(400));
  handle('automation:approve', (id) => automation.queue.approve(v.str(id, 'id', { pattern: v.UUID })));
  handle('automation:reject', (id) => automation.queue.reject(v.str(id, 'id', { pattern: v.UUID })));
  handle('automation:cancel', (id) => automation.queue.cancel(v.str(id, 'id', { pattern: v.UUID })));
  handle('automation:choose-folder', async (title) => {
    const result = await dialog.showOpenDialog(mainWindow, { title: String(title || 'Choose folder').slice(0, 80), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? '' : result.filePaths[0];
  });
}

// ---------- lifecycle ----------

app.whenReady().then(async () => {
  hardenSession();
  store = await new TemplateStore(dataRoot()).init();
  cachedSettings = await settingsSnapshot();
  printer = await new PrintService({
    createWindow: (options) => new BrowserWindow(options),
    getPrinters: async () => (mainWindow ? mainWindow.webContents.getPrintersAsync() : []),
    historyDir: path.join(dataRoot(), 'print-history'),
    simulatedDir: process.env.ELS_SIMULATED_PRINTER_DIR ? path.resolve(process.env.ELS_SIMULATED_PRINTER_DIR) : '',
    settings: () => cachedSettings
  }).init();
  automation = new AutomationService({
    root: dataRoot(), store, print: printer, render: renderInApp, version: app.getVersion(),
    loadToken, saveToken,
    onEvent: (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('automation:event', event); }
  });
  registerIpc();
  createWindow();
  await automation.init().catch((error) => console.error('Automation failed to start:', error));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { allowClose = true; });
app.on('will-quit', async () => {
  await automation?.shutdown().catch(() => {});
  store?.closeSession();
});
app.on('window-all-closed', () => { app.quit(); });
