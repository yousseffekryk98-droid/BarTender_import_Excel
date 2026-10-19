'use strict';
// Automation service: folder rules + local API feeding one persistent queue.
// Rendering is delegated to the app window (same renderer as manual printing), so automated
// labels are pixel-identical to what the designer previews. Everything is off by default.

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JobQueue } = require('./queue.cjs');
const { FolderWatcher, finishFile, validateRuleFolders } = require('./watcher.cjs');
const { createApiServer, newToken } = require('./api-server.cjs');

const DEFAULT_CONFIG = Object.freeze({ enabled: false, folders: [], api: { enabled: false, port: 47321 }, retry: { maxAttempts: 3, delaySeconds: 30 } });

function sanitizeRule(rule, index) {
  const r = rule && typeof rule === 'object' ? rule : {};
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    id: /^[\w-]{1,60}$/.test(r.id) ? r.id : 'rule-' + randomUUID().slice(0, 8),
    name: s(r.name, 80) || 'Folder rule ' + (index + 1),
    enabled: Boolean(r.enabled),
    incoming: s(r.incoming, 400), completed: s(r.completed, 400), error: s(r.error, 400),
    pattern: s(r.pattern, 200) || '*.xlsx;*.xls;*.csv',
    templateId: s(r.templateId, 120), printerName: s(r.printerName, 300), sheetName: s(r.sheetName, 120),
    quantityField: s(r.quantityField, 200),
    action: ['print', 'pdf', 'validate'].includes(r.action) ? r.action : 'print',
    pdfFolder: s(r.pdfFolder, 400),
    maxLabels: Math.max(1, Math.min(100_000, Math.round(Number(r.maxLabels) || 1000))),
    requireApproval: r.requireApproval !== false,
    scheduleAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.scheduleAt || '') ? r.scheduleAt : ''
  };
}

function sanitizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const api = c.api && typeof c.api === 'object' ? c.api : {};
  const retry = c.retry && typeof c.retry === 'object' ? c.retry : {};
  return {
    enabled: Boolean(c.enabled),
    folders: Array.isArray(c.folders) ? c.folders.slice(0, 20).map(sanitizeRule) : [],
    api: { enabled: Boolean(api.enabled), port: Math.max(1024, Math.min(65535, Math.round(Number(api.port) || 47321))) },
    retry: { maxAttempts: Math.max(1, Math.min(10, Math.round(Number(retry.maxAttempts) || 3))), delaySeconds: Math.max(5, Math.min(3600, Math.round(Number(retry.delaySeconds) || 30))) }
  };
}

/** Next local time for "HH:MM" (today if still ahead, otherwise tomorrow). */
function nextScheduled(hhmm, now = new Date()) {
  const [h, m] = hhmm.split(':').map(Number);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** Convert API JSON records ([{col: value}]) or CSV text into headers/rows for the renderer. */
function recordsFromBody(body) {
  if (Array.isArray(body.records)) {
    if (body.records.length > 100_000) throw new Error('At most 100,000 records per request.');
    const headers = [];
    for (const record of body.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Each record must be an object of column → value.');
      for (const key of Object.keys(record)) if (!headers.includes(key)) headers.push(key);
      if (headers.length > 256) throw new Error('At most 256 columns.');
    }
    return { headers, rows: body.records.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? '' : String(r[h])))) };
  }
  if (typeof body.csv === 'string') return { csv: body.csv };
  throw new Error('Provide "records" (array of objects) or "csv" (text).');
}

class AutomationService {
  /**
   * deps: { root, store (TemplateStore), print (PrintService), render(request) → Promise<result>,
   *         loadToken(), saveToken(token), onEvent(event) }
   */
  constructor(deps) {
    this.deps = deps;
    this.root = path.join(deps.root, 'automation');
    this.logDir = path.join(this.root, 'logs');
    this.config = sanitizeConfig(DEFAULT_CONFIG);
    this.api = null;
    this.apiStatus = { running: false, error: '' };
    this.queue = new JobQueue({
      dir: this.root,
      execute: (job) => this.execute(job),
      log: (entry) => this.log(entry),
      onChange: (job) => deps.onEvent?.({ type: 'job', job: this.publicJob(job) }),
      onFinal: (job) => this.finalize(job)
    });
    this.watcher = new FolderWatcher({
      rules: () => (this.config.enabled ? this.config.folders : []),
      onFile: (file) => this.enqueueFile(file),
      log: (entry) => this.log(entry),
      intervalMs: deps.intervalMs, stableMs: deps.stableMs
    });
  }

