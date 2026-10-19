import React, { useMemo, useState } from 'react';
import { FolderOpen, FileSpreadsheet, ArrowLeft, ArrowRight, Check as CheckIcon, AlertTriangle, Info } from 'lucide-react';
import { Modal, Button, SelectField } from '../controls.jsx';
import { readSpreadsheet, withHeaderRow } from '../../data/importers.js';
import { missingFields } from '../../engine/binding.js';
import { desktop } from '../../platform/api.js';

const STEPS = ['File', 'Worksheet', 'Header row', 'Preview', 'Map fields'];

export default function DatabaseWizard({ template, recentFiles, initial, onClose, onConnect }) {
  const [step, setStep] = useState(initial?.result ? 1 : 0);
  const [file, setFile] = useState(initial?.file || null);
  const [result, setResult] = useState(initial?.result || null);
  const [sheetIndex, setSheetIndex] = useState(initial?.sheetIndex ?? 0);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renames, setRenames] = useState({});

  async function load(picker) {
    setError(''); setBusy(true);
    try {
      const f = await picker();
      if (!f || f.canceled) return;
      const r = await readSpreadsheet({ name: f.name, size: f.size ?? f.bytes.length, bytes: f.bytes });
      setFile({ name: f.name, token: f.token || '', modifiedAt: f.modifiedAt, folder: f.folder });
      setResult(r);
      const wanted = template.data.sheetName ? r.sheets.findIndex((s) => s.name === template.data.sheetName) : -1;
      setSheetIndex(wanted >= 0 ? wanted : Math.max(0, r.sheets.findIndex((s) => s.table?.records.length)));
      setSheet(null);
      setStep(1);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const baseSheet = result?.sheets[sheetIndex];
  const current = sheet && sheet.name === baseSheet?.name ? sheet : baseSheet;
  const table = current?.table;
  const missing = useMemo(() => (table ? missingFields(template, table.headers) : []), [template, table]);
  const unresolved = missing.filter((m) => !renames[m.field]);

  function chooseHeader(rowNumber) {
    try { setSheet(withHeaderRow(baseSheet, rowNumber)); setError(''); }
    catch (e) { setError(e.message); }
  }

  const footer = <>
    {step > 0 && <Button icon={ArrowLeft} onClick={() => setStep(step - 1)} disabled={busy}>Back</Button>}
    <span className="spacer" />
    <Button onClick={onClose}>Cancel</Button>
    {step < STEPS.length - 1 && step > 0 && <Button kind="primary" icon={ArrowRight} onClick={() => setStep(step + 1)} disabled={!table || !table.records.length} testId="wizard-next">Next</Button>}
    {step === STEPS.length - 1 && <Button kind="primary" icon={CheckIcon} disabled={!table} testId="wizard-finish"
      onClick={() => onConnect({ file, result, sheetIndex, sheet: current, renames })}>{unresolved.length ? 'Finish (some fields unmapped)' : 'Connect'}</Button>}
  </>;

  return <Modal title="Database connection" onClose={onClose} width={860} footer={footer} testId="database-wizard" className="wizard">
    <ol className="wizard-steps">{STEPS.map((s, i) => <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>{i + 1}. {s}</li>)}</ol>
    {error && <div className="issues bad"><AlertTriangle size={13} /> {error}</div>}
    {step === 0 && <div className="wizard-body">
      <p>Choose an Excel workbook (.xlsx, .xlsm, .xls) or a text file (.csv, .tsv). The file stays on this computer. Formulas are not recalculated — Excel's saved results are used — and macros never run.</p>
      <Button kind="primary" icon={FolderOpen} onClick={() => load(() => desktop.data.openDialog())} disabled={busy} testId="wizard-browse">{busy ? 'Reading…' : 'Browse for a file…'}</Button>
      {recentFiles?.length > 0 && <>
        <h3>Recent data files</h3>
        <ul className="recent-files">{recentFiles.map((f) => <li key={f.token}><button type="button" onClick={() => load(() => desktop.data.reload(f.token))}><FileSpreadsheet size={14} /> {f.name} <span className="hint">{f.folder}</span></button></li>)}</ul>
      </>}
    </div>}
    {step === 1 && result && <div className="wizard-body">
      <p><b>{file?.name}</b> · {result.format.toUpperCase()}{result.encoding ? ' · ' + result.encoding : ''}</p>
      <ul className="sheet-list">{result.sheets.map((s, i) => <li key={s.name + i}>
        <label className="radio"><input type="radio" checked={i === sheetIndex} onChange={() => { setSheetIndex(i); setSheet(null); }} disabled={!s.table?.records.length} />
          <b>{s.name}</b> — {s.table ? s.table.records.length.toLocaleString() + ' rows × ' + s.table.headers.length + ' columns' : 'empty'}{s.hiddenSheet ? ' (hidden sheet)' : ''}</label>
      </li>)}</ul>
    </div>}
    {step === 2 && current && <div className="wizard-body">
      <p>Which row contains the column headings? Rows above it (titles, notes) are ignored.</p>
      <div className="raw-grid">
        <table><tbody>{current.grid.slice(0, 15).map((row, i) => {
          const rowNumber = current.meta?.sourceRowNumbers?.[i] ?? i + 1;
          return <tr key={i} className={rowNumber === table?.headerRow ? 'header' : ''} onClick={() => chooseHeader(rowNumber)}>
            <th>{rowNumber}</th>{row.slice(0, 12).map((c, j) => <td key={j} dir="auto">{typeof c === 'object' ? c?.text : c}</td>)}
          </tr>;
        })}</tbody></table>
      </div>
      <p className="hint">Click a row to use it as the header. Current header: row {table?.headerRow}.</p>
    </div>}
    {step === 3 && table && <div className="wizard-body">
      <p>{table.records.length.toLocaleString()} data rows · {table.headers.length} columns.</p>
      {table.warnings.length > 0 && <div className="issues">{table.warnings.map((w) => <div key={w.code} className={w.level}>{w.level === 'info' ? <Info size={13} /> : <AlertTriangle size={13} />} {w.message}</div>)}</div>}
      <div className="raw-grid"><table>
        <thead><tr><th>Row</th>{table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{table.records.slice(0, 20).map((r) => <tr key={r.id}><th>{r.rowNumber}</th>{r.cells.map((c, i) => <td key={i} dir="auto">{c}</td>)}</tr>)}</tbody>
      </table></div>
    </div>}
    {step === 4 && table && <div className="wizard-body">
      {!missing.length ? <p className="ok-text"><CheckIcon size={14} /> Every column used by “{template.name}” exists in this sheet. Columns are matched by name, so their order does not matter.</p> : <>
        <p>These columns used by the template are not in this sheet. Choose the matching column, or leave them unmapped (printing stays blocked until they are fixed):</p>
        <table className="map-table"><tbody>{missing.map((m) => <tr key={m.field}>
          <td><b>{m.field}</b>{m.reason === 'ambiguous' && <span className="hint"> (appears twice)</span>}<div className="hint">used by {m.objects.join(', ')}</div></td>
          <td>→</td>
          <td><SelectField value={renames[m.field] || ''} onChange={(v) => setRenames((r) => ({ ...r, [m.field]: v }))} options={[{ value: '', label: '— not mapped —' }, ...table.headers.map((h) => ({ value: h, label: h }))]} testId={'map-' + m.field} /></td>
        </tr>)}</tbody></table>
        <p className="hint">Mapping updates the template's column names; save the template to keep the change.</p>
      </>}
    </div>}
  </Modal>;
}
