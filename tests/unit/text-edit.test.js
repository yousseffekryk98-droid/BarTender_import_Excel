import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTextEditPatch, suggestedFixedText } from '../../src/ui/text-edit.js';

test('editing fixed text preserves other attributes and the original text mode', () => {
  const original = { content: { mode: 'static', text: 'Old' }, prefix: 'SKU:', suffix: '!', format: { kind: 'none' } };
  assert.deepEqual(buildTextEditPatch(original, { mode: 'static', text: 'New' }, false), { content: { mode: 'static', text: 'New' } });
});
test('converting a linked Excel value to fixed text prevents doubled suffix/prefix and formatting', () => {
  const original = { content: { mode: 'field', field: 'Price', text: 'Text' }, prefix: '$', suffix: ' EGP', format: { kind: 'currency' } };
  const patch = buildTextEditPatch(original, { mode: 'static', text: suggestedFixedText(original, '$100 EGP') }, true);
  assert.equal(patch.content.text, '$100 EGP');
  assert.equal(patch.content.mode, 'static');
  assert.equal(patch.prefix, '');
  assert.equal(patch.suffix, '');
  assert.deepEqual(patch.format, { kind: 'none' });
});
test('editing Excel field mapping keeps dynamic binding and printer-independent formatting', () => {
  const original = { content: { mode: 'field', field: 'Price' }, prefix: 'Price:' };
  assert.deepEqual(buildTextEditPatch(original, { mode: 'field', field: 'Amount' }, false), { content: { mode: 'field', field: 'Amount' } });
});
