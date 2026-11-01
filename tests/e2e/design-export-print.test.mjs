// Desktop integration: persisted local design, exported Excel starter, and editable print selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { launch, closeApp, tempDir, writeWorkbook, connectData, saveAs, stubDialogs, pdfText } from './helpers.mjs';

test('save a design locally, export matching Excel workbook, and unselect a print row', { timeout: 180_000 }, async () => {
  const work = await tempDir('els-design-export-');
  const s = await launch({ dataDir: path.join(work,'data'), printDir: path.join(work,'printed') });
  try {
    const src = path.join(work,'data-source.xlsx');
    await writeWorkbook(src, [['Products', [['Product Name','Price'],['Mouse','125'],['Keyboard','150']]]]);
    await connectData(s.app,s.page,src);
    await saveAs(s.page,'Local Shop Label');
    const saved = await s.page.evaluate(async () => {
      const all = await window.labelDesktop.templates.list();
      return all.find(t => t.name === 'Local Shop Label');
    });
    assert.ok(saved?.id);
    assert.match(await s.page.textContent('[data-testid="statusbar"]'),/Saved locally/);
    const exportPath = path.join(work,'Local Shop Label-data.xlsx');
    await stubDialogs(s.app,{ save: exportPath });
    await s.page.click('[data-testid="tb-export-excel"]');
    await s.page.waitForFunction(() => document.querySelector('.notices')?.textContent?.includes('Excel starter exported'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(exportPath);
    assert.deepEqual(wb.getWorksheet('Data').getRow(1).values.slice(1), ['Product Name','Price']);
    assert.ok(wb.getWorksheet('Instructions'));
    await s.page.click('[data-testid="tb-print"]');
    await s.page.waitForSelector('[data-testid="print-dialog"]');
    assert.equal(await s.page.locator('[data-testid="print-row-2"]').isChecked(),true);
    assert.equal(await s.page.locator('[data-testid="print-row-3"]').isChecked(),true);
    await s.page.locator('[data-testid="print-row-3"]').uncheck();
    await s.page.waitForFunction(() => document.querySelector('[data-testid="label-total"]')?.textContent === '1');
    await s.page.selectOption('[data-testid="printer-select"]',{label:'Excel Label Studio – Simulated Printer'});
    await s.page.waitForSelector('[data-testid="print-now"]:not([disabled])');
    await s.page.click('[data-testid="print-now"]');
    await s.page.waitForSelector('[data-testid="print-result"]');
    const files = (await fs.readdir(s.printed)).filter(f => f.endsWith('.pdf'));
    assert.equal(files.length,1);
    const pdf = await pdfText(path.join(s.printed,files[0]));
    assert.equal(pdf.length,1);
    assert.match(pdf[0].items.map(x=>x.text).join(' '),/Mouse/);
    assert.doesNotMatch(pdf[0].items.map(x=>x.text).join(' '),/Keyboard/);
    assert.deepEqual(s.errors,[]);
  } finally { await closeApp(s.app); }
});
