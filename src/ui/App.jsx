import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FilePlus2, FolderOpen, Save, Undo2, Redo2, Scissors, Copy, ClipboardPaste, Trash2, Database, RefreshCw, Printer, FileDown,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  BringToFront, SendToBack, Group, Ungroup, ZoomIn, ZoomOut, Maximize, Grid3x3, Magnet, Tag, Cable
} from 'lucide-react';
import MenuBar from './MenuBar.jsx';
import Canvas from './Canvas.jsx';
import LeftPanel from './LeftPanel.jsx';
import PropertiesPanel from './PropertiesPanel.jsx';
import DataPanel from './DataPanel.jsx';
import PrintDialog from './PrintDialog.jsx';
import PrinterConnectionDialog from './dialogs/PrinterConnectionDialog.jsx';
import TextEditorDialog from './dialogs/TextEditorDialog.jsx';
import DatabaseWizard from './dialogs/DatabaseWizard.jsx';
import TemplateManager from './dialogs/TemplateManager.jsx';
import AutomationDialog from './dialogs/AutomationDialog.jsx';
import { NewTemplateDialog, WarningsDialog, JobHistoryDialog, HelpDialog, RecoveryDialog } from './dialogs/Misc.jsx';
import { IconButton, Notice, useDialog } from './controls.jsx';
import { useDocument } from './useDocument.js';
import { alignObjects, distributeObjects, sameSize, reorder, MM_TO_PX } from './geometry.js';
import { createObject, newId, sanitizeTemplate, SAFE_FONTS } from '../engine/schema.js';
import { templateFromStarter } from '../engine/starters.js';
import { applyFilters, sortRecords, searchRecords } from '../engine/jobs.js';
import { templateFieldNames, missingFields } from '../engine/binding.js';
import { applyRenames } from '../engine/remap.js';
import { readSpreadsheet, withHeaderRow } from '../data/importers.js';
import { handleAutomationRender } from '../render/automation.js';
import { desktop, isDesktop } from '../platform/api.js';
import { connectWindowsPrinter } from '../platform/printer-connection.js';

const LEGACY_KEY = 'excel-label-studio:text-templates:v1';

function initialTemplate() {
  const t = templateFromStarter('price-tag');
  return { ...t, name: 'New label' };
}

