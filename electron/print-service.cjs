'use strict';
// Printing, PDF export, job history and reprint for label documents rendered by the app.
// Windows accepting a job only means it reached the spooler; the UI reports it that way.

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const { printerStatuses } = require('./printer-status.cjs');
const { atomicWrite } = require('./store.cjs');

const SIMULATED_PRINTER = 'Excel Label Studio – Simulated Printer';
const MAX_HTML = 40 * 1024 * 1024;
const MAX_JOBS = 300;
const MAX_JOB_AGE_DAYS = 30;
const MAX_HISTORY_BYTES = 500 * 1024 * 1024;

class PrintError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const FAILURE_HINTS = [
  [/cancel/i, 'cancelled', 'Printing was cancelled.'],
  [/invalid.*(device|printer)|printer.*not.*(found|available)/i, 'printer-unavailable', 'The printer is not available. Check that it is connected and installed in Windows.'],
  [/no.*pages?|empty/i, 'empty', 'Nothing was printed (the document had no pages).'],
  [/paper|media|size/i, 'paper', 'The printer driver rejected the label/paper size. Create a matching stock size in the printer driver (Printing Preferences → Page Setup).'],
  [/failed/i, 'driver-error', 'The printer driver reported an error.']
];

function explainFailure(reason) {
  const text = String(reason || '');
  for (const [re, code, message] of FAILURE_HINTS) if (re.test(text)) return { code, message: message + (text && !/cancel/i.test(text) ? ' (' + text + ')' : '') };
  return { code: 'failed', message: text || 'Printing failed.' };
}

function validatePage(page) {
  const width = Number(page?.width); const height = Number(page?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 5 || height < 5 || width > 1200 || height > 1200) {
    throw new PrintError('invalid-size', 'Invalid label size ' + width + ' × ' + height + ' mm.');
  }
  return { width, height };
}

class PrintService {
  /**
   * deps: { createWindow(options) → BrowserWindow-like, getPrinters() → Promise<PrinterInfo[]>,
   *         historyDir, simulatedDir (enables the simulated printer), settings() → { keepPrintHistory, keepReprintData } }
   */
  constructor(deps) {
    this.deps = deps;
    this.historyDir = deps.historyDir;
    this.indexFile = path.join(this.historyDir, 'jobs.json');
    this.queue = Promise.resolve();
    this.jobs = new Map();
  }

  async init() {
    await fs.mkdir(this.historyDir, { recursive: true });
    await this.prune().catch(() => {});
    return this;
  }

  serial(task) { const run = this.queue.then(task, task); this.queue = run.catch(() => {}); return run; }

  async listPrinters({ refreshStatus = false } = {}) {
    const printers = (await this.deps.getPrinters()) || [];
    const statuses = await printerStatuses(printers, { force: refreshStatus }).catch(() => new Map());
    const list = printers.map((p) => {
      const status = statuses.get(p.name) || { state: 'unknown', problems: [], blocking: false };
      return { name: p.name, displayName: p.displayName || p.name, description: p.description || '', isDefault: Boolean(p.isDefault), status: status.state, problems: status.problems, blocking: status.blocking };
    });
    if (this.deps.simulatedDir) list.push({ name: SIMULATED_PRINTER, displayName: SIMULATED_PRINTER, description: 'Writes PDFs to ' + this.deps.simulatedDir, isDefault: false, status: 'idle', problems: [], blocking: false, simulated: true });
    return list;
  }

  async withDocument(html, run) {
    if (typeof html !== 'string' || !html.startsWith('<!doctype html>')) throw new PrintError('invalid-document', 'Invalid print document.');
    if (html.length > MAX_HTML) throw new PrintError('too-large', 'The print job is too large. It will be sent in smaller parts automatically; if this persists, print fewer labels.');
    const file = path.join(os.tmpdir(), 'els-' + randomUUID() + '.html');
    let win;
    try {
      await fs.writeFile(file, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      win = this.deps.createWindow({
        show: false, width: 800, height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, spellcheck: false }
      });
      win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      win.webContents.on?.('will-navigate', (event) => event.preventDefault());
      await win.loadFile(file);
      return await run(win);
    } finally {
      if (win && !win.isDestroyed?.()) win.destroy();
      await fs.unlink(file).catch(() => {});
    }
  }

