'use strict';
// Narrow, explicit bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (response && response.ok) return response.value;
  const error = new Error(response?.error || 'Request failed.');
  error.code = response?.code;
  error.details = response?.details;
  throw error;
}

function subscribe(channel, callback) {
  const listener = (event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('labelDesktop', {
  info: () => call('app:info'),
  onCloseRequested: (cb) => subscribe('app:close-requested', cb),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  cancelClose: () => ipcRenderer.send('app:cancel-close'),

  templates: {
    list: () => call('store:list'),
    get: (id) => call('store:get', id),
    save: (template, options) => call('store:save', template, options),
    duplicate: (id, name) => call('store:duplicate', id, name),
    rename: (id, name, revision) => call('store:rename', id, name, revision),
    remove: (id) => call('store:remove', id),
    trash: () => call('store:trash'),
    restore: (entry) => call('store:restore', entry),
    purge: (entry) => call('store:purge', entry),
    history: (id) => call('store:history', id),
    version: (id, version) => call('store:version', id, version),
    favorite: (id, favorite) => call('store:favorite', id, favorite),
    importLegacy: (list) => call('store:import-legacy', list),
    importDialog: () => call('store:import-dialog'),
    exportDialog: (ids, name) => call('store:export-dialog', ids, name)
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch)
  },
  autosave: {
    write: (payload) => call('autosave:write', payload),
    read: () => call('autosave:read'),
    clear: () => call('autosave:clear')
  },
  data: {
    openDialog: () => call('data:open-dialog'),
    reload: (token) => call('data:reload', token),
    forget: (token) => call('data:forget', token)
  },
  images: { openDialog: () => call('image:open-dialog') },
  print: {
    printers: (refresh) => call('print:printers', refresh),
    job: (request) => call('print:job', request),
    cancelled: (jobId) => call('print:cancelled', jobId),
    pdfDialog: (request) => call('print:pdf-dialog', request),
    pdfBuffer: (request) => call('print:pdf-buffer', request),
    history: () => call('print:history'),
    reprint: (jobId, options) => call('print:reprint', jobId, options),
    clearHistory: () => call('print:clear-history')
  },
  shell: {
    showFile: (p) => call('shell:show-file', p),
    openDataFolder: () => call('shell:open-data-folder')
  },
  automation: {
    get: () => call('automation:get'),
    set: (config) => call('automation:set', config),
    token: (regenerate) => call('automation:token', regenerate),
    jobs: () => call('automation:jobs'),
    logs: () => call('automation:logs'),
    approve: (id) => call('automation:approve', id),
    reject: (id) => call('automation:reject', id),
    cancel: (id) => call('automation:cancel', id),
    chooseFolder: (title) => call('automation:choose-folder', title),
    onEvent: (cb) => subscribe('automation:event', cb),
    onRenderRequest: (handler) => subscribe('automation:render', async (request) => {
      let result;
      try { result = await handler(request); }
      catch (error) { result = { ok: false, error: error?.message || String(error) }; }
      ipcRenderer.send('automation:render-result', request.requestId, result);
    })
  }
});