function isTyping(event) {
  const el = event.target;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export default function App() {
  const ask = useDialog();
  const doc = useDocument(initialTemplate());
  const { template, selection, selected } = doc;
  const [templates, setTemplates] = useState([]);
  const [settings, setSettings] = useState({});
  const [info, setInfo] = useState(null);
  const [printers, setPrinters] = useState([]);
  const [fonts, setFonts] = useState(SAFE_FONTS);
  const [connection, setConnection] = useState(null);
  const [query, setQuery] = useState('');
  const [rowSelection, setRowSelection] = useState(new Set());
  const [previewId, setPreviewId] = useState(null);
  const [zoom, setZoom] = useState(3);
  const [view, setView] = useState({ grid: true, gridSize: 1, snapGrid: true, snapObjects: true });
  const [dialog, setDialog] = useState(null);
  const [editingTextId, setEditingTextId] = useState(null);
  const [notices, setNotices] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [leftTab, setLeftTab] = useState(null);
  const [bottomHeight, setBottomHeight] = useState(230);
  const autosaveTimer = useRef(null);
  const started = useRef(false);

  const notify = useCallback((text, kind = 'ok') => {
    const id = newId('n');
    setNotices((n) => [...n.slice(-3), { id, text, kind }]);
    if (kind !== 'error') setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), kind === 'warn' ? 9000 : 5000);
  }, []);

  const refreshTemplates = useCallback(async () => { try { setTemplates(await desktop.templates.list()); } catch (e) { notify('Could not list templates: ' + e.message, 'error'); } }, [notify]);
  const refreshPrinters = useCallback(async (force = false) => {
    try {
      const list = await desktop.print.printers(force);
      setPrinters(list);
      return list;
    } catch (error) {
      setPrinters([]);
      throw error;
    }
  }, []);
  const connectPrinter = useCallback(async (name) => {
    const { printer } = await connectWindowsPrinter({
      printerName: name,
      listPrinters: refreshPrinters,
      saveDefault: (selected) => desktop.settings.update({ defaultPrinter: selected })
    });
    setSettings((s) => ({ ...s, defaultPrinter: printer.name }));
    return printer;
  }, [refreshPrinters]);

  // ---------- startup ----------
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const [i, s] = await Promise.all([desktop.info().catch(() => null), desktop.settings.get().catch(() => ({}))]);
      setInfo(i); setSettings(s);
      if (s.view) setView((v) => ({ ...v, ...s.view }));
      // one-time migration of v0.2.0 browser-storage templates
      if (!s.legacyMigrated) {
        try {
          const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
          if (Array.isArray(legacy) && legacy.length) {
            const converted = legacy.map((t) => sanitizeTemplate(t)).filter(Boolean);
            const r = await desktop.templates.importLegacy(converted);
            notify('Moved ' + r.imported.length + ' template(s) from the previous version into the new template library.', 'ok');
          }
          await desktop.settings.update({ legacyMigrated: true });
        } catch (e) { notify('Older templates could not be migrated: ' + e.message, 'warn'); }
      }
      await refreshTemplates();
      const rec = await desktop.autosave.read().catch(() => null);
      if (rec?.template) setRecovery(rec);
      else if (s.lastTemplateId) {
        try { doc.load(await desktop.templates.get(s.lastTemplateId), { stored: true }); } catch { /* deleted */ }
      }
      refreshPrinters(false).catch((error) => notify('Could not list Windows printers: ' + error.message, 'warn'));
      try {
        if (window.queryLocalFonts) {
          const list = await window.queryLocalFonts();
          const families = [...new Set(list.map((f) => f.family))];
          if (families.length) setFonts(families);
        }
      } catch { /* permission denied: keep safe fonts */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // automation rendering requests from the main process
  useEffect(() => desktop.automation?.onRenderRequest(handleAutomationRender), []);

  // autosave (crash recovery)
  useEffect(() => {
    clearTimeout(autosaveTimer.current);
    if (!doc.dirty) return undefined;
    autosaveTimer.current = setTimeout(() => {
      desktop.autosave.write({ template, storedId: doc.storedId, baseRevision: doc.baseRevision }).catch(() => {});
    }, Math.max(3, Number(settings.autosaveSeconds) || 5) * 1000);
    return () => clearTimeout(autosaveTimer.current);
  }, [template, doc.dirty, doc.storedId, doc.baseRevision, settings.autosaveSeconds]);

  // ---------- data ----------
  const table = connection?.table || null;
  const headers = table?.headers || [];
  const processed = useMemo(() => (table ? sortRecords(applyFilters(table.records, headers, template.data.filters), headers, template.data.sort) : []), [table, headers, template.data.filters, template.data.sort]);
  const rows = useMemo(() => searchRecords(processed, query), [processed, query]);
  const previewRecord = useMemo(() => (table ? (processed.find((r) => r.id === previewId) || processed[0] || null) : null), [table, processed, previewId]);
  const prompts = useMemo(() => Object.fromEntries(template.prompts.map((p) => [p.name, p.default])), [template.prompts]);
  const usedFields = useMemo(() => new Set(templateFieldNames(template).map((f) => f.toLocaleLowerCase())), [template]);
  const missing = useMemo(() => (table ? missingFields(template, headers) : []), [template, table, headers]);
  const fieldChoices = useMemo(() => (headers.length ? headers : [...new Set(templateFieldNames(template))]), [headers, template]);

  function adoptConnection({ file, result, sheetIndex, sheet }) {
    const sheets = result.sheets.map((s, i) => (i === sheetIndex && sheet ? sheet : s));
    const next = { fileName: file.name, token: file.token || '', folder: file.folder, result, sheets, sheetIndex, table: sheets[sheetIndex].table };
    setConnection(next);
    setRowSelection(new Set(next.table.records.map((r) => r.id)));
    setPreviewId(next.table.records[0]?.id || null);
    setQuery('');
    return next;
  }

  async function connectFromWizard(payload) {
    const next = adoptConnection(payload);
    setDialog(null);
    doc.update((t) => {
      const renamed = applyRenames(t, payload.renames);
      return { ...renamed, data: { ...renamed.data, fileName: payload.file.name, sheetName: next.sheets[next.sheetIndex].name, headerRow: next.table.headerRow } };
    });
    const warnings = next.table.warnings.filter((w) => w.level !== 'info');
    notify('Connected ' + next.table.records.length.toLocaleString() + ' rows from ' + payload.file.name + (warnings.length ? ' — ' + warnings.length + ' warning(s), see "notes".' : '.'), warnings.length ? 'warn' : 'ok');
    setLeftTab('data');
    const s = await desktop.settings.get().catch(() => null);
    if (s) setSettings(s);
  }

  async function reloadData() {
    if (!connection?.token) return notify('Open the file again to refresh it.', 'warn');
    try {
      const f = await desktop.data.reload(connection.token);
      const result = await readSpreadsheet({ name: f.name, size: f.size, bytes: f.bytes });
      const sheetName = connection.sheets[connection.sheetIndex].name;
      let index = result.sheets.findIndex((s) => s.name === sheetName);
      if (index < 0) { index = Math.max(0, result.sheets.findIndex((s) => s.table?.records.length)); notify('Sheet "' + sheetName + '" no longer exists; using "' + result.sheets[index].name + '".', 'warn'); }
      let sheet = result.sheets[index];
      if (connection.table.headerRow !== sheet.table?.headerRow) { try { sheet = withHeaderRow(sheet, connection.table.headerRow); } catch { /* keep detected */ } }
      const previousSelection = rowSelection;
      const allSelected = previousSelection.size === connection.table.records.length;
      const next = adoptConnection({ file: { ...f, token: connection.token }, result, sheetIndex: index, sheet });
      if (!allSelected) setRowSelection(new Set(next.table.records.filter((r) => previousSelection.has(r.id)).map((r) => r.id)));
      notify('Reloaded ' + next.table.records.length.toLocaleString() + ' rows (file saved ' + new Date(f.modifiedAt).toLocaleString() + ').');
    } catch (e) { notify(e.message, 'error'); }
  }

  function chooseSheet(index) {
    const sheets = connection.sheets;
    setConnection({ ...connection, sheetIndex: index, table: sheets[index].table });
    setRowSelection(new Set(sheets[index].table?.records.map((r) => r.id) || []));
    setPreviewId(sheets[index].table?.records[0]?.id || null);
    doc.update((t) => ({ ...t, data: { ...t.data, sheetName: sheets[index].name, headerRow: sheets[index].table?.headerRow || 1 } }));
  }

  function chooseHeaderRow(rowNumber) {
    try {
      const sheet = withHeaderRow(connection.sheets[connection.sheetIndex], rowNumber);
      const sheets = connection.sheets.map((s, i) => (i === connection.sheetIndex ? sheet : s));
      setConnection({ ...connection, sheets, table: sheet.table });
      setRowSelection(new Set(sheet.table.records.map((r) => r.id)));
      setPreviewId(sheet.table.records[0]?.id || null);
      doc.update((t) => ({ ...t, data: { ...t.data, headerRow: rowNumber } }));
    } catch (e) { notify(e.message, 'error'); }
  }

  function changeSelection(mode, id) {
    setRowSelection((current) => {
      const next = new Set(current);
      if (mode === 'toggle') { if (next.has(id)) next.delete(id); else next.add(id); }
      if (mode === 'all-visible') rows.forEach((r) => next.add(r.id));
      if (mode === 'none-visible') rows.forEach((r) => next.delete(r.id));
      if (mode === 'all') return new Set(processed.map((r) => r.id));
      if (mode === 'none') return new Set();
      if (mode === 'invert') return new Set(processed.filter((r) => !current.has(r.id)).map((r) => r.id));
      return next;
    });
  }

  // ---------- templates ----------
  async function confirmDiscard() {
    if (!doc.dirty) return true;
    const choice = await ask({ title: 'Unsaved changes', message: 'Save changes to "' + template.name + '" first?', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', kind: 'primary' }], cancelValue: 'cancel' });
    if (choice === 'save') return save();
    return choice === 'discard';
  }

  async function openTemplate(id) {
    if (id === doc.storedId) { setDialog(null); return; }
    if (!(await confirmDiscard())) return;
    try {
      const t = await desktop.templates.get(id);
      doc.load(t, { stored: true });
      setDialog(null);
      await desktop.settings.update({ lastTemplateId: id }).catch(() => {});
      desktop.autosave.clear().catch(() => {});
      if (table) {
        const m = missingFields(t, headers);
        if (m.length) notify('Opened "' + t.name + '". Not in the current data: ' + m.map((x) => x.field).join(', ') + '. Use Database → Connect to map them.', 'warn');
        else notify('Opened "' + t.name + '".');
      } else notify('Opened "' + t.name + '".');
    } catch (e) { notify(e.message, 'error'); }
  }

  async function newFrom(t) {
    if (!(await confirmDiscard())) return;
    doc.load(t);
    setDialog(null);
  }

  async function save(options = {}) {
    if (!doc.storedId || options.saveAs) {
      const name = await ask({ title: options.saveAs ? 'Save as' : 'Save template', message: 'Template name:', input: { defaultValue: options.saveAs ? template.name + ' (copy)' : template.name }, confirmLabel: 'Save' });
      if (!name) return false;
      try {
        const saved = await desktop.templates.save({ ...template, id: newId('tpl'), name, revision: 0 }, { createOnly: true });
        doc.markSaved(saved);
        await refreshTemplates();
        await desktop.settings.update({ lastTemplateId: saved.id }).catch(() => {});
        desktop.autosave.clear().catch(() => {});
        notify('Saved "' + saved.name + '".');
        return true;
      } catch (e) { notify('Save failed: ' + e.message, 'error'); return false; }
    }
    try {
      const saved = await desktop.templates.save(template, { baseRevision: doc.baseRevision });
      doc.markSaved(saved);
      await refreshTemplates();
      desktop.autosave.clear().catch(() => {});
      notify('Saved "' + saved.name + '" (revision ' + saved.revision + ').');
      return true;
    } catch (e) {
      if (e.code === 'conflict') {
        const choice = await ask({ title: 'Template changed elsewhere', message: e.message + ' What do you want to do?', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save as a copy', value: 'copy' }, { label: 'Overwrite', value: 'overwrite', kind: 'danger' }], cancelValue: 'cancel' });
        if (choice === 'copy') return save({ saveAs: true });
        if (choice === 'overwrite') {
          try { const saved = await desktop.templates.save(template, { force: true }); doc.markSaved(saved); await refreshTemplates(); notify('Saved (overwrote the other change; it is kept in version history).'); return true; }
          catch (err) { notify('Save failed: ' + err.message, 'error'); }
        }
        return false;
      }
      if (e.code === 'not-found') return save({ saveAs: true });
      notify('Save failed: ' + e.message, 'error');
      return false;
    }
  }

  async function saveSerialState(serialState) {
    doc.update((t) => ({ ...t, serialState }));
    if (!doc.storedId) { notify('Serial numbers continue from the last print only after the template is saved.', 'warn'); return; }
    try {
      const stored = await desktop.templates.get(doc.storedId);
      const saved = await desktop.templates.save({ ...stored, serialState }, { baseRevision: stored.revision });
      doc.patchStored(saved);
      refreshTemplates();
    } catch (e) { notify('Could not store the next serial number: ' + e.message, 'warn'); }
  }

  async function openVersion(id, version) {
    if (!(await confirmDiscard())) return;
    const old = await desktop.templates.version(id, version);
    const current = await desktop.templates.get(id);
    // open the stored template, then apply the old content as an unsaved change
    doc.load(current, { stored: true });
    doc.update(() => ({ ...old, id: current.id, name: current.name, serialState: current.serialState }));
    setDialog(null);
    notify('Loaded revision ' + old.revision + '. Save to make it the current version.', 'warn');
  }

  // close / quit
  useEffect(() => desktop.onCloseRequested(async () => {
    if (!doc.dirty) { desktop.autosave.clear().catch(() => {}); desktop.confirmClose(); return; }
    const choice = await ask({ title: 'Unsaved changes', message: 'Save changes to "' + template.name + '" before closing?', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard' }, { label: 'Save', value: 'save', kind: 'primary' }], cancelValue: 'cancel' });
    if (choice === 'cancel') { desktop.cancelClose(); return; }
    if (choice === 'save' && !(await save())) { desktop.cancelClose(); return; }
    await desktop.autosave.clear().catch(() => {});
    desktop.confirmClose();
  }), [doc.dirty, template, ask]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- objects ----------
  function centerPosition(w, h) {
    return { x: Math.max(0, Math.round((template.page.width - w) / 2 * 2) / 2), y: Math.max(0, Math.round((template.page.height - h) / 2 * 2) / 2) };
  }

  async function addTool(tool, at) {
    const w = Math.min(template.page.width - 4, 30);
    const pos = (ww, hh) => (at ? { x: at.x, y: at.y } : centerPosition(ww, hh));
    let object;
    switch (tool) {
      case 'text': object = createObject('text', { ...pos(w, 6), width: w, height: 6, name: 'Text', content: { mode: 'static', text: 'Text' } }); break;
      case 'field': {
        const field = headers[0] || fieldChoices[0] || '';
        object = createObject('text', { ...pos(w, 6), width: w, height: 6, name: field || 'Excel field', content: { mode: 'field', field } });
        break;
      }
      case 'template': object = createObject('text', { ...pos(w, 6), width: w, height: 6, name: 'Combined text', content: { mode: 'template', template: headers.slice(0, 2).map((h) => '{' + h + '}').join(' – ') || '{Column 1} – {Column 2}' } }); break;
      case 'date': object = createObject('text', { ...pos(24, 5), width: 24, height: 5, name: 'Date', content: { mode: 'date' }, format: { kind: 'date', datePattern: 'dd/MM/yyyy' } }); break;
      case 'serial': object = createObject('text', { ...pos(24, 6), width: 24, height: 6, name: 'Serial', content: { mode: 'serial', serial: { start: '0001', step: 1 } } }); break;
      case 'line': object = createObject('line', { ...pos(w, 0.6), width: w }); break;
      case 'rect': object = createObject('rect', { ...pos(20, 10), width: 20, height: 10 }); break;
      case 'ellipse': object = createObject('ellipse', { ...pos(10, 10) }); break;
      case 'image': {
        object = createObject('image', { ...pos(12, 12) });
        try { const img = await desktop.images.openDialog(); if (img?.dataUri) object = { ...object, src: img.dataUri, name: img.name.slice(0, 60) }; }
        catch (e) { notify(e.message, 'error'); }
        break;
      }
      case 'table': object = createObject('table', { ...pos(40, 12), width: 40, height: 12 }); break;
      case 'barcode': object = createObject('barcode', { ...pos(35, 12), content: headers[0] ? { mode: 'field', field: headers[0] } : { mode: 'static', text: '123456' } }); break;
      case 'qrcode': object = createObject('barcode', { ...pos(14, 14), width: 14, height: 14, name: 'QR code', symbology: 'qrcode', humanReadable: false, content: headers[0] ? { mode: 'field', field: headers[0] } : { mode: 'static', text: 'https://example.com' } }); break;
      default: return;
    }
    if (object.x + object.width > template.page.width) object.width = Math.max(2, template.page.width - object.x);
    doc.addObjects([object]);
  }

  function addField(name, at) {
    const w = Math.min(template.page.width - 4, 30);
    const p = at || centerPosition(w, 6);
    doc.addObjects([createObject('text', { x: p.x, y: p.y, width: Math.min(w, template.page.width - p.x), height: 6, name, content: { mode: 'field', field: name }, style: { fontSize: 10 } })]);
  }

  async function pickImage(objectId) {
    try { const img = await desktop.images.openDialog(); if (img?.dataUri) doc.patchObjects([objectId], { src: img.dataUri }); }
    catch (e) { notify(e.message, 'error'); }
  }

  function editText(id) {
    const object = template.objects.find((item) => item.id === id);
    if (object?.type === 'text') {
      doc.select([id]);
      setEditingTextId(id);
    }
  }

  const ids = selection;
  const setObjects = (fn) => doc.update((t) => ({ ...t, objects: fn(t.objects) }));
  const ops = {
    align: (mode) => setObjects((objs) => alignObjects(objs, ids, mode, template.page)),
    distribute: (axis) => setObjects((objs) => distributeObjects(objs, ids, axis)),
    sameSize: (dim) => setObjects((objs) => sameSize(objs, ids, dim)),
    order: (mode) => setObjects((objs) => reorder(objs, ids, mode)),
    group: () => { if (ids.length < 2) return; const g = newId('grp'); doc.patchObjects(ids, { groupId: g }); },
    ungroup: () => doc.patchObjects(ids, { groupId: '' }),
    lock: (locked) => doc.patchObjects(ids, { locked }),
    nudge: (dx, dy) => doc.update((t) => ({ ...t, objects: t.objects.map((o) => (ids.includes(o.id) && !o.locked ? { ...o, x: Math.round((o.x + dx) * 1000) / 1000, y: Math.round((o.y + dy) * 1000) / 1000 } : o)) }), { coalesce: 'nudge-' + ids.join(',') }),
    selectAll: () => doc.select(template.objects.filter((o) => !o.hidden).map((o) => o.id)),
    toggleStyle: (key) => { const texts = selected.filter((o) => o.type === 'text'); if (texts.length) doc.patchObjects(texts.map((o) => o.id), { style: { [key]: !texts[0].style[key] } }); }
  };

  function fitZoom() {
    const el = document.querySelector('.canvas-scroll');
    if (!el) return;
    const z = Math.min((el.clientWidth - 100) / (template.page.width * MM_TO_PX), (el.clientHeight - 100) / (template.page.height * MM_TO_PX));
    setZoom(Math.max(0.25, Math.min(16, Math.round(z * 100) / 100)));
  }
  useEffect(() => { const t = setTimeout(fitZoom, 50); return () => clearTimeout(t); }, [template.page.width, template.page.height, bottomHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  function setViewOption(patch) {
    setView((v) => { const next = { ...v, ...patch }; desktop.settings.update({ showGrid: next.grid, snapToGrid: next.snapGrid, gridSize: next.gridSize }).catch(() => {}); return next; });
  }

  const openPrint = () => { refreshPrinters(true).catch((error) => notify('Could not refresh printers: ' + error.message, 'warn')); setDialog('print'); };
  const openPrinterSetup = () => { refreshPrinters(true).catch((error) => notify('Could not refresh printers: ' + error.message, 'warn')); setDialog('printer'); };
  const openWizard = () => setDialog('wizard');
  const canEdit = selection.length > 0;

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (dialog || recovery || document.querySelector('.modal-backdrop')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 's') { e.preventDefault(); save({ saveAs: e.shiftKey }); return; }
      if (ctrl && key === 'p') { e.preventDefault(); openPrint(); return; }
      if (ctrl && key === 'o') { e.preventDefault(); setDialog('manager'); return; }
      if (ctrl && key === 'n') { e.preventDefault(); setDialog('new'); return; }
      if (ctrl && e.shiftKey && key === 'd') { e.preventDefault(); openWizard(); return; }
      if (isTyping(e)) return;
      if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); doc.undo(); }
      else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); doc.redo(); }
      else if (ctrl && key === 'c') { if (doc.copy()) e.preventDefault(); }
      else if (ctrl && key === 'x') { if (doc.cut()) e.preventDefault(); }
      else if (ctrl && key === 'v') { e.preventDefault(); doc.paste(); }
      else if (ctrl && key === 'd') { e.preventDefault(); doc.duplicate(); }
      else if (ctrl && key === 'a') { e.preventDefault(); ops.selectAll(); }
      else if (ctrl && key === 'g') { e.preventDefault(); if (e.shiftKey) ops.ungroup(); else ops.group(); }
      else if (ctrl && key === 'b') { e.preventDefault(); ops.toggleStyle('bold'); }
      else if (ctrl && key === 'i') { e.preventDefault(); ops.toggleStyle('italic'); }
      else if (ctrl && key === 'u') { e.preventDefault(); ops.toggleStyle('underline'); }
      else if (ctrl && key === ']') { e.preventDefault(); ops.order(e.shiftKey ? 'front' : 'forward'); }
      else if (ctrl && key === '[') { e.preventDefault(); ops.order(e.shiftKey ? 'back' : 'backward'); }
      else if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); setZoom((z) => Math.min(16, Math.round(z * 1.25 * 100) / 100)); }
      else if (ctrl && key === '-') { e.preventDefault(); setZoom((z) => Math.max(0.25, Math.round(z / 1.25 * 100) / 100)); }
      else if (ctrl && key === '0') { e.preventDefault(); fitZoom(); }
      else if (ctrl && key === '1') { e.preventDefault(); setZoom(1); }
      else if (key === 'delete' || key === 'backspace') { if (canEdit) { e.preventDefault(); doc.removeSelected(); } }
      else if (key === 'escape') doc.select([]);
      else if (key.startsWith('arrow') && canEdit) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : e.altKey ? 0.1 : 0.5;
        ops.nudge(key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0, key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0);
      }
    };
    const onKeyUp = (e) => { if (e.key.startsWith('Arrow')) doc.endCoalesce(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  });

  // ---------- menus ----------
  const menus = [
    { id: 'file', label: 'File', items: [
      { label: 'New label…', shortcut: 'Ctrl+N', onClick: () => setDialog('new') },
      { label: 'Open template…', shortcut: 'Ctrl+O', onClick: () => setDialog('manager') },
      { label: 'Save', shortcut: 'Ctrl+S', onClick: () => save() },
      { label: 'Save as…', shortcut: 'Ctrl+Shift+S', onClick: () => save({ saveAs: true }) },
      '-',
      { label: 'Import templates…', onClick: async () => { const r = await desktop.templates.importDialog().catch((e) => notify(e.message, 'error')); if (r && !r.canceled) { await refreshTemplates(); notify('Imported ' + r.imported.length + ' template(s).' + (r.failed.length ? ' ' + r.failed.length + ' failed.' : ''), r.failed.length ? 'warn' : 'ok'); } } },
      { label: 'Export this template…', disabled: !doc.storedId, onClick: async () => { const r = await desktop.templates.exportDialog([doc.storedId], template.name).catch((e) => notify(e.message, 'error')); if (r?.path) notify('Exported to ' + r.path); } },
      '-',
      { label: 'Print…', shortcut: 'Ctrl+P', onClick: openPrint },
      { label: 'Print history & reprint…', onClick: () => { refreshPrinters(false); setDialog('history'); }, disabled: !isDesktop },
      '-',
      { label: 'Open data folder', onClick: () => desktop.shell.openDataFolder(), disabled: !isDesktop }
    ] },
    { id: 'edit', label: 'Edit', items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', onClick: doc.undo, disabled: !doc.canUndo },
      { label: 'Redo', shortcut: 'Ctrl+Y', onClick: doc.redo, disabled: !doc.canRedo },
      '-',
      { label: 'Cut', shortcut: 'Ctrl+X', onClick: doc.cut, disabled: !canEdit },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: doc.copy, disabled: !canEdit },
      { label: 'Paste', shortcut: 'Ctrl+V', onClick: () => doc.paste(), disabled: !doc.hasClipboard() },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: doc.duplicate, disabled: !canEdit },
      { label: 'Delete', shortcut: 'Del', onClick: doc.removeSelected, disabled: !canEdit },
      '-',
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: ops.selectAll },
      { label: 'Select none', shortcut: 'Esc', onClick: () => doc.select([]), disabled: !canEdit }
    ] },
    { id: 'view', label: 'View', items: [
      { label: 'Zoom in', shortcut: 'Ctrl++', onClick: () => setZoom((z) => Math.min(16, Math.round(z * 1.25 * 100) / 100)) },
      { label: 'Zoom out', shortcut: 'Ctrl+-', onClick: () => setZoom((z) => Math.max(0.25, Math.round(z / 1.25 * 100) / 100)) },
      { label: 'Zoom to fit', shortcut: 'Ctrl+0', onClick: fitZoom },
      { label: 'Actual size (100%)', shortcut: 'Ctrl+1', onClick: () => setZoom(1) },
      '-',
      { label: 'Show grid', checked: view.grid, onClick: () => setViewOption({ grid: !view.grid }) },
      { label: 'Snap to grid', checked: view.snapGrid, onClick: () => setViewOption({ snapGrid: !view.snapGrid }) },
      { label: 'Snap to objects', checked: view.snapObjects, onClick: () => setViewOption({ snapObjects: !view.snapObjects }) },
      { label: 'Grid 0.5 mm', checked: view.gridSize === 0.5, onClick: () => setViewOption({ gridSize: 0.5 }) },
      { label: 'Grid 1 mm', checked: view.gridSize === 1, onClick: () => setViewOption({ gridSize: 1 }) },
      { label: 'Grid 2 mm', checked: view.gridSize === 2, onClick: () => setViewOption({ gridSize: 2 }) },
      { label: 'Grid 5 mm', checked: view.gridSize === 5, onClick: () => setViewOption({ gridSize: 5 }) }
    ] },
    { id: 'insert', label: 'Insert', items: [
      { label: 'Text', onClick: () => addTool('text') }, { label: 'Excel field', onClick: () => addTool('field') }, { label: 'Combined text', onClick: () => addTool('template') },
      { label: 'Date', onClick: () => addTool('date') }, { label: 'Serial number', onClick: () => addTool('serial') }, '-',
      { label: 'Line', onClick: () => addTool('line') }, { label: 'Rectangle', onClick: () => addTool('rect') }, { label: 'Ellipse', onClick: () => addTool('ellipse') },
      { label: 'Image…', onClick: () => addTool('image') }, { label: 'Table', onClick: () => addTool('table') }, '-',
      { label: 'Barcode (optional)', onClick: () => addTool('barcode') }, { label: 'QR code (optional)', onClick: () => addTool('qrcode') }
    ] },
    { id: 'format', label: 'Format', items: [
      { label: 'Align left', onClick: () => ops.align('left'), disabled: !canEdit }, { label: 'Align centre', onClick: () => ops.align('hcenter'), disabled: !canEdit },
      { label: 'Align right', onClick: () => ops.align('right'), disabled: !canEdit }, { label: 'Align top', onClick: () => ops.align('top'), disabled: !canEdit },
      { label: 'Align middle', onClick: () => ops.align('vcenter'), disabled: !canEdit }, { label: 'Align bottom', onClick: () => ops.align('bottom'), disabled: !canEdit },
      '-',
      { label: 'Distribute horizontally', onClick: () => ops.distribute('x'), disabled: selection.length < 3 },
      { label: 'Distribute vertically', onClick: () => ops.distribute('y'), disabled: selection.length < 3 },
      { label: 'Same width', onClick: () => ops.sameSize('width'), disabled: selection.length < 2 },
      { label: 'Same height', onClick: () => ops.sameSize('height'), disabled: selection.length < 2 },
      '-',
      { label: 'Bring to front', shortcut: 'Ctrl+Shift+]', onClick: () => ops.order('front'), disabled: !canEdit },
      { label: 'Bring forward', shortcut: 'Ctrl+]', onClick: () => ops.order('forward'), disabled: !canEdit },
      { label: 'Send backward', shortcut: 'Ctrl+[', onClick: () => ops.order('backward'), disabled: !canEdit },
      { label: 'Send to back', shortcut: 'Ctrl+Shift+[', onClick: () => ops.order('back'), disabled: !canEdit },
      '-',
      { label: 'Group', shortcut: 'Ctrl+G', onClick: ops.group, disabled: selection.length < 2 },
      { label: 'Ungroup', shortcut: 'Ctrl+Shift+G', onClick: ops.ungroup, disabled: !selected.some((o) => o.groupId) },
      { label: 'Lock', onClick: () => ops.lock(true), disabled: !canEdit }, { label: 'Unlock', onClick: () => ops.lock(false), disabled: !selected.some((o) => o.locked) }
    ] },
    { id: 'database', label: 'Database', items: [
      { label: 'Connect / change data source…', shortcut: 'Ctrl+Shift+D', onClick: openWizard },
      { label: 'Reload data from disk', onClick: reloadData, disabled: !connection?.token },
      { label: 'Data notes & warnings…', onClick: () => setDialog('warnings'), disabled: !table?.warnings.length },
      '-',
      { label: 'Select all rows', onClick: () => changeSelection('all'), disabled: !table },
      { label: 'Select no rows', onClick: () => changeSelection('none'), disabled: !table },
      { label: 'Invert row selection', onClick: () => changeSelection('invert'), disabled: !table },
      '-',
      { label: 'Disconnect data source', onClick: () => { setConnection(null); setRowSelection(new Set()); setPreviewId(null); }, disabled: !table }
    ] },
    { id: 'print', label: 'Print', items: [
      { label: 'Print…', shortcut: 'Ctrl+P', onClick: openPrint },
      { label: 'Print history & reprint…', onClick: () => { refreshPrinters(false); setDialog('history'); }, disabled: !isDesktop },
      { label: 'Connect printer…', onClick: openPrinterSetup },
      { label: 'Refresh printers', onClick: () => refreshPrinters(true).catch((error) => notify(error.message, 'error')), disabled: !isDesktop }
    ] },
    { id: 'tools', label: 'Tools', items: [
      { label: 'Automation (watch folders, API)…', onClick: () => { refreshPrinters(false); setDialog('automation'); }, disabled: !isDesktop },
      { label: 'Template manager…', onClick: () => setDialog('manager') }
    ] },
    { id: 'help', label: 'Help', items: [{ label: 'Help, formulas & shortcuts', shortcut: 'F1', onClick: () => setDialog('help') }] }
  ];

  useEffect(() => {
    const onF1 = (e) => { if (e.key === 'F1') { e.preventDefault(); setDialog('help'); } };
    window.addEventListener('keydown', onF1);
    return () => window.removeEventListener('keydown', onF1);
  }, []);

  const editingText = template.objects.find((o) => o.id === editingTextId && o.type === 'text');
  const defaultPrinter = printers.find((p) => p.name === template.page.printerName) || printers.find((p) => p.name === settings.defaultPrinter) || printers.find((p) => p.isDefault);
  const one = selected.length === 1 ? selected[0] : null;

  return <div className="app" style={{ '--bottom-h': bottomHeight + 'px' }}>
    <header className="titlebar">
      <div className="brand"><Tag size={16} /><b>Excel Label Studio</b><span className="doc-title" data-testid="doc-title">{template.name}{doc.dirty ? ' •' : ''}</span></div>
      <MenuBar menus={menus} />
    </header>
    <div className="toolbar" role="toolbar" aria-label="Main toolbar">
      <div className="toolbar-tools">
      <IconButton icon={FilePlus2} label="New label" shortcut="Ctrl+N" onClick={() => setDialog('new')} testId="tb-new" />
      <IconButton icon={FolderOpen} label="Open template" shortcut="Ctrl+O" onClick={() => setDialog('manager')} testId="tb-open" />
      <IconButton icon={Save} label="Save" shortcut="Ctrl+S" onClick={() => save()} testId="tb-save" />
      <span className="sep" />
      <IconButton icon={Undo2} label="Undo" shortcut="Ctrl+Z" onClick={doc.undo} disabled={!doc.canUndo} testId="tb-undo" />
      <IconButton icon={Redo2} label="Redo" shortcut="Ctrl+Y" onClick={doc.redo} disabled={!doc.canRedo} testId="tb-redo" />
      <span className="sep" />
      <IconButton icon={Scissors} label="Cut" onClick={doc.cut} disabled={!canEdit} />
      <IconButton icon={Copy} label="Copy" onClick={doc.copy} disabled={!canEdit} />
      <IconButton icon={ClipboardPaste} label="Paste" onClick={() => doc.paste()} disabled={!doc.hasClipboard()} />
      <IconButton icon={Trash2} label="Delete" onClick={doc.removeSelected} disabled={!canEdit} testId="tb-delete" />
      <span className="sep" />
      <IconButton icon={Database} label="Database connection" shortcut="Ctrl+Shift+D" onClick={openWizard} testId="tb-database" />
      <IconButton icon={RefreshCw} label="Reload data" onClick={reloadData} disabled={!connection?.token} />
      <span className="sep" />
      <IconButton icon={AlignStartVertical} label="Align left" onClick={() => ops.align('left')} disabled={!canEdit} />
      <IconButton icon={AlignCenterVertical} label="Align centre" onClick={() => ops.align('hcenter')} disabled={!canEdit} testId="tb-align-center" />
      <IconButton icon={AlignEndVertical} label="Align right" onClick={() => ops.align('right')} disabled={!canEdit} />
      <IconButton icon={AlignStartHorizontal} label="Align top" onClick={() => ops.align('top')} disabled={!canEdit} />
      <IconButton icon={AlignCenterHorizontal} label="Align middle" onClick={() => ops.align('vcenter')} disabled={!canEdit} />
      <IconButton icon={AlignEndHorizontal} label="Align bottom" onClick={() => ops.align('bottom')} disabled={!canEdit} />
      <IconButton icon={BringToFront} label="Bring to front" onClick={() => ops.order('front')} disabled={!canEdit} />
      <IconButton icon={SendToBack} label="Send to back" onClick={() => ops.order('back')} disabled={!canEdit} />
      <IconButton icon={Group} label="Group" shortcut="Ctrl+G" onClick={ops.group} disabled={selection.length < 2} />
      <IconButton icon={Ungroup} label="Ungroup" shortcut="Ctrl+Shift+G" onClick={ops.ungroup} disabled={!selected.some((o) => o.groupId)} />
      <span className="sep" />
      <IconButton icon={ZoomOut} label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, Math.round(z / 1.25 * 100) / 100))} />
      <button type="button" className="zoom-value" onClick={() => setZoom(1)} title="Actual size" data-testid="zoom-value">{Math.round(zoom * 100)}%</button>
      <IconButton icon={ZoomIn} label="Zoom in" onClick={() => setZoom((z) => Math.min(16, Math.round(z * 1.25 * 100) / 100))} />
      <IconButton icon={Maximize} label="Zoom to fit" shortcut="Ctrl+0" onClick={fitZoom} />
      <IconButton icon={Grid3x3} label="Grid" active={view.grid} onClick={() => setViewOption({ grid: !view.grid })} />
      <IconButton icon={Magnet} label="Snap" active={view.snapGrid || view.snapObjects} onClick={() => setViewOption({ snapGrid: !(view.snapGrid || view.snapObjects), snapObjects: !(view.snapGrid || view.snapObjects) })} />
      </div>
      <div className="toolbar-actions">
        <button type="button" className="btn btn-connect-printer" data-testid="tb-connect-printer" onClick={openPrinterSetup}
          title={settings.defaultPrinter ? 'Selected: ' + settings.defaultPrinter + ' — manage printer connection' : 'Find and connect a Windows printer'}>
          <Cable size={15} /> Connect printer
        </button>
        <IconButton icon={FileDown} label="Print / Save PDF" onClick={openPrint} />
        <button type="button" className="btn btn-primary print-btn" onClick={openPrint} data-testid="tb-print"><Printer size={15} /> Print</button>
      </div>
    </div>

    <main className="workspace">
      <LeftPanel headers={headers} record={previewRecord} fileName={connection?.fileName} onOpenData={openWizard} onAddField={(n) => addField(n)} usedFields={usedFields}
        onTool={(t) => addTool(t)} templates={templates} activeId={doc.storedId} onOpen={openTemplate} onNew={() => setDialog('new')} onManage={() => setDialog('manager')}
        onFavorite={async (id, fav) => { await desktop.templates.favorite(id, fav); refreshTemplates(); }} recent={settings.recent || []}
        objects={template.objects} selection={selection} onSelect={doc.select} onPatch={doc.patchObjects} onReorder={ops.order}
        forceTab={leftTab} onTabChange={() => setLeftTab(null)} />
      <section className="center">
        {missing.length > 0 && <div className="banner warn" data-testid="missing-banner">Columns not found in “{connection?.fileName}”: {missing.map((m) => m.field + (m.reason === 'ambiguous' ? ' (duplicate heading)' : '')).join(', ')}. <button type="button" onClick={openWizard}>Map columns…</button></div>}
        <Canvas template={template} selection={selection} onSelect={(idsToSelect) => doc.select(idsToSelect)} onChange={(fn, coalesce) => doc.update(fn, { coalesce })} onEndChange={doc.endCoalesce}
          zoom={zoom} onZoom={setZoom} showGrid={view.grid} gridSize={view.gridSize} snapGrid={view.snapGrid} snapObjects={view.snapObjects}
          headers={headers} record={previewRecord} prompts={prompts} dataLoaded={Boolean(table)} onCursor={setCursor}
          onDropField={({ field, tool, x, y }) => (field ? addField(field, { x, y }) : addTool(tool, { x, y }))} onEditText={editText} />
      </section>
      <aside className="right-panel"><div className="panel-title">Properties</div>
        <div className="panel-scroll">
          <PropertiesPanel template={template} selected={selected} fields={fieldChoices} headers={headers} record={previewRecord} prompts={prompts} printers={printers} fonts={fonts} dataLoaded={Boolean(table)} onEditText={editText}
            onPatch={(idList, patch) => doc.patchObjects(idList, patch)} onChange={(fn) => doc.update(fn)} onPickImage={pickImage} />
        </div>
      </aside>
    </main>
    <div className="splitter" role="separator" aria-orientation="horizontal" title="Drag to resize"
      onPointerDown={(e) => {
        const startY = e.clientY; const startH = bottomHeight;
        const move = (ev) => setBottomHeight(Math.max(90, Math.min(window.innerHeight - 300, startH - (ev.clientY - startY))));
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      }} />
    <section className="bottom">
      <DataPanel connection={connection} template={template} onChange={(fn) => doc.update(fn)} rows={rows} totalRows={processed.length} selection={rowSelection}
        onSelection={changeSelection} previewId={previewRecord?.id} onPreview={setPreviewId} query={query} onQuery={setQuery}
        onOpenData={openWizard} onReload={reloadData} onSheet={chooseSheet} onHeaderRow={chooseHeaderRow} onShowWarnings={() => setDialog('warnings')} />
    </section>
    <footer className="statusbar" data-testid="statusbar">
      <span>{template.page.width} × {template.page.height} mm</span>
      <span>{cursor ? 'X ' + cursor.x.toFixed(1) + '  Y ' + cursor.y.toFixed(1) + ' mm' : ' '}</span>
      <span>{one ? (one.name || one.type) + ': ' + one.x + ', ' + one.y + ' · ' + one.width + ' × ' + one.height + ' mm' : selection.length ? selection.length + ' selected' : template.objects.length + ' objects'}</span>
      <span>{table ? processed.length.toLocaleString() + ' rows · ' + rowSelection.size.toLocaleString() + ' selected' : 'No data'}</span>
      <span className="spacer" />
      {defaultPrinter && <span className={defaultPrinter.blocking ? 'bad' : defaultPrinter.problems?.length ? 'warn' : ''} title={defaultPrinter.problems?.join(', ')}>Printer: {defaultPrinter.displayName}{defaultPrinter.problems?.length ? ' — ' + defaultPrinter.problems.join(', ') : ''}</span>}
      <span>{doc.storedId ? (doc.dirty ? 'Unsaved changes' : 'Saved · rev ' + template.revision) : 'Not saved'}</span>
      <span>{info ? 'v' + info.version : ''}</span>
    </footer>

    <div className="notices">{notices.map((n) => <Notice key={n.id} kind={n.kind} onClose={() => setNotices((x) => x.filter((y) => y.id !== n.id))}>{n.text}</Notice>)}</div>

    {dialog === 'print' && <PrintDialog template={template} connection={connection} rows={processed} selection={rowSelection} previewId={previewRecord?.id} printers={printers}
      onRefreshPrinters={() => refreshPrinters(true)} onConnectPrinter={connectPrinter} onClose={() => setDialog(null)} onSerialState={saveSerialState} defaultPrinter={settings.defaultPrinter}
      onPrinted={() => { if (template.page.printerName === '' && doc.storedId) { /* keep */ } }} />}
    {dialog === 'printer' && <PrinterConnectionDialog printers={printers} defaultPrinter={settings.defaultPrinter || ''} onRefreshPrinters={() => refreshPrinters(true)} onConnectPrinter={connectPrinter} onClose={() => setDialog(null)} />}
    {editingText && <TextEditorDialog key={editingText.id} object={editingText} fields={fieldChoices} headers={headers}
      record={previewRecord} prompts={prompts} dateOrder={template.data.dateOrder} onClose={() => setEditingTextId(null)}
      onSave={(change) => { doc.patchObjects([editingText.id], change); setEditingTextId(null); }} />}
    {dialog === 'wizard' && <DatabaseWizard template={template} recentFiles={settings.recentDataFiles} onClose={() => setDialog(null)} onConnect={connectFromWizard}
      initial={connection ? { file: { name: connection.fileName, token: connection.token }, result: connection.result, sheetIndex: connection.sheetIndex } : null} />}
    {dialog === 'manager' && <TemplateManager templates={templates} activeId={doc.storedId} onClose={() => setDialog(null)} onOpen={openTemplate} onOpenVersion={openVersion} onChanged={refreshTemplates} notify={notify} />}
    {dialog === 'new' && <NewTemplateDialog onClose={() => setDialog(null)} onCreate={newFrom} />}
    {dialog === 'warnings' && <WarningsDialog warnings={table?.warnings || []} onClose={() => setDialog(null)} />}
    {dialog === 'history' && <JobHistoryDialog onClose={() => setDialog(null)} printers={printers} notify={notify} />}
    {dialog === 'automation' && <AutomationDialog onClose={() => setDialog(null)} templates={templates} printers={printers} notify={notify} />}
    {dialog === 'help' && <HelpDialog onClose={() => setDialog(null)} info={info} />}
    {recovery && <RecoveryDialog recovery={recovery}
      onRestore={async () => {
        const r = recovery; setRecovery(null);
        let current = null;
        if (r.storedId) { try { current = await desktop.templates.get(r.storedId); } catch { current = null; } }
        if (current) { doc.load(current, { stored: true }); doc.update(() => ({ ...r.template, id: current.id })); }
        else doc.load({ ...r.template, id: newId('tpl') }, { stored: false });
        notify('Recovered unsaved work. Save to keep it.', 'warn');
      }}
      onDiscard={() => { setRecovery(null); desktop.autosave.clear().catch(() => {}); }} />}
  </div>;
}
