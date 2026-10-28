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
