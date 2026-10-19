import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PrintService, explainFailure, SIMULATED_PRINTER } = require('../../electron/print-service.cjs');
const { interpretWindows, interpretOptions } = require('../../electron/printer-status.cjs');
const v = require('../../electron/ipc-validate.cjs');

const DOC = '<!doctype html><html><body><section class="els-page">label</section></body></html>';

/** Fake BrowserWindow capturing what would be sent to the Windows print API. */
function fakeWindows(outcome) {
  const calls = [];
  return {
    calls,
    createWindow: (options) => {
      const win = {
        options, destroyed: false, loaded: null,
        loadFile: async (file) => { win.loaded = await fs.readFile(file, 'utf8'); },
        isDestroyed: () => win.destroyed,
        destroy: () => { win.destroyed = true; },
        webContents: {
          setWindowOpenHandler: () => {}, on: () => {},
          print: (opts, cb) => { calls.push({ opts, html: win.loaded, windowOptions: options }); setImmediate(() => cb(outcome.ok, outcome.reason)); },
          printToPDF: async (opts) => { calls.push({ pdf: opts, html: win.loaded }); return Buffer.from('%PDF-1.4 fake'); }
        }
      };
      return win;
    }
  };
}

async function service(outcome = { ok: true }, printers = [{ name: 'Xprinter XP-470B', displayName: 'Xprinter XP-470B', isDefault: true, options: {} }], extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'els-print-'));
  const fake = fakeWindows(outcome);
  const svc = await new PrintService({ createWindow: fake.createWindow, getPrinters: async () => printers, historyDir: path.join(dir, 'history'), postCheckDelayMs: 0, settings: () => ({}), ...extra }).init();
  return { svc, fake, dir };
}

test('silent print to a named printer uses exact label size, no margins, 100% scale, isolated window', async () => {
  const { svc, fake } = await service();
  const r = await svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Xprinter XP-470B', labelCount: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.spooled, true);
  const { opts, html, windowOptions } = fake.calls[0];
  assert.equal(opts.silent, true);
  assert.equal(opts.deviceName, 'Xprinter XP-470B');
  assert.deepEqual(opts.pageSize, { width: 50000, height: 30000 });
  assert.deepEqual(opts.margins, { marginType: 'none' });
  assert.equal(opts.scaleFactor, 100);
  assert.equal(opts.copies, 1);
  assert.equal(html, DOC);
  assert.equal(windowOptions.webPreferences.javascript, false);
  assert.equal(windowOptions.webPreferences.sandbox, true);
  assert.equal(windowOptions.show, false);
});

