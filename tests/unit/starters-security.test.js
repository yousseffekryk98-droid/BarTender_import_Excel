import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STARTER_LIST, templateFromStarter, STARTER_SAMPLE } from '../../src/engine/starters.js';
import { buildLabel, renderLabelHtml } from '../../src/engine/render.js';
import { missingFields } from '../../src/engine/binding.js';
import { sanitizeTemplate } from '../../src/engine/schema.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every starter template is valid and renders its sample data without missing columns', () => {
  const required = ['price-tag', 'inventory', 'shelf', 'address', 'shipping', 'description', 'serial', 'plain'];
  for (const key of required) assert.ok(STARTER_LIST.some((s) => s.key === key), 'starter ' + key);
  for (const s of STARTER_LIST) {
    const t = templateFromStarter(s.key);
    assert.deepEqual(sanitizeTemplate(t), t, s.key + ' is already normalised');
    const [headers, row] = STARTER_SAMPLE[s.key];
    assert.deepEqual(missingFields(t, headers), [], s.key + ' sample has every column');
    const built = buildLabel(t, { headers, record: { cells: row } });
    assert.deepEqual(built.errors, [], s.key);
    assert.match(renderLabelHtml(t, built), /^<article class="els-label"/);
    for (const o of t.objects) {
      assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.width <= t.page.width + 0.01 && o.y + o.height <= t.page.height + 0.01, s.key + ': ' + o.name + ' inside the label');
    }
  }
});

test('calibration starter: TEQ header and the five calibration fields', () => {
  const t = templateFromStarter('calibration-small');
  const [headers, row] = STARTER_SAMPLE['calibration-small'];
  const texts = buildLabel(t, { headers, record: { cells: row } }).items.map((i) => i.text).filter(Boolean);
  assert.deepEqual(texts, ['Trust Egypt for Quality Systems (TEQ)', 'Cert. No.#:', 'TEQ-M-26-0451', 'Cal.Date:', '19/10/2026', 'Due Date:', '19/10/2027', 'S.N.:', 'B123456', 'ID:', 'BAL-01']);
  assert.equal(t.data.quantityField, 'Qty');
});

test('the renderer and engine never touch the network or evaluate code', () => {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx|cjs)$/.test(e.name)) files.push(p); } };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'electron'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    assert.doesNotMatch(text, /\beval\s*\(|new Function\s*\(/, rel + ' uses eval');
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|new WebSocket|navigator\.sendBeacon/, rel + ' makes network requests');
    if (!rel.startsWith('electron')) assert.doesNotMatch(text, /require\(['"](child_process|fs|net|http)/, rel);
  }
});

test('Electron security settings', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /onBeforeRequest[\s\S]*cancel: !ok/, 'production blocks all network requests');
  assert.match(main, /function verify\(event\)[\s\S]*senderFrame/);
  const ps = fs.readFileSync(path.join(root, 'electron', 'print-service.cjs'), 'utf8');
  assert.match(ps, /javascript: false/, 'print windows run without JavaScript');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.electronFuses.runAsNode, false);
  assert.equal(pkg.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(pkg.build.electronFuses.onlyLoadAppFromAsar, true);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  const vite = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
  assert.match(vite, /script-src 'self'/);
  assert.doesNotMatch(vite, /unsafe-eval/);
});
