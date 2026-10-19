import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTemplate, createObject } from '../../src/engine/schema.js';

const require = createRequire(import.meta.url);
const { TemplateStore } = require('../../electron/store.cjs');

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'els-store-'));
  return { dir, store: await new TemplateStore(dir).init() };
}
const sample = (name = 'Price label') => createTemplate({ name, objects: [createObject('text', { content: { mode: 'field', field: 'Product Name' } })] });

test('save → reload keeps every property; revisions increase; versions are kept', async () => {
  const { store } = await freshStore();
  const original = sample();
  const first = await store.save(original);
  assert.equal(first.revision, 1);
  const loaded = await store.get(first.id);
  assert.deepEqual(loaded.objects, original.objects);
  assert.deepEqual(loaded.page, original.page);
  const second = await store.save({ ...loaded, name: 'Renamed' }, { baseRevision: 1 });
  assert.equal(second.revision, 2);
  const history = await store.history(first.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].revision, 1);
  const old = await store.getVersion(first.id, history[0].version);
  assert.equal(old.name, 'Price label');
});

test('never overwrites silently: stale saves are refused unless forced', async () => {
  const { store } = await freshStore();
  const saved = await store.save(sample());
  await store.save({ ...saved, name: 'Edited elsewhere' }, { baseRevision: 1 });
  await assert.rejects(() => store.save({ ...saved, name: 'My edit' }, { baseRevision: 1 }), (e) => e.code === 'conflict' && /changed elsewhere/.test(e.message));
  const forced = await store.save({ ...saved, name: 'My edit' }, { baseRevision: 1, force: true });
  assert.equal(forced.revision, 3);
  assert.equal((await store.history(saved.id)).length, 2, 'the overwritten version is still in history');
  await assert.rejects(() => store.save(saved, { createOnly: true }), /already exists/);
});

test('delete moves to trash; restore and permanent purge are explicit', async () => {
  const { store } = await freshStore();
  const saved = await store.save(sample('To delete'));
  await store.setFavorite(saved.id, true);
  await store.remove(saved.id);
  assert.equal((await store.list()).length, 0);
  const trash = await store.listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].name, 'To delete');
  const restored = await store.restore(trash[0].entry);
  assert.equal(restored.id, saved.id);
  assert.equal((await store.list()).length, 1);
  await store.remove(saved.id);
  const [entry] = await store.listTrash();
  await store.purge(entry.entry);
  assert.equal((await store.listTrash()).length, 0);
});

test('duplicate, rename, favourites, recent and list order', async () => {
  const { store } = await freshStore();
  const a = await store.save(sample('A'));
  const copy = await store.duplicate(a.id);
  assert.notEqual(copy.id, a.id);
  assert.equal(copy.name, 'A (copy)');
  const renamed = await store.rename(copy.id, 'B', copy.revision);
  assert.equal(renamed.name, 'B');
  await store.setFavorite(a.id, true);
  const list = await store.list();
  assert.deepEqual(list.map((t) => t.name).sort(), ['A', 'B']);
  assert.equal(list.find((t) => t.id === a.id).favorite, true);
  assert.equal((await store.getSettings()).recent[0], renamed.id);
});

test('export/import bundles give new ids; invalid templates are reported', async () => {
  const { store } = await freshStore();
  const a = await store.save(sample('A'));
  const b = await store.save(sample('B'));
  const bundle = await store.exportBundle([a.id, b.id]);
  assert.equal(bundle.schema, 'excel-label-studio/bundle');
  const other = (await freshStore()).store;
  const result = await other.importData({ ...bundle, templates: [...bundle.templates, { not: 'a template' }] });
  assert.equal(result.imported.length, 2);
  assert.equal(result.failed.length, 1);
  const again = await other.importData(bundle);
  assert.ok(again.imported.every((t) => ![a.id, b.id].includes(t.id)) || again.imported.length === 2);
  assert.equal((await other.list()).length, 4, 'importing twice never overwrites');
});

test('legacy v0.2 templates can be imported keeping their ids', async () => {
  const { store } = await freshStore();
  const legacy = { id: 'template-legacy-1', name: 'Old', width: 50, height: 30, fields: [{ type: 'column', columnKey: 'Price', x: 1, y: 1, width: 20, height: 5, fontSize: 12 }] };
  const r = await store.importData([legacy], { keepIds: true });
  assert.equal(r.imported[0].id, 'template-legacy-1');
  assert.equal(r.imported[0].version, 2);
});

test('ids and version names cannot escape the data folder', async () => {
  const { store } = await freshStore();
  await assert.rejects(() => store.get('../../etc/passwd'), /Invalid template id/);
  await assert.rejects(() => store.get('a/b'), /Invalid template id/);
  await assert.rejects(() => store.getVersion('abc', '../x.json'), /Invalid version/);
  await assert.rejects(() => store.restore('../../x__1.json'), /Invalid trash entry/);
  const saved = await store.save({ ...sample(), id: 'evil/../../id' });
  assert.match(saved.id, /^tpl-/);
});

test('autosave recovery and crash detection', async () => {
  const { dir, store } = await freshStore();
  await store.writeAutosave({ template: sample('Unsaved work'), storedId: null });
  const second = await new TemplateStore(dir).init();
  const recovery = await second.readRecovery();
  assert.equal(recovery.template.name, 'Unsaved work');
  assert.equal(recovery.crashed, true, 'the first session never closed cleanly');
  second.closeSession();
  const third = await new TemplateStore(dir).init();
  assert.equal(third.previousSessionCrashed, false);
  await third.clearAutosave();
  assert.equal(await third.readRecovery(), null);
});

test('damaged template files are listed, not crashing the library', async () => {
  const { dir, store } = await freshStore();
  await store.save(sample('Good'));
  await fs.writeFile(path.join(dir, 'templates', 'broken.json'), '{ not json');
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((t) => t.id === 'broken').damaged, true);
});

test('writes are atomic and leave no temp files behind', async () => {
  const { dir, store } = await freshStore();
  const saved = await store.save(sample());
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.save({ ...saved, name: 'n' + i }, { force: true })));
  const files = await fs.readdir(path.join(dir, 'templates'));
  assert.deepEqual(files, [saved.id + '.json']);
  assert.equal((await store.get(saved.id)).revision, 11);
});
