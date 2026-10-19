import React, { useMemo, useState } from 'react';
import { Type, Columns3, Combine, CalendarClock, Hash, Minus, Square, Circle, Image as ImageIcon, Barcode, QrCode, Table2, Search, Star, Eye, EyeOff, Lock, Unlock, ChevronUp, ChevronDown, FilePlus2, FolderOpen, Layers as LayersIcon, Shapes, Database, LayoutTemplate } from 'lucide-react';
import { Tabs, IconButton, Button } from './controls.jsx';

export const TOOLS = [
  { id: 'text', label: 'Text', icon: Type, hint: 'Fixed text' },
  { id: 'field', label: 'Excel field', icon: Columns3, hint: 'Text from an Excel column' },
  { id: 'template', label: 'Combined', icon: Combine, hint: 'Several columns in one text, e.g. {Name} – {Price}' },
  { id: 'date', label: 'Date', icon: CalendarClock, hint: 'Print date/time' },
  { id: 'serial', label: 'Serial', icon: Hash, hint: 'Automatic serial number' },
  { id: 'line', label: 'Line', icon: Minus },
  { id: 'rect', label: 'Rectangle', icon: Square },
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'image', label: 'Image', icon: ImageIcon, hint: 'Logo or picture (PNG/JPEG)' },
  { id: 'table', label: 'Table', icon: Table2 },
  { id: 'barcode', label: 'Barcode', icon: Barcode, hint: 'Optional 1D barcode' },
  { id: 'qrcode', label: 'QR code', icon: QrCode, hint: 'Optional 2D code' }
];

const ICONS = { text: Type, line: Minus, rect: Square, ellipse: Circle, image: ImageIcon, barcode: Barcode, table: Table2 };

function Toolbox({ onTool }) {
  return <div className="toolbox" data-testid="toolbox">
    {TOOLS.map((t) => <button key={t.id} type="button" className="tool" title={t.hint || t.label} draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/x-els-tool', t.id); e.dataTransfer.effectAllowed = 'copy'; }}
      onClick={() => onTool(t.id)} data-testid={'tool-' + t.id}>
      <t.icon size={18} /><span>{t.label}</span>
    </button>)}
    <p className="hint">Click to add, or drag onto the label. Text-only labels need no barcode.</p>
  </div>;
}