  async pdf(html, page) {
    const size = validatePage(page);
    return this.withDocument(html, (win) => win.webContents.printToPDF({
      pageSize: { width: size.width / 25.4, height: size.height / 25.4 },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      printBackground: true, preferCSSPageSize: true
    }));
  }

  /**
   * Print one document (one chunk of a job).
   * request: { html, page: {width,height} (paper size after print rotation), printerName, showDialog, jobId, chunkIndex, chunkCount, labelCount, meta }
   */
  async print(request) {
    const size = validatePage(request.page);
    const printerName = String(request.printerName || '');
    const printers = await this.listPrinters({ refreshStatus: true });
    const target = printerName ? printers.find((p) => p.name === printerName) : null;
    if (printerName && !target) throw new PrintError('printer-unavailable', 'Printer "' + printerName + '" is not installed or not available.');
    if (target?.blocking && !request.ignoreStatus) {
      throw new PrintError('printer-problem', 'Printer "' + target.displayName + '" reports: ' + target.problems.join(', ') + '. Fix it, or choose "Print anyway".');
    }
    const jobId = request.jobId || randomUUID();
    let result;
    if (target?.simulated) {
      const buffer = await this.pdf(request.html, size);
      await fs.mkdir(this.deps.simulatedDir, { recursive: true });
      const out = path.join(this.deps.simulatedDir, jobId + '_' + String(request.chunkIndex || 0).padStart(4, '0') + '.pdf');
      await fs.writeFile(out, buffer);
      result = { ok: true, spooled: true, simulatedFile: out };
    } else {
      result = await this.withDocument(request.html, (win) => new Promise((resolve) => {
        win.webContents.print({
          silent: Boolean(printerName) && !request.showDialog,
          deviceName: printerName || undefined,
          printBackground: true,
          margins: { marginType: 'none' },
          landscape: false,
          scaleFactor: 100,
          pageSize: { width: Math.round(size.width * 1000), height: Math.round(size.height * 1000) },
          copies: 1
        }, (success, failureReason) => {
          if (success) resolve({ ok: true, spooled: true });
          else resolve({ ok: false, ...explainFailure(failureReason) });
        });
      }));
    }
    if (result.ok && target && !target.simulated) {
      // Re-check status shortly after spooling to surface offline/out-of-labels conditions.
      await new Promise((r) => setTimeout(r, this.deps.postCheckDelayMs ?? 1500));
      const after = (await this.listPrinters({ refreshStatus: true }).catch(() => [])).find((p) => p.name === printerName);
      if (after?.problems?.length) result.warning = 'After sending, the printer reports: ' + after.problems.join(', ') + '.';
    }
    await this.record({ ...request, jobId, printerName: printerName || '(chosen in dialog)', result }).catch(() => {});
    return { ...result, jobId };
  }

  // ---------- history ----------

  async readIndex() {
    try { const list = JSON.parse(await fs.readFile(this.indexFile, 'utf8')); return Array.isArray(list) ? list : []; }
    catch { return []; }
  }

  record(entry) {
    const settings = this.deps.settings?.() || {};
    if (settings.keepPrintHistory === false) return Promise.resolve();
    return this.serial(async () => {
      const index = await this.readIndex();
      let job = index.find((j) => j.id === entry.jobId);
      if (!job) {
        job = {
          id: entry.jobId, createdAt: new Date().toISOString(), printerName: entry.printerName, page: entry.page,
          chunkCount: Number(entry.chunkCount) || 1, chunks: [], labels: 0, status: 'printing', errors: [], warnings: [],
          ...sanitizeMeta(entry.meta)
        };
        index.unshift(job);
      }
      const chunkIndex = Number(entry.chunkIndex) || 0;
      job.labels += Number(entry.labelCount) || 0;
      job.chunks.push({ index: chunkIndex, ok: Boolean(entry.result.ok), labels: Number(entry.labelCount) || 0, at: new Date().toISOString(), error: entry.result.ok ? '' : entry.result.message });
      if (!entry.result.ok) job.errors.push(entry.result.message);
      if (entry.result.warning) job.warnings.push(entry.result.warning);
      job.status = job.errors.length ? (job.chunks.some((c) => c.ok) ? 'partial' : 'failed') : (job.chunks.length >= job.chunkCount ? 'spooled' : 'printing');
      if (settings.keepReprintData !== false && entry.result.ok) {
        await fs.writeFile(path.join(this.historyDir, job.id + '_' + String(chunkIndex).padStart(4, '0') + '.html.gz'), zlib.gzipSync(entry.html));
        job.reprintable = true;
      }
      await atomicWrite(this.indexFile, JSON.stringify(index.slice(0, MAX_JOBS)));
    });
  }