  async init() {
    await fs.mkdir(this.logDir, { recursive: true });
    const settings = await this.deps.store.getSettings();
    this.config = sanitizeConfig(settings.automation || DEFAULT_CONFIG);
    await this.queue.load();
    await this.apply();
    return this;
  }

  getConfig() { return { ...this.config, apiStatus: this.apiStatus, tokenSet: Boolean(this.deps.loadToken()) }; }

  async setConfig(next) {
    const config = sanitizeConfig(next);
    for (const rule of config.folders.filter((r) => r.enabled)) validateRuleFolders(rule);
    this.config = config;
    await this.deps.store.updateSettings({ automation: config });
    await this.apply();
    this.log({ level: 'info', message: 'Automation settings changed (enabled: ' + config.enabled + ', folder rules: ' + config.folders.filter((r) => r.enabled).length + ', API: ' + config.api.enabled + ').' });
    return this.getConfig();
  }

  async apply() {
    this.watcher.stop();
    this.queue.stop();
    if (this.api) { await this.api.close().catch(() => {}); this.api = null; this.apiStatus = { running: false, error: '' }; }
    if (!this.config.enabled) return;
    this.queue.start();
    if (this.config.folders.some((r) => r.enabled)) this.watcher.start();
    if (this.config.api.enabled) {
      if (!this.deps.loadToken()) this.deps.saveToken(newToken());
      this.api = createApiServer({ port: this.config.api.port, getToken: () => this.deps.loadToken(), handlers: this.apiHandlers(), log: (e) => this.log(e) });
      try { await this.api.listen(); this.apiStatus = { running: true, error: '', url: 'http://127.0.0.1:' + this.config.api.port + '/api/v1' }; }
      catch (error) { this.apiStatus = { running: false, error: error.code === 'EADDRINUSE' ? 'Port ' + this.config.api.port + ' is already in use.' : error.message }; this.api = null; }
    }
  }

  regenerateToken() { const token = newToken(); this.deps.saveToken(token); return token; }

  async shutdown() {
    this.watcher.stop();
    this.queue.stop();
    if (this.api) await this.api.close().catch(() => {});
  }