function DataFields({ headers, record, onAddField, onOpenData, fileName, usedFields }) {
  const [query, setQuery] = useState('');
  const list = headers.map((h, i) => ({ name: h, sample: record?.cells?.[i] ?? '' })).filter((f) => f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="data-fields" data-testid="data-fields">
    {!headers.length ? <div className="empty">
      <Database size={28} /><p>No data source connected.</p>
      <Button kind="primary" icon={FolderOpen} onClick={onOpenData} testId="open-data-left">Open Excel / CSV…</Button>
    </div> : <>
      <div className="source-name" title={fileName}><Database size={14} /> {fileName}</div>
      <div className="search"><Search size={14} /><input placeholder="Find column" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <ul className="field-list">
        {list.map((f) => <li key={f.name} draggable onDragStart={(e) => { e.dataTransfer.setData('application/x-els-field', f.name); e.dataTransfer.effectAllowed = 'copy'; }}
          onDoubleClick={() => onAddField(f.name)} title="Drag onto the label, or double-click to add" data-testid={'field-' + f.name}>
          <Columns3 size={14} /><span className="name">{f.name}{usedFields.has(f.name.toLocaleLowerCase()) && <em className="used">on label</em>}</span>
          <span className="sample" dir="auto">{f.sample}</span>
          <button type="button" className="mini" onClick={() => onAddField(f.name)} aria-label={'Add ' + f.name}>+</button>
        </li>)}
      </ul>
    </>}
  </div>;
}

function TemplatesTab({ templates, activeId, onOpen, onNew, onManage, onFavorite, recent }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const categories = useMemo(() => [...new Set(templates.map((t) => t.category || 'General'))].sort(), [templates]);
  const filtered = templates.filter((t) => (category === 'all' || (category === 'favorites' ? t.favorite : category === 'recent' ? recent.includes(t.id) : t.category === category))
    && (t.name + ' ' + (t.description || '') + ' ' + (t.tags || []).join(' ')).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="templates-tab" data-testid="templates-tab">
    <div className="button-row"><Button icon={FilePlus2} onClick={onNew}>New…</Button><Button icon={FolderOpen} onClick={onManage}>Manage…</Button></div>
    <div className="search"><Search size={14} /><input placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="template-search" /></div>
    <select value={category} onChange={(e) => setCategory(e.target.value)} className="category-select">
      <option value="all">All templates ({templates.length})</option>
      <option value="favorites">★ Favorites</option>
      <option value="recent">Recent</option>
      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
    <ul className="template-list">
      {filtered.map((t) => <li key={t.id} className={t.id === activeId ? 'active' : ''}>
        <button type="button" className="template-item" onClick={() => onOpen(t.id)} title={t.description || t.name} data-testid={'template-' + t.name}>
          <span className="t-name">{t.name}</span><span className="t-meta">{t.width}×{t.height} mm · {t.category}</span>
        </button>
        <IconButton icon={Star} label={t.favorite ? 'Remove from favorites' : 'Add to favorites'} active={t.favorite} onClick={() => onFavorite(t.id, !t.favorite)} size={14} className="star" />
      </li>)}
      {!filtered.length && <li className="empty-row">{templates.length ? 'No templates match.' : 'No saved templates yet. Save the current label (Ctrl+S).'}</li>}
    </ul>
  </div>;
}

function Layers({ objects, selection, onSelect, onPatch, onReorder }) {
  const ordered = [...objects].reverse();
  return <div className="layers" data-testid="layers">
    {!objects.length && <p className="hint">The label is empty. Add objects from the Toolbox.</p>}
    <ul>
      {ordered.map((o) => {
        const Icon = ICONS[o.type] || Shapes;
        return <li key={o.id} className={selection.includes(o.id) ? 'selected' : ''}>
          <button type="button" className="layer-name" onClick={(e) => onSelect([o.id], e.shiftKey || e.ctrlKey ? 'toggle' : 'replace')}>
            <Icon size={14} /><span>{o.name || o.type}</span>{o.groupId && <em className="tag">group</em>}{!o.printable && <em className="tag">no print</em>}{o.visibleIf && <em className="tag">if</em>}
          </button>
          <IconButton icon={o.hidden ? EyeOff : Eye} label={o.hidden ? 'Show' : 'Hide'} onClick={() => onPatch([o.id], { hidden: !o.hidden })} size={13} />
          <IconButton icon={o.locked ? Lock : Unlock} label={o.locked ? 'Unlock' : 'Lock'} onClick={() => onPatch([o.id], { locked: !o.locked })} size={13} />
        </li>;
      })}
    </ul>
    {selection.length > 0 && <div className="button-row">
      <Button icon={ChevronUp} onClick={() => onReorder('forward')}>Forward</Button>
      <Button icon={ChevronDown} onClick={() => onReorder('backward')}>Backward</Button>
    </div>}
  </div>;
}

export default function LeftPanel(props) {
  const [tab, setTab] = useState('toolbox');
  const active = props.forceTab || tab;
  return <aside className="left-panel">
    <Tabs active={active} onChange={(id) => { setTab(id); props.onTabChange?.(id); }} tabs={[
      { id: 'toolbox', label: 'Toolbox', icon: Shapes }, { id: 'data', label: 'Data', icon: Database, badge: props.headers.length || null },
      { id: 'templates', label: 'Templates', icon: LayoutTemplate }, { id: 'layers', label: 'Layers', icon: LayersIcon }]} />
    <div className="panel-scroll">
      {active === 'toolbox' && <Toolbox onTool={props.onTool} />}
      {active === 'data' && <DataFields {...props} />}
      {active === 'templates' && <TemplatesTab {...props} />}
      {active === 'layers' && <Layers objects={props.objects} selection={props.selection} onSelect={props.onSelect} onPatch={props.onPatch} onReorder={props.onReorder} />}
    </div>
  </aside>;
}
