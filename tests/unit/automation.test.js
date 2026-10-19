import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createTemplate, createObject } from '../../src/engine/schema.js';

const require = createRequire(import.meta.url);
const { JobQueue } = require('../../electron/automation/queue.cjs');
const { FolderWatcher, patternToRegex, validateRuleFolders } = require('../../electron/automation/watcher.cjs');
const { createApiServer, tokenMatches } = require('../../electron/automation/api-server.cjs');
const { AutomationService, recordsFromBody, nextScheduled, sanitizeConfig } = require('../../electron/automation/index.cjs');
const { TemplateStore } = require('../../electron/store.cjs');

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); }
};

test('queue: retries with delay, then fails; progress is persisted', async () => {
  let now = 1000;
  let attempts = 0;
  const dir = await tmp('els-q-');
  const finals = [];
  const q = await new JobQueue({ dir, now: () => now, execute: async () => { attempts++; throw Object.assign(new Error('printer offline'), { retryable: true }); }, onFinal: (j) => finals.push(j.status) }).load();
  const job = await q.add({ source: 'api', kind: 'api', payload: {}, maxAttempts: 2, retryDelayMs: 5000 });
  q.stopped = false;
  await q.kick();
  assert.equal(q.get(job.id).status, 'retrying');
  assert.equal(q.get(job.id).runAt, 6000);
  await q.kick();
  assert.equal(attempts, 1, 'not retried before runAt');
  now = 6000;
  await q.kick();
  assert.equal(attempts, 2);
  assert.equal(q.get(job.id).status, 'failed');
  assert.deepEqual(finals, ['failed']);
  const reloaded = await new JobQueue({ dir, execute: async () => {} }).load();
  assert.equal(reloaded.get(job.id).status, 'failed');
});

test('queue: approval gate, scheduling, cancel, crash recovery', async () => {
  let now = 0;
  const done = [];
  const dir = await tmp('els-q2-');
  const q = await new JobQueue({ dir, now: () => now, execute: async (j) => { done.push(j.id); return { summary: 'ok' }; } }).load();
  q.stopped = false;
  const gated = await q.add({ source: 'folder', kind: 'file', payload: {}, requireApproval: true });
  const later = await q.add({ source: 'api', kind: 'api', payload: {}, runAt: 10_000 });
  const cancelMe = await q.add({ source: 'api', kind: 'api', payload: {}, runAt: 20_000 });
  await q.kick();
  assert.deepEqual(done, []);
  assert.equal(q.get(gated.id).status, 'awaiting-approval');
  assert.equal(q.get(later.id).status, 'scheduled');
  await q.approve(gated.id);
  await q.kick();
  assert.deepEqual(done, [gated.id]);
  now = 10_000;
  await q.kick();
  assert.deepEqual(done, [gated.id, later.id]);
  await q.cancel(cancelMe.id);
  assert.equal(q.get(cancelMe.id).status, 'cancelled');
  // simulate a crash mid-job
  const stuck = await q.add({ source: 'api', kind: 'api', payload: {} });
  q.get(stuck.id).status = 'processing';
  await q.persist();
  const recovered = await new JobQueue({ dir, execute: async () => {} }).load();
  assert.equal(recovered.get(stuck.id).status, 'retrying');
});

test('watch folder: waits for stable files, claims atomically, ignores temp files and symlinks', async () => {
  const root = await tmp('els-w-');
  const rule = { id: 'r1', name: 'Rule', enabled: true, incoming: path.join(root, 'in'), completed: path.join(root, 'done'), error: path.join(root, 'err'), pattern: '*.csv;*.xlsx' };
  await fs.mkdir(rule.incoming, { recursive: true });
  const picked = [];
  const w = new FolderWatcher({ rules: () => [rule], onFile: async (f) => picked.push(f), stableMs: 0 });
  await fs.writeFile(path.join(rule.incoming, 'labels.csv'), 'a,b\n1,2\n');
  await fs.writeFile(path.join(rule.incoming, '~$labels.xlsx'), 'lock');
  await fs.writeFile(path.join(rule.incoming, 'notes.txt'), 'x');
  await fs.symlink(path.join(rule.incoming, 'labels.csv'), path.join(rule.incoming, 'link.csv')).catch(() => {});
  await w.scan();
  assert.equal(picked.length, 0, 'first sighting only records size/mtime');
  await w.scan();
  assert.equal(picked.length, 1);
  assert.equal(picked[0].originalName, 'labels.csv');
  assert.match(picked[0].claimedPath, /\.els-processing/);
  await fs.access(picked[0].claimedPath);
  assert.ok(patternToRegex('*.xlsx;*.csv').test('A.CSV'));
  assert.throws(() => validateRuleFolders({ ...rule, completed: rule.incoming }), /different folders/);
  assert.throws(() => validateRuleFolders({ ...rule, error: path.join(rule.incoming, 'err') }), /inside the Incoming/);
  assert.throws(() => validateRuleFolders({ ...rule, incoming: 'relative' }), /absolute/);
});

