import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Filter, RefreshCw, FolderOpen, AlertTriangle, ArrowUp, ArrowDown, X, CheckSquare, Square as SquareIcon, Plus, EyeOff, Info } from 'lucide-react';
import { Button, IconButton, SelectField } from './controls.jsx';
import { FILTER_OPERATORS } from '../engine/schema.js';
import { OPERATOR_LABELS } from './PropertiesPanel.jsx';
import { resolveColumn, headerKey } from '../engine/binding.js';
import { parseQuantity } from '../engine/jobs.js';

const ROW_H = 24;

function FilterBar({ template, headers, onChange }) {
  const filters = template.data.filters;
  const set = (list) => onChange((t) => ({ ...t, data: { ...t.data, filters: list } }));
  return <div className="filter-bar" data-testid="filter-bar">
    {filters.map((f, i) => <div key={i} className="filter-chip">
      <select value={f.field} onChange={(e) => set(filters.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
        {[...new Set([f.field, ...headers])].map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      <select value={f.op} onChange={(e) => set(filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
        {FILTER_OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>
      {!['isEmpty', 'isNotEmpty'].includes(f.op) && <input value={f.value} placeholder="value" onChange={(e) => set(filters.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />}
      <button type="button" aria-label="Remove filter" onClick={() => set(filters.filter((_, j) => j !== i))}><X size={12} /></button>
    </div>)}
    <Button icon={Plus} kind="ghost" onClick={() => set([...filters, { field: headers[0] || '', op: 'isNotEmpty', value: '' }])} disabled={!headers.length} testId="add-filter">Add filter</Button>
    {filters.length > 0 && <span className="hint">Filters are saved with the template and apply when printing.</span>}
  </div>;
}

export default function DataPanel({
  connection, template, onChange, rows, totalRows, selection, onSelection, previewId, onPreview, query, onQuery,
  onOpenData, onReload, onSheet, onHeaderRow, onShowWarnings
}) {
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(200);
  const [showFilters, setShowFilters] = useState(false);
  const table = connection?.table;
  const headers = table?.headers || [];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);

  const sort = template.data.sort[0];
  const qField = template.data.quantityMode === 'field' ? template.data.quantityField : '';
  const qIndex = qField ? resolveColumn(headers, qField) : -1;
  const toggleSort = (h) => {
    const current = template.data.sort.find((s) => headerKey(s.field) === headerKey(h));
    const next = !current ? [{ field: h, dir: 'asc' }] : current.dir === 'asc' ? [{ field: h, dir: 'desc' }] : [];
    onChange((t) => ({ ...t, data: { ...t.data, sort: next } }));
  };
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selection.has(r.id));
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const end = Math.min(rows.length, start + Math.ceil(height / ROW_H) + 20);
  const visible = rows.slice(start, end);
  const warnings = table?.warnings || [];
  const errorCount = warnings.filter((w) => w.level !== 'info').length;
  const sheetOptions = useMemo(() => (connection?.sheets || []).map((s, i) => ({ value: String(i), label: s.name + (s.hiddenSheet ? ' (hidden)' : '') + ' · ' + (s.table?.records.length || 0) + ' rows' })), [connection]);

  if (!table) {
    return <div className="data-panel empty" data-testid="data-panel">
      <div className="empty-data">
        <p><b>No Excel data loaded.</b> Designs still work: column objects show their [Column name] until you connect a file.</p>
        <Button kind="primary" icon={FolderOpen} onClick={onOpenData} testId="open-data">Open Excel / CSV…</Button>
      </div>
    </div>;
  }

  return <div className="data-panel" data-testid="data-panel">
    <div className="data-toolbar">
      <span className="data-source" title={connection.fileName}><b>{connection.fileName}</b></span>
      {connection.sheets.length > 1 && <SelectField value={String(connection.sheetIndex)} onChange={(v) => onSheet(Number(v))} options={sheetOptions} testId="sheet-select" />}
      <label className="field inline"><span className="field-label">Header row</span>
        <select value={table.headerRow} onChange={(e) => onHeaderRow(Number(e.target.value))} data-testid="header-row">
          {(connection.sheets[connection.sheetIndex].meta?.sourceRowNumbers || connection.sheets[connection.sheetIndex].grid.map((_, i) => i + 1)).slice(0, 50).map((n, i) => {
            const row = connection.sheets[connection.sheetIndex].grid[i] || [];
            const preview = row.map((c) => (typeof c === 'object' ? c?.text : c)).filter(Boolean).slice(0, 3).join(' | ').slice(0, 50);
            return <option key={n} value={n}>Row {n}{preview ? ' — ' + preview : ''}</option>;
          })}
        </select>
      </label>
      <IconButton icon={RefreshCw} label="Reload file from disk" onClick={onReload} disabled={!connection.token} testId="reload-data" />
      <IconButton icon={FolderOpen} label="Open another file" onClick={onOpenData} />
      <span className="sep" />
      <div className="search"><Search size={14} /><input placeholder="Search rows" value={query} onChange={(e) => onQuery(e.target.value)} data-testid="row-search" /></div>
      <IconButton icon={Filter} label="Filters" active={showFilters || template.data.filters.length > 0} onClick={() => setShowFilters(!showFilters)} testId="toggle-filters" />
      <label className="field inline"><span className="field-label">Quantity from</span>
        <select value={qField} onChange={(e) => onChange((t) => ({ ...t, data: { ...t.data, quantityField: e.target.value, quantityMode: e.target.value ? 'field' : 'fixed' } }))} data-testid="quantity-column">
          <option value="">— fixed copies —</option>
          {[...new Set([...(qField && qIndex < 0 ? [qField] : []), ...headers])].map((h) => <option key={h} value={h}>{h}{qIndex < 0 && h === qField ? ' (missing)' : ''}</option>)}
        </select>
      </label>
      {warnings.length > 0 && <button type="button" className={'warn-pill' + (errorCount ? ' warn' : '')} onClick={onShowWarnings} data-testid="data-warnings">{errorCount ? <AlertTriangle size={13} /> : <Info size={13} />} {warnings.length} note{warnings.length > 1 ? 's' : ''}</button>}
      <span className="count" data-testid="row-count">{selection.size.toLocaleString()} of {totalRows.toLocaleString()} selected{rows.length !== totalRows ? ' · ' + rows.length.toLocaleString() + ' shown' : ''}</span>
    </div>
    {showFilters && <FilterBar template={template} headers={headers} onChange={onChange} />}
    <div className="grid-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <table className="grid" style={{ width: 'max-content', minWidth: '100%' }}>
        <thead><tr>
          <th className="sel"><button type="button" className="mini" onClick={() => onSelection(allVisibleSelected ? 'none-visible' : 'all-visible')} aria-label={allVisibleSelected ? 'Deselect shown rows' : 'Select shown rows'} data-testid="select-all">{allVisibleSelected ? <CheckSquare size={14} /> : <SquareIcon size={14} />}</button></th>
          <th className="rownum">Row</th>
          {headers.map((h, i) => {
            const s = template.data.sort.find((x) => headerKey(x.field) === headerKey(h));
            return <th key={i} className={i === qIndex ? 'qty-col' : ''}><button type="button" className="th-btn" onClick={() => toggleSort(h)} title="Sort (saved with template, used for print order)">{h}{s && (s.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>;
          })}
        </tr></thead>
        <tbody>
          {start > 0 && <tr style={{ height: start * ROW_H }}><td colSpan={headers.length + 2} /></tr>}
          {visible.map((r) => {
            const q = qIndex >= 0 ? parseQuantity(r.cells[qIndex]) : null;
            return <tr key={r.id} className={(selection.has(r.id) ? 'selected ' : '') + (r.id === previewId ? 'preview ' : '') + (r.hidden ? 'hidden-row' : '')} onClick={() => onPreview(r.id)} data-testid={'row-' + r.id}>
              <td className="sel" onClick={(e) => { e.stopPropagation(); onSelection('toggle', r.id); }}><input type="checkbox" checked={selection.has(r.id)} readOnly aria-label={'Select row ' + r.rowNumber} /></td>
              <td className="rownum">{r.rowNumber}{r.hidden && <EyeOff size={11} />}</td>
              {headers.map((h, i) => <td key={i} dir="auto" className={(i === qIndex ? 'qty-col' : '') + (i === qIndex && q?.problem ? ' bad' : '')} title={i === qIndex && q?.problem ? q.problem : r.cells[i]}>{r.cells[i]}</td>)}
            </tr>;
          })}
          {end < rows.length && <tr style={{ height: (rows.length - end) * ROW_H }}><td colSpan={headers.length + 2} /></tr>}
        </tbody>
      </table>
      {!rows.length && <div className="empty-row">No rows match the search/filters.</div>}
    </div>
    {sort && <div className="sort-note">Sorted by {sort.field} ({sort.dir === 'asc' ? 'A→Z' : 'Z→A'}) — labels print in this order.</div>}
  </div>;
}
