// Shared helpers for Electron end-to-end tests (run under Xvfb on Linux CI, natively on Windows).
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Launch the built app with an isolated data folder and the simulated (PDF) printer. */
export async function launch({ dataDir, printDir } = {}) {
  const data = dataDir || await tempDir('els-e2e-data-');
  const printed = printDir || path.join(data, 'printed');
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT,
    env: { ...process.env, ELS_DATA_DIR: data, ELS_SIMULATED_PRINTER_DIR: printed, ELS_MAXIMIZE: '0', ELS_ALLOW_MULTIPLE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewportSize({ width: 1500, height: 940 }).catch(() => {});
  await page.waitForSelector('[data-testid="canvas-paper"]');
  return { app, page, data, printed, errors };
}

/** Make native open/save dialogs return the given paths (main process). */
export async function stubDialogs(app, { open = [], save = '' } = {}) {
  await app.evaluate(({ dialog }, { openPaths, savePath }) => {
    dialog.showOpenDialog = async () => ({ canceled: !openPaths.length, filePaths: openPaths });
    dialog.showSaveDialog = async () => ({ canceled: !savePath, filePath: savePath });
  }, { openPaths: open, savePath: save });
}

export async function writeWorkbook(file, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows, formats = {}] of sheets) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
    for (const [cell, fmt] of Object.entries(formats)) ws.getCell(cell).numFmt = fmt;
  }
  await wb.xlsx.writeFile(file);
  return file;
}

/** Connect a data file through the Database wizard. */
export async function connectData(app, page, file, { renames = {} } = {}) {
  await stubDialogs(app, { open: [file] });
  await page.click('[data-testid="tb-database"]');
  await page.click('[data-testid="wizard-browse"]');
  for (let i = 0; i < 3; i++) await page.click('[data-testid="wizard-next"]');
  for (const [field, to] of Object.entries(renames)) await page.selectOption('[data-testid="map-' + field + '"]', to);
  await page.click('[data-testid="wizard-finish"]');
  await page.waitForSelector('[data-testid="row-count"]');
}

export async function saveAs(page, name) {
  await page.keyboard.press('Control+s');
  await page.fill('[data-testid="dialog-input"]', name);
  await page.click('[data-testid="dialog-save"]');
  await page.waitForFunction((n) => document.querySelector('[data-testid="doc-title"]')?.textContent === n, name);
}

/** Print through the Print dialog to the simulated printer; returns the PDF files written. */
export async function printSimulated(page, printDir, { beforePrint } = {}) {
  await page.click('[data-testid="tb-print"]');
  await page.waitForSelector('[data-testid="print-dialog"]');
  await page.selectOption('[data-testid="printer-select"]', { label: 'Excel Label Studio – Simulated Printer' });
  if (beforePrint) await beforePrint();
  await page.waitForSelector('[data-testid="print-now"]:not([disabled])', { timeout: 20000 });
  const before = new Set(await fs.readdir(printDir).catch(() => []));
  await page.click('[data-testid="print-now"]');
  await page.waitForSelector('[data-testid="print-result"]', { timeout: 60000 });
  const result = await page.textContent('[data-testid="print-result"]');
  const after = (await fs.readdir(printDir).catch(() => [])).filter((f) => !before.has(f) && f.endsWith('.pdf')).sort();
  await page.click('[data-testid="print-dialog"] .modal-close').catch(() => {});
  return { result, files: after.map((f) => path.join(printDir, f)) };
}

let pdfjs;
/** Text items of every page with positions in millimetres from the top-left corner. */
export async function pdfText(file) {
  pdfjs = pdfjs || await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const view = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    const mm = (pt) => (pt * 25.4) / 72;
    pages.push({
      widthMm: mm(view.width), heightMm: mm(view.height),
      items: content.items.filter((i) => i.str.trim()).map((i) => ({ text: i.str, x: mm(i.transform[4]), baseline: mm(view.height - i.transform[5]), fontPt: Math.hypot(i.transform[0], i.transform[1]), width: mm(i.width) }))
    });
  }
  await doc.destroy();
  return pages;
}

export async function closeApp(app) {
  try { await app.evaluate(({ app: a }) => { a.exit(0); }); } catch { /* already closed */ }
}