  async log(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), level: entry.level || 'info', rule: entry.rule || '', jobId: entry.jobId || '', message: String(entry.message || '').slice(0, 2000) });
    const file = path.join(this.logDir, new Date().toISOString().slice(0, 10) + '.log');
    await fs.appendFile(file, line + '\n').catch(() => {});
    this.deps.onEvent?.({ type: 'log', entry: JSON.parse(line) });
  }

  async readLogs(limit = 300) {
    const names = (await fs.readdir(this.logDir).catch(() => [])).filter((n) => n.endsWith('.log')).sort().reverse().slice(0, 7);
    const lines = [];
    for (const name of names) {
      const text = await fs.readFile(path.join(this.logDir, name), 'utf8').catch(() => '');
      lines.push(...text.trim().split('\n').filter(Boolean).reverse());
      if (lines.length >= limit) break;
    }
    return lines.slice(0, limit).map((l) => { try { return JSON.parse(l); } catch { return { message: l }; } });
  }

  publicJob(job) {
    if (!job) return null;
    const { payload, ...rest } = job;
    return { ...rest, payload: { templateId: payload?.templateId || payload?.rule?.templateId, file: payload?.originalName, action: payload?.action || payload?.rule?.action, printerName: payload?.printerName || payload?.rule?.printerName, labels: payload?.preview?.total } };
  }

  // ---------- intake ----------

  async enqueueFile(file) {
    const rule = file.rule;
    const payload = { kind: 'file', ruleId: rule.id, rule, claimedPath: file.claimedPath, originalName: file.originalName, templateId: rule.templateId, action: rule.action, printerName: rule.printerName };
    let preview = null;
    try { preview = await this.renderFor(payload, { dryRun: true }); }
    catch (error) {
      await finishFile(file, false, 'Rejected before printing: ' + error.message);
      this.log({ level: 'error', rule: rule.name, message: file.originalName + ' rejected: ' + error.message });
      return;
    }
    payload.preview = { total: preview.total, warnings: preview.warnings || [] };
    await this.queue.add({
      source: 'folder', kind: 'file', payload,
      description: file.originalName + ' → ' + preview.total + ' label(s) with "' + (preview.templateName || rule.templateId) + '"',
      requireApproval: rule.requireApproval,
      runAt: rule.scheduleAt ? nextScheduled(rule.scheduleAt) : undefined,
      maxAttempts: this.config.retry.maxAttempts, retryDelayMs: this.config.retry.delaySeconds * 1000
    });
  }

  async createApiJob(body) {
    if (!body || typeof body !== 'object') throw new Error('Body must be a JSON object.');
    const templateId = String(body.templateId || '');
    await this.deps.store.get(templateId);
    const action = ['print', 'pdf', 'validate'].includes(body.action) ? body.action : 'print';
    const data = recordsFromBody(body);
    const runAt = body.runAt ? Date.parse(body.runAt) : undefined;
    if (body.runAt && !Number.isFinite(runAt)) throw new Error('runAt must be an ISO date-time.');
    const payload = {
      kind: 'api', templateId, action, printerName: String(body.printerName || ''), ...data,
      quantityField: String(body.quantityField || ''), copies: Math.max(1, Math.min(100_000, Math.round(Number(body.copies) || 1))),
      prompts: body.prompts && typeof body.prompts === 'object' ? Object.fromEntries(Object.entries(body.prompts).slice(0, 30).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 500)])) : {},
      maxLabels: Math.max(1, Math.min(100_000, Math.round(Number(body.maxLabels) || 5000)))
    };
    const preview = await this.renderFor(payload, { dryRun: true });
    payload.preview = { total: preview.total, warnings: preview.warnings || [] };
    if (body.dryRun) return { dryRun: true, ...payload.preview };
    const job = await this.queue.add({
      source: 'api', kind: 'api', payload, description: 'API: ' + preview.total + ' label(s) with "' + (preview.templateName || templateId) + '"',
      runAt, maxAttempts: Math.max(1, Math.min(10, Math.round(Number(body.maxAttempts) || this.config.retry.maxAttempts))),
      retryDelayMs: this.config.retry.delaySeconds * 1000, requireApproval: Boolean(body.requireApproval)
    });
    return this.publicJob(job);
  }

  apiHandlers() {
    return {
      health: async () => ({ ok: true, app: 'Excel Label Studio', version: this.deps.version || '', queue: this.queue.list().filter((j) => !['done', 'failed', 'cancelled', 'rejected'].includes(j.status)).length }),
      templates: async () => (await this.deps.store.list()).filter((t) => !t.damaged).map((t) => ({ id: t.id, name: t.name, category: t.category, width: t.width, height: t.height, revision: t.revision })),
      printers: async () => (await this.deps.print.listPrinters()).map((p) => ({ name: p.name, isDefault: p.isDefault, status: p.status, problems: p.problems })),
      createJob: (body) => this.createApiJob(body),
      getJob: async (id) => this.publicJob(this.queue.get(String(id))),
      listJobs: async () => this.queue.list().map((j) => this.publicJob(j)),
      cancelJob: async (id) => this.publicJob(await this.queue.cancel(String(id)))
    };
  }

  // ---------- execution ----------

  async renderFor(payload, { dryRun = false } = {}) {
    const template = await this.deps.store.get(payload.templateId);
    const request = { requestId: randomUUID(), dryRun, template, maxLabels: payload.rule?.maxLabels ?? payload.maxLabels ?? 1000 };
    if (payload.kind === 'file') {
      const bytes = await fs.readFile(payload.claimedPath);
      Object.assign(request, { file: { name: payload.originalName, bytes: new Uint8Array(bytes) }, sheetName: payload.rule.sheetName, quantityField: payload.rule.quantityField });
    } else {
      Object.assign(request, { headers: payload.headers, rows: payload.rows, csv: payload.csv, quantityField: payload.quantityField, copies: payload.copies, prompts: payload.prompts });
    }
    const result = await this.deps.render(request);
    if (!result || !result.ok) throw Object.assign(new Error(result?.error || 'The data could not be rendered.'), { retryable: false });
    return { ...result, templateName: template.name, templateRevision: template.revision };
  }

  async execute(job) {
    const payload = job.payload;
    const rendered = await this.renderFor(payload);
    const action = payload.action || 'print';
    if (action === 'validate') return { summary: 'Validated: ' + rendered.total + ' label(s), nothing printed.', labels: rendered.total };
    if (action === 'pdf') {
      const folder = payload.rule?.pdfFolder || payload.rule?.completed || path.join(this.root, 'pdf');
      if (!path.isAbsolute(folder)) throw Object.assign(new Error('PDF folder must be an absolute path.'), { retryable: false });
      await fs.mkdir(folder, { recursive: true });
      const files = [];
      for (let i = 0; i < rendered.chunks.length; i++) {
        const buffer = await this.deps.print.pdf(rendered.chunks[i].html, rendered.paper);
        const name = (payload.originalName || 'api-job').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') + '_' + job.id.slice(0, 8) + (rendered.chunks.length > 1 ? '_' + (i + 1) : '') + '.pdf';
        await fs.writeFile(path.join(folder, name), buffer);
        files.push(path.join(folder, name));
      }
      return { summary: 'Saved ' + rendered.total + ' label(s) as PDF: ' + files.map((f) => path.basename(f)).join(', '), files, labels: rendered.total };
    }
    if (!payload.printerName && !payload.rule?.printerName) throw Object.assign(new Error('No printer is configured for this automation.'), { retryable: false });
    const printJobId = randomUUID();
    let printed = 0;
    const startChunk = job.result?.printedChunks || 0;
    for (let i = startChunk; i < rendered.chunks.length; i++) {
      const chunk = rendered.chunks[i];
      const result = await this.deps.print.print({
        html: chunk.html, page: rendered.paper, printerName: payload.printerName || payload.rule?.printerName || '', jobId: printJobId,
        chunkIndex: i, chunkCount: rendered.chunks.length, labelCount: chunk.labelCount,
        meta: { templateId: payload.templateId, templateName: rendered.templateName, templateRevision: rendered.templateRevision, source: job.source === 'api' ? 'api' : 'automation', dataFile: payload.originalName || '', totalLabels: rendered.total }
      });
      if (!result.ok) {
        // remember progress so a retry does not print the same labels twice
        await this.queue.update(job.id, { result: { printedChunks: i } });
        throw Object.assign(new Error(result.message || 'Printing failed.'), { retryable: true });
      }
      printed += chunk.labelCount;
    }
    return { summary: 'Sent ' + printed + ' label(s) to "' + (payload.printerName || payload.rule?.printerName) + '" (spooled by Windows; check the printed labels).', labels: printed, printJobId };
  }

  async finalize(job) {
    if (job.kind !== 'file') return;
    const ok = job.status === 'done';
    const log = job.log.map((l) => l.at + ' [' + l.level + '] ' + l.message).join('\n');
    try {
      const target = await finishFile({ rule: job.payload.rule, claimedPath: job.payload.claimedPath, originalName: job.payload.originalName }, ok, ok ? '' : log);
      this.log({ level: ok ? 'info' : 'error', rule: job.payload.rule.name, jobId: job.id, message: job.payload.originalName + (ok ? ' completed → ' : ' failed → ') + target });
    } catch (error) {
      this.log({ level: 'error', rule: job.payload.rule.name, jobId: job.id, message: 'Could not move ' + job.payload.originalName + ': ' + error.message });
    }
  }
}

module.exports = { AutomationService, sanitizeConfig, sanitizeRule, recordsFromBody, nextScheduled, DEFAULT_CONFIG };
