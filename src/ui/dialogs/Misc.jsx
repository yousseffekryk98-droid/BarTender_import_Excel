import React, { useEffect, useState } from 'react';
import { FilePlus2, RotateCcw, Printer, Trash2, AlertTriangle, Info } from 'lucide-react';
import { Modal, Button, NumberField, TextField, useDialog } from '../controls.jsx';
import { STARTER_LIST, templateFromStarter, STARTER_SAMPLE } from '../../engine/starters.js';
import { createTemplate } from '../../engine/schema.js';
import { buildLabel, renderLabelHtml, LABEL_CSS } from '../../engine/render.js';
import { FUNCTION_NAMES } from '../../engine/expression.js';
import { desktop } from '../../platform/api.js';

function StarterThumb({ starterKey }) {
  const t = templateFromStarter(starterKey);
  const [head, row] = STARTER_SAMPLE[starterKey] || [[], []];
  const html = renderLabelHtml(t, buildLabel(t, { headers: head, record: { cells: row || [] }, placeholders: !row }), { mode: 'design' });
  const zoom = Math.min(1.2, 150 / (t.page.width * 3.7795), 110 / (t.page.height * 3.7795));
  return <div className="thumb-paper" style={{ width: t.page.width * 3.7795 * zoom, height: t.page.height * 3.7795 * zoom }}>
    <div style={{ transform: 'scale(' + zoom + ')', transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}

export function NewTemplateDialog({ onClose, onCreate }) {
  const [width, setWidth] = useState(50);
  const [height, setHeight] = useState(30);
  const [name, setName] = useState('New label');
  return <Modal title="New label" onClose={onClose} width={940} testId="new-template" className="new-template"
    footer={<><span className="spacer" /><Button onClick={onClose}>Cancel</Button></>}>
    <style>{LABEL_CSS}</style>
    <div className="blank-row">
      <TextField label="Name" value={name} onChange={setName} live testId="new-name" />
      <NumberField label="Width" unit="mm" value={width} min={5} max={500} step={1} onChange={setWidth} testId="new-width" />
      <NumberField label="Height" unit="mm" value={height} min={5} max={1000} step={1} onChange={setHeight} testId="new-height" />
      <Button kind="primary" icon={FilePlus2} onClick={() => onCreate(createTemplate({ name: name || 'New label', page: { width, height } }))} testId="create-blank">Create blank label</Button>
    </div>
    <h3>Or start from a template</h3>
    <div className="starter-grid">
      {STARTER_LIST.map((s) => <button key={s.key} type="button" className="starter" onClick={() => onCreate(templateFromStarter(s.key))} data-testid={'starter-' + s.key} title={s.description}>
        <StarterThumb starterKey={s.key} />
        <b>{s.name}</b><span>{s.width} × {s.height} mm · {s.category}</span>
      </button>)}
    </div>
  </Modal>;
}

export function WarningsDialog({ warnings, onClose, title = 'Data notes' }) {
  return <Modal title={title} onClose={onClose} width={640} footer={<Button kind="primary" onClick={onClose}>OK</Button>}>
    <div className="issues">{warnings.map((w, i) => <div key={i} className={w.level}>{w.level === 'info' ? <Info size={13} /> : <AlertTriangle size={13} />} {w.message}</div>)}</div>
  </Modal>;
}

export function JobHistoryDialog({ onClose, printers, notify }) {
  const ask = useDialog();
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState('');
  const [printerName, setPrinterName] = useState('');
  const refresh = () => desktop.print.history().then(setJobs).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);
  return <Modal title="Print history" onClose={onClose} width={900} testId="job-history"
    footer={<>
      <Button icon={Trash2} kind="danger" onClick={async () => { if (await ask({ title: 'Clear history', message: 'Delete the print history and stored reprint data?', confirmLabel: 'Clear', danger: true })) { await desktop.print.clearHistory(); refresh(); } }}>Clear history</Button>
      <span className="spacer" /><Button kind="primary" onClick={onClose}>Close</Button>
    </>}>
    {error && <div className="issues bad">{error}</div>}
    <label className="field inline"><span className="field-label">Reprint on</span>
      <select value={printerName} onChange={(e) => setPrinterName(e.target.value)}><option value="">Same printer as the original job</option>{printers.map((p) => <option key={p.name} value={p.name}>{p.displayName}</option>)}</select>
    </label>
    <table className="jobs"><thead><tr><th>When</th><th>Template</th><th>Labels</th><th>Printer</th><th>Source</th><th>Status</th><th /></tr></thead>
      <tbody>{jobs.map((j) => <tr key={j.id}>
        <td>{new Date(j.createdAt).toLocaleString()}</td><td>{j.templateName}{j.templateRevision ? ' (rev ' + j.templateRevision + ')' : ''}<div className="hint">{j.dataFile}</div></td>
        <td>{j.labels}</td><td>{j.printerName}</td><td>{j.source}{j.reprintOf ? ' of ' + j.reprintOf.slice(0, 8) : ''}</td>
        <td className={'status-' + j.status}>{j.status}{j.errors?.length ? <div className="hint">{j.errors[0]}</div> : null}{j.warnings?.length ? <div className="hint">{j.warnings[0]}</div> : null}</td>
        <td>{j.reprintable && <Button icon={Printer} onClick={async () => {
          if (!(await ask({ title: 'Reprint', message: 'Reprint ' + j.labels + ' label(s) of "' + j.templateName + '" exactly as printed on ' + new Date(j.createdAt).toLocaleString() + '?', confirmLabel: 'Reprint' }))) return;
          try { const r = await desktop.print.reprint(j.id, printerName ? { printerName } : {}); const failed = r.results.find((x) => !x.ok); notify(failed ? failed.message : 'Reprint sent to the spooler.', failed ? 'error' : 'ok'); refresh(); }
          catch (e) { notify(e.message, 'error'); }
        }}>Reprint</Button>}</td>
      </tr>)}
        {!jobs.length && <tr><td colSpan={7} className="hint">No print jobs yet.</td></tr>}
      </tbody></table>
    <p className="hint">"spooled" means Windows accepted the job. Check the printer for the physical result. History is kept for 30 days on this computer only.</p>
  </Modal>;
}

const SHORTCUTS = [
  ['Ctrl+N', 'New label'], ['Ctrl+O', 'Open template'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+P', 'Print'], ['Ctrl+Shift+D', 'Database connection'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['Ctrl+C / X / V', 'Copy / Cut / Paste'], ['Ctrl+D', 'Duplicate'], ['Ctrl+A', 'Select all'], ['Delete', 'Delete selection'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group / Ungroup'], ['Arrows', 'Move 0.5 mm (Shift: 5 mm, Alt: 0.1 mm)'], ['Ctrl+B / I / U', 'Bold / Italic / Underline'],
  ['Ctrl+] / Ctrl+[', 'Bring forward / Send backward'], ['Ctrl + mouse wheel', 'Zoom'], ['Ctrl+0', 'Zoom to fit'], ['Ctrl+1', 'Zoom 100%'],
  ['Shift while resizing', 'Keep proportions'], ['Alt while dragging', 'No snapping'], ['Double-click text', 'Edit text']
];

export function HelpDialog({ onClose, info }) {
  return <Modal title="Excel Label Studio — Help" onClose={onClose} width={820} footer={<Button kind="primary" onClick={onClose}>Close</Button>} testId="help">
    <div className="help-grid">
      <section>
        <h3>Workflow</h3>
        <ol>
          <li>Database → Connect (Ctrl+Shift+D): open your Excel/CSV, choose the sheet and header row.</li>
          <li>Drag columns from the <b>Data</b> tab onto the label, or add objects from the <b>Toolbox</b>.</li>
          <li>Set exact positions in mm and fonts in pt in <b>Properties</b>.</li>
          <li>Save (Ctrl+S). Next time open the template and connect any workbook with the same column names — the order of columns does not matter.</li>
          <li>Print (Ctrl+P): choose rows, copies or a Quantity column, then Test print once.</li>
        </ol>
        <h3>Keyboard</h3>
        <table className="shortcuts"><tbody>{SHORTCUTS.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
      </section>
      <section>
        <h3>Formulas</h3>
        <p>Columns: <code>[Product Name]</code> · prompts: <code>{'{?Batch}'}</code> · text: <code>"EGP"</code> · join: <code>&amp;</code> · maths: <code>+ - * / %</code> · compare: <code>= &lt;&gt; &lt; &gt; &lt;= &gt;=</code> · logic: <code>AND OR NOT</code></p>
        <p>Example: <code>{'IF([Qty] > 10, "BULK", "") & " " & FORMATDATE(ADDMONTHS([Cal. Date], 12), "dd/MM/yyyy")'}</code></p>
        <p className="functions">{FUNCTION_NAMES.map((f) => <code key={f}>{f}()</code>)}</p>
        <h3>Combined text</h3>
        <p><code>{'{Product Name} – {Price} EGP'}</code> · use <code>{'{{'}</code> for a literal brace.</p>
        <h3>About</h3>
        <p>Version {info?.version} · {info?.platform}. Free, offline, open source. Independent software — not affiliated with Seagull Scientific or BarTender. Data and templates stay on this computer: {info?.dataDir}</p>
      </section>
    </div>
  </Modal>;
}

export function RecoveryDialog({ recovery, onRestore, onDiscard }) {
  return <Modal title="Recover unsaved work" onClose={onDiscard} width={520} testId="recovery"
    footer={<><Button onClick={onDiscard} testId="recovery-discard">Discard</Button><Button kind="primary" icon={RotateCcw} onClick={onRestore} testId="recovery-restore">Restore</Button></>}>
    <p>{recovery.crashed ? 'Excel Label Studio did not close normally.' : 'Unsaved changes from your last session were found.'}</p>
    <p>Restore “<b>{recovery.template.name}</b>” as it was at {new Date(recovery.savedAt).toLocaleString()}?</p>
  </Modal>;
}
