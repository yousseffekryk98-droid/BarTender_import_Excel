// Platform bridge. In the desktop app this is the preload API (files, printers, automation).
// In a plain browser (development, tests) a local fallback keeps the designer usable.

import { sanitizeTemplate, newId } from '../engine/schema.js';

export const isDesktop = typeof window !== 'undefined' && Boolean(window.labelDesktop);

const KEY = 'excel-label-studio:browser-store:v2';

function readAll() {
  try { const data = JSON.parse(localStorage.getItem(KEY) || '{}'); return data && typeof data === 'object' ? data : {}; }
  catch { return {}; }
}
function writeAll(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (error) { throw new Error('Browser storage is full or disabled (' + error.name + '). Export your templates to keep them.'); }
}
const summary = (t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, tags: t.tags, width: t.page.width, height: t.page.height, objectCount: t.objects.length, revision: t.revision, updatedAt: t.updatedAt, createdAt: t.createdAt });

function conflict(stored, base) {
  const error = new Error('This template was changed elsewhere (saved revision ' + stored + ', you started from ' + base + ').');
  error.code = 'conflict';
  return error;
}

function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...(input.files || [])]); input.remove(); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

const browserBridge = {
  info: async () => ({ version: 'browser', platform: 'browser', packaged: false, dataDir: 'browser storage', simulatedPrinter: false, crashed: false }),
  onCloseRequested: () => () => {},
  confirmClose: () => {}, cancelClose: () => {},
  templates: {
    async list() {
      const all = readAll();
      const fav = new Set(all.favorites || []);
      return Object.values(all.templates || {}).map((t) => ({ ...summary(t), favorite: fav.has(t.id) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) {
      const t = readAll().templates?.[id];
      if (!t) { const e = new Error('Template not found.'); e.code = 'not-found'; throw e; }
      return sanitizeTemplate(t);
    },
    async save(candidate, options = {}) {
      const all = readAll();
      all.templates = all.templates || {};
      all.history = all.history || {};
      const t = sanitizeTemplate(candidate);
      const current = all.templates[t.id];
      if (current) {
        if (options.createOnly) throw new Error('A template with this id already exists.');
        if (options.baseRevision !== undefined && options.baseRevision !== null && options.baseRevision !== current.revision && !options.force) throw conflict(current.revision, options.baseRevision);
        all.history[t.id] = [current, ...(all.history[t.id] || [])].slice(0, 10);
        t.revision = current.revision + 1;
        t.createdAt = current.createdAt;
      } else t.revision = Math.max(1, (t.revision || 0) + 1);
      t.updatedAt = new Date().toISOString();
      all.templates[t.id] = t;
      all.recent = [t.id, ...(all.recent || []).filter((r) => r !== t.id)].slice(0, 15);
      writeAll(all);
      return t;
    },
    async duplicate(id, name) {
      const t = await this.get(id);
      return this.save({ ...t, id: newId('tpl'), name: name || t.name + ' (copy)', revision: 0 }, { createOnly: true });
    },
    async rename(id, name, revision) { const t = await this.get(id); return this.save({ ...t, name }, { baseRevision: revision }); },
    async remove(id) {
      const all = readAll();
      const t = all.templates?.[id];
      if (!t) throw new Error('Template not found.');
      all.trash = [{ entry: id + '__' + Date.now() + '.json', template: t }, ...(all.trash || [])].slice(0, 50);
      delete all.templates[id];
      writeAll(all);
      return true;
    },
    async trash() { return (readAll().trash || []).map((x) => ({ entry: x.entry, id: x.template.id, name: x.template.name, deletedAt: new Date(Number(x.entry.split('__')[1].replace('.json', ''))).toISOString() })); },
    async restore(entry) {
      const all = readAll();
      const item = (all.trash || []).find((x) => x.entry === entry);
      if (!item) throw new Error('Not in trash.');
      all.trash = all.trash.filter((x) => x.entry !== entry);
      all.templates = all.templates || {};
      const t = sanitizeTemplate(item.template);
      if (all.templates[t.id]) t.id = newId('tpl');
      all.templates[t.id] = t;
      writeAll(all);
      return t;
    },
    async purge(entry) { const all = readAll(); all.trash = (all.trash || []).filter((x) => x.entry !== entry); writeAll(all); return true; },
    async history(id) { return (readAll().history?.[id] || []).map((t, i) => ({ version: String(i), revision: t.revision, updatedAt: t.updatedAt, name: t.name, objectCount: t.objects.length })); },
    async version(id, version) { return sanitizeTemplate(readAll().history?.[id]?.[Number(version)]); },
    async favorite(id, favorite) { const all = readAll(); const set = new Set(all.favorites || []); if (favorite) set.add(id); else set.delete(id); all.favorites = [...set]; writeAll(all); return all.favorites; },
    async importLegacy(list) { const imported = []; for (const t of list) imported.push(await this.save({ ...t, revision: 0 })); return { imported, failed: [] }; },
    async importDialog() {
      const files = await pickFile('.elslabel,.json', true);
      if (!files.length) return { canceled: true };
      const out = { imported: [], failed: [] };
      for (const file of files) {
        try {
          const data = JSON.parse(await file.text());
          const list = Array.isArray(data) ? data : Array.isArray(data.templates) ? data.templates : [data];
          for (const item of list) {
            const t = sanitizeTemplate(item);
            if (!t) throw new Error('Not a label template.');
            out.imported.push(await this.save({ ...t, id: newId('tpl'), revision: 0 }, { createOnly: true }));
          }
        } catch (error) { out.failed.push({ file: file.name, error: error.message }); }
      }
      return out;
    },
    async exportDialog(ids, name) {
      const list = [];
      for (const id of ids) list.push(await this.get(id));
      const data = list.length === 1 ? list[0] : { schema: 'excel-label-studio/bundle', version: 1, exportedAt: new Date().toISOString(), templates: list };
      download((name || list[0]?.name || 'templates').replace(/[^\w\- ]+/g, '-') + '.elslabel', JSON.stringify(data, null, 2));
      return { path: 'download' };
    }
  },
  settings: {
    async get() { const all = readAll(); return { ...(all.settings || {}), recentDataFiles: [] }; },
    async update(patch) { const all = readAll(); all.settings = { ...(all.settings || {}), ...patch }; writeAll(all); return true; }
  },
  autosave: {
    async write(payload) { try { localStorage.setItem(KEY + ':autosave', JSON.stringify({ savedAt: new Date().toISOString(), ...payload })); } catch { /* best effort */ } },
    async read() { try { const d = JSON.parse(localStorage.getItem(KEY + ':autosave') || 'null'); if (d?.template) d.template = sanitizeTemplate(d.template); return d; } catch { return null; } },
    async clear() { localStorage.removeItem(KEY + ':autosave'); }
  },
  data: {
    async openDialog() {
      const [file] = await pickFile('.xlsx,.xlsm,.xls,.csv,.tsv,.txt');
      if (!file) return { canceled: true };
      return { name: file.name, size: file.size, modifiedAt: new Date(file.lastModified).toISOString(), bytes: new Uint8Array(await file.arrayBuffer()), token: '' };
    },
    async reload() { throw new Error('Reloading files from disk needs the desktop app. Open the file again.'); },
    async forget() { return true; }
  },
  images: {
    async openDialog() {
      const [file] = await pickFile('image/png,image/jpeg,image/gif,image/bmp,image/webp');
      if (!file) return { canceled: true };
      if (file.size > 2 * 1024 * 1024) throw new Error('Images must be smaller than 2 MB.');
      const dataUri = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
      return { name: file.name, dataUri };
    }
  },
  print: {
    async printers() { return []; },
    async job(request) {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0';
      document.body.appendChild(frame);
      frame.contentDocument.open(); frame.contentDocument.write(request.html); frame.contentDocument.close();
      await frame.contentDocument.fonts?.ready;
      frame.contentWindow.print();
      setTimeout(() => frame.remove(), 60_000);
      return { ok: true, spooled: false, jobId: request.jobId || newId('job') };
    },
    async cancelled() { return true; },
    async pdfDialog(request) { return this.job(request); },
    async pdfBuffer() { throw new Error('PDF export needs the desktop app.'); },
    async history() { return []; },
    async reprint() { throw new Error('Reprint needs the desktop app.'); },
    async clearHistory() { return true; }
  },
  shell: { async showFile() { return false; }, async openDataFolder() { return false; } },
  automation: null
};

export const desktop = isDesktop ? window.labelDesktop : browserBridge;
