// End-to-end: Import Excel → design → save → close → reopen → reimport (reordered) → print → verify PDF layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { launch, tempDir, writeWorkbook, connectData, saveAs, printSimulated, pdfText, closeApp, stubDialogs } from './helpers.mjs';

const near = (actual, expected, tol, label) => assert.ok(Math.abs(actual - expected) <= tol, label + ': expected ≈' + expected + ' ±' + tol + ', got ' + actual.toFixed(3));

/** Build the requirements' example template through the UI: three text objects at exact mm positions. */
async function designSpecLabel(page) {
  await page.click('[data-testid="tb-new"]');
  await page.fill('[data-testid="new-name"]', 'Store Price Label');
  await page.click('[data-testid="new-width"]'); await page.fill('[data-testid="new-width"]', '50'); await page.keyboard.press('Tab');
  await page.fill('[data-testid="new-height"]', '30'); await page.keyboard.press('Tab');
  await page.click('[data-testid="create-blank"]');
  // the current (unsaved) document has data-connection changes → "Unsaved changes" prompt
  const discard = await page.waitForSelector('[data-testid="dialog-don-t-save"]', { timeout: 3000 }).catch(() => null);
  if (discard) await discard.click();
  const objects = [
    { field: 'Product Name', x: 2, y: 3, h: 9, size: 14, bold: true },
    { field: 'Price', x: 2, y: 14, h: 9, size: 18, suffix: ' EGP' },
    { field: 'Serial', x: 2, y: 24, h: 5, size: 10, prefix: 'SN: ' }
  ];
  for (const o of objects) {
    await page.dblclick('[data-testid="field-' + o.field + '"]');
    const set = async (id, value) => { await page.fill('[data-testid="' + id + '"]', String(value)); await page.keyboard.press('Enter'); };
    await set('prop-x', o.x); await set('prop-y', o.y); await set('prop-width', 46); await set('prop-height', o.h);
    await set('font-size', o.size);
    if (o.bold) await page.click('[data-testid="bold"]');
    if (o.suffix) { await page.fill('[data-testid="suffix"]', o.suffix); await page.keyboard.press('Enter'); }
    if (o.prefix) { await page.fill('[data-testid="prefix"]', o.prefix); await page.keyboard.press('Enter'); }
    await page.keyboard.press('Escape');
    await page.click('[data-testid="canvas"]', { position: { x: 5, y: 5 } });
  }
}

test('full workflow with exact print layout', { timeout: 240_000 }, async () => {
  const work = await tempDir('els-e2e-work-');
  const first = await writeWorkbook(path.join(work, 'products.xlsx'), [['Products', [
    ['Product Name', 'Price', 'Serial', 'Location'], ['Mouse', 325, '00123', 'Cairo'], ['Keyboard', 500, '00124', 'Giza']
  ]]]);
  const reordered = await writeWorkbook(path.join(work, 'products-reordered.xlsx'), [['Sheet A', [
    ['Location', 'SERIAL', 'product name', 'Price', 'Notes'], ['Aswan', '00999', 'Monitor', 4100, 'x'], ['Luxor', '01000', 'Webcam', 950, 'y']
  ]]]);

  console.log("STEP session 1: import, design, save");
  let s = await launch();
  const dataDir = s.data;
  await connectData(s.app, s.page, first);
  assert.match(await s.page.textContent('[data-testid="row-count"]'), /2 of 2 selected/);
  await designSpecLabel(s.page);
  await saveAs(s.page, 'Store Price Label');
  assert.deepEqual(s.errors, []);
  await closeApp(s.app);

  console.log("STEP session 2: reopen the template, import a workbook with reordered columns, print");
  s = await launch({ dataDir });
  await s.page.click('[data-testid="tb-open"]');
  await s.page.dblclick('[data-testid="manager-Store Price Label"]');
  await s.page.waitForFunction(() => document.querySelector('[data-testid="doc-title"]')?.textContent === 'Store Price Label');
  await connectData(s.app, s.page, reordered);
  assert.equal(await s.page.$('[data-testid="missing-banner"]'), null, 'all columns found by name');
  const { result, files } = await printSimulated(s.page, s.printed);
  assert.match(result, /Simulated printer wrote 2 label/);
  assert.equal(files.length, 1);
  const pages = await pdfText(files[0]);
  assert.equal(pages.length, 2, 'one PDF page per label');
  for (const p of pages) { near(p.widthMm, 50, 0.1, 'page width'); near(p.heightMm, 30, 0.1, 'page height'); }
  const text = (p) => p.items.map((i) => i.text).join('|');
  assert.equal(text(pages[0]), 'Monitor|4100 EGP|SN: 00999');
  assert.equal(text(pages[1]), 'Webcam|950 EGP|SN: 01000');
  // layout fidelity: left edges at X = 2 mm, baselines inside each object's box, font sizes as configured
  const [name, price, serial] = pages[0].items;
  for (const item of pages[0].items) near(item.x, 2, 0.35, item.text + ' left edge');
  assert.ok(name.baseline > 3 && name.baseline < 12, 'product baseline inside 3–12 mm');
  assert.ok(price.baseline > 14 && price.baseline < 23, 'price baseline inside 14–23 mm');
  assert.ok(serial.baseline > 24 && serial.baseline < 29, 'serial baseline inside 24–29 mm');
  near(name.fontPt, 14, 0.2, 'product font'); near(price.fontPt, 18, 0.2, 'price font'); near(serial.fontPt, 10, 0.2, 'serial font');
  assert.deepEqual(s.errors, []);

  console.log('STEP export the template and import it on another computer (fresh data folder)');
  const exported = path.join(work, 'Store Price Label.elslabel');
  await stubDialogs(s.app, { save: exported });
  await s.page.click('[data-testid="menu-file"]');
  await s.page.click('[data-testid="menuitem-export-this-template-"]');
  await s.page.waitForTimeout(500);
  const exportedJson = JSON.parse(await fs.readFile(exported, 'utf8'));
  assert.equal(exportedJson.name, 'Store Price Label');
  await closeApp(s.app);

  s = await launch();
  await stubDialogs(s.app, { open: [exported] });
  await s.page.click('[data-testid="menu-file"]');
  await s.page.click('[data-testid="menuitem-import-templates-"]');
  await s.page.waitForSelector('[data-testid="template-Store Price Label"]', { state: 'attached', timeout: 10000 }).catch(() => {});
  await s.page.click('[data-testid="tb-open"]');
  await s.page.dblclick('[data-testid="manager-Store Price Label"]');
  await connectData(s.app, s.page, first);
  const second = await printSimulated(s.page, s.printed);
  const transferred = await pdfText(second.files[0]);
  assert.equal(transferred[0].items.map((i) => i.text).join('|'), 'Mouse|325 EGP|SN: 00123');
  near(transferred[0].items[0].x, 2, 0.35, 'same layout on the other computer');
  await closeApp(s.app);
});
