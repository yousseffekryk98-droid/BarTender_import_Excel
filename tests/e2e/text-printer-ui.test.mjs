import test from 'node:test';
import assert from 'node:assert/strict';
import { launch, closeApp } from './helpers.mjs';

test('printer connection action remains visible and text is editable from the properties panel', { timeout: 90000 }, async () => {
  const s = await launch();
  try {
    await s.page.setViewportSize({ width: 1024, height: 800 });
    assert.equal(await s.page.locator('[data-testid="tb-connect-printer"]').isVisible(), true);
    assert.equal(await s.page.locator('[data-testid="tb-print"]').isVisible(), true);
    await s.page.click('[data-testid="tb-connect-printer"]');
    await s.page.waitForSelector('[data-testid="printer-setup"]');
    await s.page.selectOption('[data-testid="printer-setup-select"]', { label: 'Excel Label Studio – Simulated Printer' });
    await s.page.click('[data-testid="printer-setup-connect"]');
    assert.match(await s.page.textContent('[data-testid="printer-setup-status"]'), /selected and saved/i);
    await s.page.click('[data-testid="printer-setup"] .modal-close');

    await s.page.click('[data-testid="tool-text"]');
    await s.page.click('[data-testid="edit-object-text"]');
    await s.page.fill('[data-testid="edit-text-input"]', 'Editable label text');
    await s.page.click('[data-testid="save-text-edit"]');
    await s.page.waitForSelector('[data-testid="text-editor"]', { state: 'detached' });
    assert.match(await s.page.inputValue('[data-testid="static-text"]'), /Editable label text/);

    await s.page.locator('[data-hit]').first().dblclick();
    await s.page.waitForSelector('[data-testid="text-editor"]');
    await s.page.selectOption('[data-testid="text-source"]', 'field');
    await s.page.fill('[data-testid="edit-text-field"]', 'Product Name');
    await s.page.click('[data-testid="save-text-edit"]');

    await s.page.click('[data-testid="edit-object-text"]');
    await s.page.selectOption('[data-testid="text-source"]', 'static');
    await s.page.fill('[data-testid="edit-text-input"]', 'Manual override');
    await s.page.click('[data-testid="save-text-edit"]');
    assert.equal(await s.page.inputValue('[data-testid="static-text"]'), 'Manual override');
    assert.deepEqual(s.errors, []);
  } finally {
    await closeApp(s.app);
  }
});


test('edit text on paper, link a column with surrounding words, and save a reusable stamp', { timeout: 90000 }, async () => {
  const s = await launch();
  try {
    await s.page.click('[data-testid="tool-text"]');
    await s.page.dblclick('[data-testid="object-Text"]');
    await s.page.waitForSelector('[data-testid="canvas-inline-editor"]');
    await s.page.fill('[data-testid="canvas-inline-input"]', 'Shop label');
    await s.page.click('[data-testid="canvas-inline-save"]');
    assert.equal(await s.page.inputValue('[data-testid="static-text"]'), 'Shop label');

    await s.page.click('[data-testid="tb-add-excel"]');
    await s.page.waitForSelector('[data-testid="text-editor"]');
    await s.page.fill('[data-testid="edit-text-field"]', 'Price');
    await s.page.fill('[data-testid="text-prefix"]', 'Price: ');
    await s.page.fill('[data-testid="text-suffix"]', ' EGP');
    await s.page.click('[data-testid="save-text-edit"]');

    await s.page.click('[data-testid="tb-save-stamp"]');
    await s.page.waitForSelector('[data-testid="confirm-dialog"]');
    await s.page.fill('[data-testid="dialog-input"]', 'Reusable shop stamp');
    await s.page.click('[data-testid="dialog-save-stamp"]');
    await s.page.waitForSelector('[data-testid="confirm-dialog"]', { state: 'detached' });
    await s.page.click('[data-testid="tb-open-stamp"]');
    await s.page.waitForSelector('[data-testid="template-manager"]');
    assert.match(await s.page.textContent('[data-testid="template-manager"]'), /Reusable shop stamp/);
    const saved = await s.page.evaluate(async () => {
      const all = await window.labelDesktop.templates.list();
      const item = all.find((t) => t.name === 'Reusable shop stamp');
      return item && window.labelDesktop.templates.get(item.id);
    });
    assert.equal(saved.category, 'Stamps');
    assert.ok(saved.objects.some((o) => o.content?.mode === 'static' && o.content.text === 'Shop label'));
    assert.ok(saved.objects.some((o) => o.content?.mode === 'field' && o.content.field === 'Price' && o.prefix === 'Price: ' && o.suffix === ' EGP'));
    assert.deepEqual(s.errors, []);
  } finally {
    await closeApp(s.app);
  }
});