  async markCancelled(jobId) {
    return this.serial(async () => {
      const index = await this.readIndex();
      const job = index.find((j) => j.id === jobId);
      if (job) { job.status = 'cancelled'; job.cancelledAt = new Date().toISOString(); await atomicWrite(this.indexFile, JSON.stringify(index)); }
      return Boolean(job);
    });
  }

  async history() { return this.readIndex(); }

  async reprint(jobId, { printerName, showDialog } = {}) {
    if (typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(jobId)) throw new PrintError('invalid-job', 'Invalid job id.');
    const index = await this.readIndex();
    const job = index.find((j) => j.id === jobId);
    if (!job) throw new PrintError('not-found', 'That job is no longer in the history.');
    const files = (await fs.readdir(this.historyDir)).filter((n) => n.startsWith(jobId + '_') && n.endsWith('.html.gz')).sort();
    if (!files.length) throw new PrintError('not-reprintable', 'This job was not stored for reprinting.');
    const newJobId = randomUUID();
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const html = zlib.gunzipSync(await fs.readFile(path.join(this.historyDir, files[i]))).toString('utf8');
      const chunk = job.chunks.find((c) => c.index === Number(files[i].slice(37, 41))) || {};
      results.push(await this.print({
        html, page: job.page, printerName: printerName ?? job.printerName.replace('(chosen in dialog)', ''), showDialog,
        jobId: newJobId, chunkIndex: i, chunkCount: files.length, labelCount: chunk.labels || 0,
        meta: { templateId: job.templateId, templateName: job.templateName, templateRevision: job.templateRevision, source: 'reprint', reprintOf: jobId, dataFile: job.dataFile }
      }));
      if (!results[results.length - 1].ok) break;
    }
    return { jobId: newJobId, results };
  }

  async clearHistory() {
    return this.serial(async () => {
      for (const name of await fs.readdir(this.historyDir)) if (name.endsWith('.html.gz')) await fs.unlink(path.join(this.historyDir, name)).catch(() => {});
      await atomicWrite(this.indexFile, '[]');
      return true;
    });
  }

  async prune() {
    const index = await this.readIndex();
    const cutoff = Date.now() - MAX_JOB_AGE_DAYS * 86400000;
    const keep = index.filter((j) => Date.parse(j.createdAt) >= cutoff).slice(0, MAX_JOBS);
    const keepIds = new Set(keep.map((j) => j.id));
    const files = (await fs.readdir(this.historyDir)).filter((n) => n.endsWith('.html.gz'));
    let total = 0;
    const sized = [];
    for (const name of files) {
      const id = name.slice(0, 36);
      if (!keepIds.has(id)) { await fs.unlink(path.join(this.historyDir, name)).catch(() => {}); continue; }
      const { size, mtimeMs } = await fs.stat(path.join(this.historyDir, name));
      total += size; sized.push({ name, size, mtimeMs });
    }
    sized.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (total > MAX_HISTORY_BYTES && sized.length) { const f = sized.shift(); total -= f.size; await fs.unlink(path.join(this.historyDir, f.name)).catch(() => {}); }
    if (keep.length !== index.length) await atomicWrite(this.indexFile, JSON.stringify(keep));
  }
}

function sanitizeMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    templateId: s(m.templateId, 120), templateName: s(m.templateName, 120), templateRevision: Number(m.templateRevision) || 0,
    source: ['manual', 'automation', 'api', 'reprint', 'test'].includes(m.source) ? m.source : 'manual',
    dataFile: s(m.dataFile, 260), sheetName: s(m.sheetName, 120), totalLabels: Number(m.totalLabels) || 0,
    rows: Array.isArray(m.rows) ? m.rows.slice(0, 2000).map((r) => s(r, 20)) : [], reprintOf: s(m.reprintOf, 40)
  };
}

module.exports = { PrintService, PrintError, SIMULATED_PRINTER, explainFailure };