test('driver failures, cancellations and unknown printers produce meaningful errors', async () => {
  const cancelled = await (await service({ ok: false, reason: 'cancelled' })).svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Xprinter XP-470B' });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'cancelled');
  const failed = await (await service({ ok: false, reason: 'Print job failed' })).svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Xprinter XP-470B' });
  assert.equal(failed.code, 'driver-error');
  const { svc } = await service();
  await assert.rejects(() => svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Missing printer' }), (e) => e.code === 'printer-unavailable');
  await assert.rejects(() => svc.print({ html: DOC, page: { width: 2, height: 30 }, printerName: '' }), (e) => e.code === 'invalid-size');
  await assert.rejects(() => svc.print({ html: '<script>', page: { width: 50, height: 30 } }), (e) => e.code === 'invalid-document');
  assert.equal(explainFailure('Invalid deviceName provided').code, 'printer-unavailable');
  assert.equal(explainFailure('Paper size not supported').code, 'paper');
});

test('a printer reporting offline/out-of-paper blocks printing unless overridden', async () => {
  const printers = [{ name: 'Lab', displayName: 'Lab', isDefault: false, options: { 'printer-state': '5', 'printer-state-reasons': 'media-empty-error' } }];
  const { svc, fake } = await service({ ok: true }, printers);
  if (process.platform === 'win32') return; // Windows status comes from WMI, not CUPS options
  const list = await svc.listPrinters();
  assert.deepEqual(list[0].problems, ['Stopped', 'Out of paper / labels']);
  await assert.rejects(() => svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Lab' }), (e) => e.code === 'printer-problem');
  const r = await svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Lab', ignoreStatus: true });
  assert.equal(r.ok, true);
  assert.match(r.warning, /Out of paper/);
  assert.equal(fake.calls.length, 1);
});

test('Windows WMI printer status mapping', () => {
  assert.deepEqual(interpretWindows({ PrinterStatus: 3, DetectedErrorState: 2, WorkOffline: false }), { state: 'idle', problems: [], blocking: false });
  assert.deepEqual(interpretWindows({ PrinterStatus: 7, DetectedErrorState: 9, WorkOffline: false }).problems, ['Offline']);
  assert.equal(interpretWindows({ PrinterStatus: 3, DetectedErrorState: 4 }).blocking, true);
  assert.equal(interpretWindows({ PrinterStatus: 3, DetectedErrorState: 3 }).blocking, false, 'low paper is a warning');
  assert.equal(interpretWindows({ PrinterStatus: 3, WorkOffline: true }).blocking, true);
  assert.deepEqual(interpretOptions({ 'printer-state': '3' }), { state: 'idle', problems: [], blocking: false });
});

test('job history records chunks; reprint replays the stored documents', async () => {
  const { svc, fake } = await service();
  const jobId = '0b1c2d3e-4f50-4a1b-8c2d-3e4f5a6b7c8d';
  for (let i = 0; i < 3; i++) await svc.print({ html: DOC.replace('label', 'part ' + i), page: { width: 50, height: 30 }, printerName: 'Xprinter XP-470B', jobId, chunkIndex: i, chunkCount: 3, labelCount: 250, meta: { templateName: 'Price', templateRevision: 4, source: 'manual', rows: ['2', '3'] } });
  const [job] = await svc.history();
  assert.equal(job.id, jobId);
  assert.equal(job.status, 'spooled');
  assert.equal(job.labels, 750);
  assert.equal(job.templateRevision, 4);
  assert.equal(job.reprintable, true);
  const before = fake.calls.length;
  const reprint = await svc.reprint(jobId);
  assert.equal(reprint.results.length, 3);
  assert.ok(reprint.results.every((r) => r.ok));
  assert.deepEqual(fake.calls.slice(before).map((c) => c.html), [0, 1, 2].map((i) => DOC.replace('label', 'part ' + i)));
  const history = await svc.history();
  assert.equal(history[0].source, 'reprint');
  assert.equal(history[0].reprintOf, jobId);
  await svc.clearHistory();
  assert.deepEqual(await svc.history(), []);
  await assert.rejects(() => svc.reprint('../../etc'), /Invalid job id/);
});

test('history can be disabled for privacy', async () => {
  const { svc } = await service({ ok: true }, undefined, { settings: () => ({ keepPrintHistory: false }) });
  await svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: 'Xprinter XP-470B' });
  assert.deepEqual(await svc.history(), []);
});

test('PDF export and the simulated test printer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'els-sim-'));
  const { svc, fake } = await service({ ok: true }, [], { simulatedDir: dir });
  const pdf = await svc.pdf(DOC, { width: 100, height: 150 });
  assert.match(pdf.toString(), /^%PDF/);
  assert.deepEqual(fake.calls[0].pdf.pageSize, { width: 100 / 25.4, height: 150 / 25.4 });
  assert.equal(fake.calls[0].pdf.preferCSSPageSize, true);
  const printers = await svc.listPrinters();
  assert.equal(printers[0].name, SIMULATED_PRINTER);
  const r = await svc.print({ html: DOC, page: { width: 50, height: 30 }, printerName: SIMULATED_PRINTER, labelCount: 1 });
  assert.ok((await fs.readdir(dir)).some((f) => f.endsWith('.pdf')));
  assert.equal(r.ok, true);
});

test('IPC validation rejects malformed or oversized requests', () => {
  assert.throws(() => v.printRequest(null), /must be an object/);
  assert.throws(() => v.printRequest({ html: 'x', page: { width: 50, height: 30 } }), /invalid length/);
  assert.throws(() => v.printRequest({ html: DOC, page: { width: 'a', height: 30 } }), /out of range/);
  assert.throws(() => v.printRequest({ html: DOC, page: { width: 50, height: 30 }, jobId: '../x' }), /invalid format/);
  const ok = v.printRequest({ html: DOC, page: { width: 50, height: 30 }, printerName: 'P', extra: 'ignored' });
  assert.equal(ok.extra, undefined);
  assert.throws(() => v.settingsPatch({ keepPrintHistory: 'yes' }), /wrong type/);
  assert.deepEqual(v.settingsPatch({ keepPrintHistory: false, evil: 1 }), { keepPrintHistory: false });
  assert.throws(() => v.str('../../x', 'id', { pattern: v.TEMPLATE_ID }), /invalid format/);
});
