import React, { useEffect, useMemo, useState } from 'react';
import { Search, Star, Copy, Pencil, Trash2, Upload, Download, History, RotateCcw, FolderOpen } from 'lucide-react';
import { Modal, Button, Tabs, IconButton, useDialog } from '../controls.jsx';
import { buildLabel, renderLabelHtml, LABEL_CSS } from '../../engine/render.js';
import { desktop } from '../../platform/api.js';

function Thumb({ template, max = 300 }) {
  if (!template) return null;
  const html = renderLabelHtml(template, buildLabel(template, { placeholders: true }), { mode: 'design' });
  const zoom = Math.min(2, max / (template.page.width * 3.7795), 220 / (template.page.height * 3.7795));
  return <div className="thumb-paper" style={{ width: template.page.width * 3.7795 * zoom, height: template.page.height * 3.7795 * zoom }}>
    <style>{LABEL_CSS}</style>
    <div style={{ transform: 'scale(' + zoom + ')', transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}

export default function TemplateManager({ templates, activeId, onClose, onOpen, onOpenVersion, onChanged, notify }) {
  const ask = useDialog();
  const [tab, setTab] = useState('templates');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(activeId && templates.some((t) => t.id === activeId) ? activeId : templates[0]?.id);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [trash, setTrash] = useState([]);
  const [error, setError] = useState('');

  const filtered = useMemo(() => templates.filter((t) => (t.name + ' ' + t.category + ' ' + (t.tags || []).join(' ') + ' ' + (t.description || '')).toLocaleLowerCase().includes(query.toLocaleLowerCase())), [templates, query]);

  useEffect(() => {
    let cancelled = false;
    setSelected(null); setHistory([]);
    if (!selectedId) return undefined;
    desktop.templates.get(selectedId).then((t) => { if (!cancelled) setSelected(t); }).catch((e) => setError(e.message));
    desktop.templates.history(selectedId).then((h) => { if (!cancelled) setHistory(h); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId, templates]);

  useEffect(() => { if (tab === 'trash') desktop.templates.trash().then(setTrash).catch((e) => setError(e.message)); }, [tab, templates]);

  const guard = async (fn) => { setError(''); try { await fn(); } catch (e) { setError(e.message); } };

  const actions = {
    duplicate: () => guard(async () => { const t = await desktop.templates.duplicate(selectedId); await onChanged(); setSelectedId(t.id); notify('Created "' + t.name + '".'); }),
    rename: () => guard(async () => {
      const value = await ask({ title: 'Rename template', message: 'New name:', input: { defaultValue: selected.name }, confirmLabel: 'Rename' });
      if (!value || value === selected.name) return;
      await desktop.templates.rename(selectedId, value, selected.revision);
      await onChanged();
    }),
    remove: () => guard(async () => {
      const ok = await ask({ title: 'Delete template', message: 'Move "' + selected.name + '" to the trash? You can restore it from the Trash tab.', confirmLabel: 'Move to trash', danger: true });
      if (!ok) return;
      await desktop.templates.remove(selectedId);
      await onChanged();
      setSelectedId(templates.find((t) => t.id !== selectedId)?.id);
      notify('"' + selected.name + '" moved to the trash.');
    }),
    exportOne: () => guard(async () => { const r = await desktop.templates.exportDialog([selectedId], selected.name); if (r?.path) notify('Exported to ' + r.path); }),
    exportAll: () => guard(async () => { const r = await desktop.templates.exportDialog(templates.map((t) => t.id), 'label-templates'); if (r?.path) notify('Exported ' + templates.length + ' templates to ' + r.path); }),
    importFiles: () => guard(async () => {
      const r = await desktop.templates.importDialog();
      if (r?.canceled) return;
      await onChanged();
      notify('Imported ' + r.imported.length + ' template(s).' + (r.failed.length ? ' ' + r.failed.length + ' failed: ' + r.failed.map((f) => (f.file || f.name) + ' – ' + f.error).join('; ') : ''), r.failed.length ? 'warn' : 'ok');
      if (r.imported[0]) setSelectedId(r.imported[0].id);
    }),
    favorite: (id, fav) => guard(async () => { await desktop.templates.favorite(id, fav); await onChanged(); })
  };

  return <Modal title="Templates" onClose={onClose} width={1000} testId="template-manager" className="manager"
    footer={<>
      <Button icon={Upload} onClick={actions.importFiles} testId="import-templates">Import…</Button>
      <Button icon={Download} onClick={actions.exportAll} disabled={!templates.length}>Export all…</Button>
      <span className="spacer" />
      <Button onClick={onClose}>Close</Button>
      {tab === 'templates' && <Button kind="primary" icon={FolderOpen} disabled={!selected} onClick={() => onOpen(selectedId)} testId="open-template">Open</Button>}
    </>}>
    <Tabs active={tab} onChange={setTab} tabs={[{ id: 'templates', label: 'Saved templates (' + templates.length + ')' }, { id: 'trash', label: 'Trash' }]} />
    {error && <div className="issues bad">{error}</div>}
    {tab === 'templates' && <div className="manager-grid">
      <div className="manager-list">
        <div className="search"><Search size={14} /><input placeholder="Search name, category, tag" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus /></div>
        <ul>{filtered.map((t) => <li key={t.id} className={t.id === selectedId ? 'active' : ''}>
          <button type="button" onClick={() => setSelectedId(t.id)} onDoubleClick={() => onOpen(t.id)} data-testid={'manager-' + t.name}>
            <span className="t-name">{t.name}{t.damaged && ' (damaged)'}</span><span className="t-meta">{t.category} · {t.width}×{t.height} mm · rev {t.revision} · {new Date(t.updatedAt).toLocaleString()}</span>
          </button>
          <IconButton icon={Star} label="Favorite" active={t.favorite} onClick={() => actions.favorite(t.id, !t.favorite)} size={14} />
        </li>)}
          {!filtered.length && <li className="empty-row">No templates.</li>}
        </ul>
      </div>
      <div className="manager-detail">
        {selected ? <>
          <h3>{selected.name}</h3>
          <p className="hint">{selected.description || 'No description.'}</p>
          <Thumb template={selected} />
          <div className="button-row">
            <Button icon={Copy} onClick={actions.duplicate}>Duplicate</Button>
            <Button icon={Pencil} onClick={actions.rename}>Rename</Button>
            <Button icon={Download} onClick={actions.exportOne}>Export…</Button>
            <Button icon={Trash2} kind="danger" onClick={actions.remove} testId="delete-template">Delete</Button>
          </div>
          <h4><History size={14} /> Version history ({history.length})</h4>
          <ul className="versions">{history.map((v) => <li key={v.version}>
            <span>Revision {v.revision} · {new Date(v.updatedAt).toLocaleString()} · {v.objectCount} objects</span>
            <Button kind="ghost" icon={RotateCcw} onClick={() => guard(async () => onOpenVersion(selectedId, v.version))}>Open this version</Button>
          </li>)}
            {!history.length && <li className="hint">Older versions appear here after you save changes.</li>}
          </ul>
        </> : <p className="hint">Select a template.</p>}
      </div>
    </div>}
    {tab === 'trash' && <ul className="trash-list">
      {trash.map((t) => <li key={t.entry}>
        <span><b>{t.name}</b> · deleted {t.deletedAt ? new Date(t.deletedAt).toLocaleString() : ''}</span>
        <Button icon={RotateCcw} onClick={() => guard(async () => { await desktop.templates.restore(t.entry); await onChanged(); setTrash(await desktop.templates.trash()); notify('Restored "' + t.name + '".'); })}>Restore</Button>
        <Button kind="danger" icon={Trash2} onClick={() => guard(async () => {
          const ok = await ask({ title: 'Delete permanently', message: 'Permanently delete "' + t.name + '"? This cannot be undone.', confirmLabel: 'Delete permanently', danger: true });
          if (ok) { await desktop.templates.purge(t.entry); setTrash(await desktop.templates.trash()); }
        })}>Delete permanently</Button>
      </li>)}
      {!trash.length && <li className="hint">The trash is empty.</li>}
    </ul>}
  </Modal>;
}