function request(port, { method = 'GET', url = '/api/v1/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: '127.0.0.1:' + port, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('REST API: localhost only, bearer token, no browsers, no DNS rebinding, JSON only, body limit', async () => {
  const created = [];
  const port = 40000 + Math.floor(Math.random() * 20000);
  const api = createApiServer({ port, getToken: () => 'secret-token', handlers: {
    health: async () => ({ ok: true }), templates: async () => [], printers: async () => [], listJobs: async () => [],
    getJob: async (id) => (id === 'x' ? { id } : null), cancelJob: async () => null,
    createJob: async (body) => { created.push(body); return { id: 'job-1', status: 'queued' }; }
  } });
  const address = await api.listen();
  assert.equal(address.address, '127.0.0.1');
  try {
    const auth = { authorization: 'Bearer secret-token' };
    assert.equal((await request(port)).status, 401);
    assert.equal((await request(port, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await request(port, { headers: auth })).status, 200);
    assert.equal((await request(port, { headers: { ...auth, host: 'evil.example:' + port } })).status, 421);
    assert.equal((await request(port, { headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(port, { method: 'POST', url: '/api/v1/jobs', headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await request(port, { method: 'POST', url: '/api/v1/jobs', headers: { ...auth, 'content-type': 'application/json' }, body: '{bad' })).status, 400);
    const ok = await request(port, { method: 'POST', url: '/api/v1/jobs', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 't' }) });
    assert.equal(ok.status, 202);
    assert.deepEqual(created, [{ templateId: 't' }]);
    assert.equal((await request(port, { url: '/api/v1/jobs/x', headers: auth })).status, 200);
    assert.equal((await request(port, { url: '/api/v1/jobs/y', headers: auth })).status, 404);
    assert.equal((await request(port, { method: 'DELETE', url: '/api/v1/jobs/y', headers: auth })).status, 409);
    assert.equal((await request(port, { url: '/other', headers: auth })).status, 404);
    const big = await request(port, { method: 'POST', url: '/api/v1/jobs', headers: { ...auth, 'content-type': 'application/json' }, body: 'x'.repeat(6 * 1024 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
  } finally { await api.close(); }
  assert.equal(tokenMatches('abc', 'Bearer abc'), true);
  assert.equal(tokenMatches('', 'Bearer '), false);
});

test('API helpers: records, schedule, config sanitizing', () => {
  assert.deepEqual(recordsFromBody({ records: [{ A: 1, B: null }, { B: 'x', C: true }] }), { headers: ['A', 'B', 'C'], rows: [['1', '', ''], ['', 'x', 'true']] });
  assert.throws(() => recordsFromBody({ records: [[1, 2]] }), /object/);
  assert.throws(() => recordsFromBody({}), /Provide/);
  const at = nextScheduled('17:30', new Date(2026, 9, 19, 18, 0));
  assert.equal(new Date(at).getDate(), 20);
  const c = sanitizeConfig({ enabled: 'yes', api: { port: 80 }, folders: [{ maxLabels: -5, action: 'rm -rf' }] });
  assert.equal(c.enabled, true);
  assert.equal(c.api.port, 1024);
  assert.equal(c.folders[0].action, 'print');
  assert.equal(c.folders[0].maxLabels, 1);
  assert.equal(c.folders[0].requireApproval, true, 'approval is on unless explicitly disabled');
  assert.equal(sanitizeConfig(undefined).enabled, false, 'automation is disabled by default');
});

test('end to end: dropped file → validated → printed → moved to Completed; bad file → Error with log', async () => {
  const root = await tmp('els-auto-');
  const store = await new TemplateStore(path.join(root, 'data')).init();
  const template = await store.save(createTemplate({ name: 'Auto', objects: [createObject('text', { content: { mode: 'field', field: 'Item' } })] }));
  const printed = [];
  const renders = [];
  const render = async (req) => {
    renders.push(req);
    const text = new TextDecoder().decode(req.file.bytes);
    if (!text.startsWith('Item')) return { ok: false, error: 'Column "Item" was not found in the data.' };
    const total = text.trim().split('\n').length - 1;
    return { ok: true, total, warnings: [], chunks: [{ html: '<!doctype html>x', labelCount: total }], paper: { width: 50, height: 30 } };
  };
  const print = { print: async (r) => { printed.push(r); return { ok: true, spooled: true, jobId: r.jobId }; }, pdf: async () => Buffer.from('%PDF'), listPrinters: async () => [] };
  const auto = await new AutomationService({ root: path.join(root, 'data'), store, print, render, loadToken: () => 't', saveToken: () => {}, intervalMs: 50, stableMs: 0 }).init();
  const rule = { id: 'r1', name: 'Drop', enabled: true, incoming: path.join(root, 'in'), completed: path.join(root, 'done'), error: path.join(root, 'err'), pattern: '*.csv', templateId: template.id, printerName: 'Xprinter', action: 'print', requireApproval: false, maxLabels: 100 };
  await fs.mkdir(rule.incoming, { recursive: true });
  await auto.setConfig({ enabled: true, folders: [rule], api: { enabled: false } });
  try {
    await fs.writeFile(path.join(rule.incoming, 'good.csv'), 'Item\nA\nB\n');
    await fs.writeFile(path.join(rule.incoming, 'bad.csv'), 'Wrong\nA\n');
    const doneFiles = await waitFor(async () => { const f = await fs.readdir(rule.completed).catch(() => []); return f.length ? f : null; });
    assert.ok(doneFiles.some((f) => f.endsWith('__good.csv')));
    const errFiles = await waitFor(async () => { const f = await fs.readdir(rule.error).catch(() => []); return f.length >= 2 ? f : null; });
    assert.ok(errFiles.some((f) => f.endsWith('__bad.csv')));
    const log = await fs.readFile(path.join(rule.error, errFiles.find((f) => f.endsWith('.log.txt'))), 'utf8');
    assert.match(log, /Column "Item" was not found/);
    assert.equal(printed.length, 1);
    assert.equal(printed[0].printerName, 'Xprinter');
    assert.equal(printed[0].meta.source, 'automation');
    assert.equal(renders.filter((r) => r.dryRun).length, 2, 'every file is validated before it is queued');
    const logs = await auto.readLogs();
    assert.ok(logs.some((l) => /completed/.test(l.message)));
  } finally { await auto.shutdown(); }
});

test('end to end: approval required — nothing prints until approved', async () => {
  const root = await tmp('els-auto2-');
  const store = await new TemplateStore(path.join(root, 'data')).init();
  const template = await store.save(createTemplate({ name: 'Auto', objects: [] }));
  const printed = [];
  const render = async () => ({ ok: true, total: 1, warnings: [], chunks: [{ html: '<!doctype html>x', labelCount: 1 }], paper: { width: 50, height: 30 } });
  const print = { print: async (r) => { printed.push(r); return { ok: true }; }, pdf: async () => Buffer.from(''), listPrinters: async () => [] };
  const auto = await new AutomationService({ root: path.join(root, 'data'), store, print, render, loadToken: () => 't', saveToken: () => {}, intervalMs: 50, stableMs: 0 }).init();
  const rule = { id: 'r2', name: 'Gate', enabled: true, incoming: path.join(root, 'in'), completed: path.join(root, 'done'), error: path.join(root, 'err'), pattern: '*.csv', templateId: template.id, printerName: 'P', action: 'print' };
  await fs.mkdir(rule.incoming, { recursive: true });
  await auto.setConfig({ enabled: true, folders: [rule] });
  try {
    await fs.writeFile(path.join(rule.incoming, 'x.csv'), 'A\n1\n');
    const job = await waitFor(() => auto.queue.list().find((j) => j.status === 'awaiting-approval'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(printed.length, 0);
    await auto.queue.approve(job.id);
    await waitFor(() => printed.length === 1);
    await waitFor(async () => (await fs.readdir(rule.completed).catch(() => [])).length === 1);
  } finally { await auto.shutdown(); }
});

test('API job end to end with a dry run first', async () => {
  const root = await tmp('els-auto3-');
  const store = await new TemplateStore(path.join(root, 'data')).init();
  const template = await store.save(createTemplate({ name: 'Api', objects: [] }));
  const printed = [];
  const render = async (req) => ({ ok: true, total: req.rows.length, warnings: [], chunks: [{ html: '<!doctype html>x', labelCount: req.rows.length }], paper: { width: 50, height: 30 } });
  const print = { print: async (r) => { printed.push(r); return { ok: true }; }, pdf: async () => Buffer.from(''), listPrinters: async () => [] };
  const auto = await new AutomationService({ root: path.join(root, 'data'), store, print, render, loadToken: () => 't', saveToken: () => {} }).init();
  await auto.setConfig({ enabled: true });
  try {
    const dry = await auto.createApiJob({ templateId: template.id, records: [{ Item: 'A' }, { Item: 'B' }], dryRun: true, printerName: 'P' });
    assert.deepEqual(dry, { dryRun: true, total: 2, warnings: [] });
    assert.equal(printed.length, 0);
    const job = await auto.createApiJob({ templateId: template.id, records: [{ Item: 'A' }], printerName: 'P' });
    await waitFor(() => auto.queue.get(job.id)?.status === 'done');
    assert.equal(printed.length, 1);
    await assert.rejects(() => auto.createApiJob({ templateId: 'tpl-missing', records: [] }), /not found/);
    await assert.rejects(() => auto.createApiJob({ templateId: template.id, records: [], runAt: 'tomorrow' }), /runAt/);
  } finally { await auto.shutdown(); }
});
