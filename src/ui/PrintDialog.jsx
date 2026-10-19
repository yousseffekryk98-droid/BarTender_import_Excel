import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Printer, FileDown, RefreshCw, Ruler, AlertTriangle, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Modal, Button, SelectField, NumberField, Check, TextField, useDialog } from './controls.jsx';
import { planJob, serialStateAfter, serialStartsFor, CONFIRM_LABELS_ABOVE } from '../engine/jobs.js';
import { buildLabel, printDocumentHtml, testPatternLabelHtml } from '../engine/render.js';
import { templateFieldNames } from '../engine/binding.js';
import { validateJob, buildChunks, renderPreparedLabel, paperSize } from '../render/pipeline.js';
import { desktop, isDesktop } from '../platform/api.js';
import { LABEL_CSS } from '../engine/render.js';

function PrinterLine({ printer }) {
  if (!printer) return null;
  const problems = printer.problems || [];
  return <div className={'printer-status ' + (printer.blocking ? 'bad' : problems.length ? 'warn' : 'ok')} data-testid="printer-status">
    {printer.blocking ? <XCircle size={14} /> : problems.length ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
    <span>{problems.length ? problems.join(', ') : 'Status: ' + (printer.status === 'unknown' ? 'not reported by the driver' : printer.status)}</span>
  </div>;
}

export default function PrintDialog({ template, connection, rows, selection, previewId, printers, onRefreshPrinters, onClose, onPrinted, onSerialState, defaultPrinter }) {
  const ask = useDialog();
  const table = connection?.table;
  const headers = table?.headers || [];
  const usesData = templateFieldNames(template).length > 0;
  const [printerName, setPrinterName] = useState(template.page.printerName || defaultPrinter || printers.find((p) => p.isDefault)?.name || '');
  const [showDialog, setShowDialog] = useState(!isDesktop);
  const [scope, setScope] = useState(selection.size ? 'selected' : 'all');
  const [range, setRange] = useState({ from: rows[0]?.rowNumber || 1, to: rows[rows.length - 1]?.rowNumber || 1 });
  const [useQuantity, setUseQuantity] = useState(template.data.quantityMode === 'field' && Boolean(template.data.quantityField));
  const [copies, setCopies] = useState(template.page.copies || 1);
  const [promptValues, setPromptValues] = useState(() => Object.fromEntries(template.prompts.map((p) => [p.name, p.default])));
  const [check, setCheck] = useState(null);
  const [previews, setPreviews] = useState([]);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [ignoreStatus, setIgnoreStatus] = useState(false);
  const abort = useRef(null);
  const printer = printers.find((p) => p.name === printerName);

  const records = useMemo(() => {
    if (!usesData && !table) return [{ id: '1', rowNumber: 1, cells: [], raw: [] }];
    if (scope === 'selected') return rows.filter((r) => selection.has(r.id));
    if (scope === 'current') return rows.filter((r) => r.id === previewId).slice(0, 1);
    if (scope === 'range') return rows.filter((r) => r.rowNumber >= range.from && r.rowNumber <= range.to);
    return rows;
  }, [usesData, table, scope, rows, selection, previewId, range]);

  const plan = useMemo(() => planJob({
    template, headers, records, copies, ignoreQuantity: !useQuantity,
    quantityField: useQuantity ? template.data.quantityField : ''
  }), [template, headers, records, copies, useQuantity]);

  const promptProblems = template.prompts.filter((p) => p.required && !String(promptValues[p.name] ?? '').trim()).map((p) => '"' + (p.label || p.name) + '" is required.');
  const blocking = [...(usesData && !table ? ['Connect an Excel/CSV file: this label uses columns (' + templateFieldNames(template).slice(0, 4).join(', ') + ').'] : []), ...plan.blocking, ...promptProblems];

  // validate (expressions, barcodes, clipped text) and build previews
  useEffect(() => {
    let cancelled = false;
    setCheck(null);
    if (blocking.length || !plan.total) { setPreviews([]); return undefined; }
    const timer = setTimeout(async () => {
      const controller = new AbortController();
      abort.current = controller;
      const c = await validateJob({ template, plan, headers, prompts: promptValues, limit: 3000, signal: controller.signal });
      if (cancelled) return;
      setCheck(c);
      const shots = [];
      const serialStart = serialStartsFor(template);
      let base = 0;
      outer: for (const entry of plan.entries) {
        for (let copy = 1; copy <= Math.min(entry.copies, 2); copy++) {
          const labelIndex = base + copy - 1;
          const built = buildLabel(template, { headers, record: entry.record, prompts: promptValues, recordIndex: entry.recordIndex, recordNumber: entry.recordIndex + 1, labelIndex, labelNumber: labelIndex + 1, copyNumber: copy, copies: entry.copies, serialStart });
          shots.push({ key: entry.record.id + '-' + copy, row: entry.record.rowNumber, copy, html: (await renderPreparedLabel(template, built)).html });
          if (shots.length >= 6) break outer;
        }
        base += entry.copies;
      }
      if (!cancelled) setPreviews(shots);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); abort.current?.abort(); };
  }, [template, plan, headers, promptValues, blocking.length]);

  const issues = check ? [...check.errors, ...check.barcodeErrors] : [];
  const canPrint = !blocking.length && plan.total > 0 && check && !issues.length && !progress;
  const paper = paperSize(template.page);

  async function run(mode) {
    if (mode === 'print' && plan.total > CONFIRM_LABELS_ABOVE) {
      const ok = await ask({ title: 'Large print job', message: 'You are about to print ' + plan.total.toLocaleString() + ' labels on "' + (printer?.displayName || 'the chosen printer') + '". Continue?', confirmLabel: 'Print ' + plan.total.toLocaleString() + ' labels' });
      if (!ok) return;
    }
    if (mode === 'print' && check?.clipped.length) {
      const ok = await ask({ title: 'Some text does not fit', message: <><p>{check.clipped.length} text object(s) are cut off on some labels, for example:</p><ul>{check.clipped.slice(0, 4).map((c) => <li key={c}>{c}</li>)}</ul><p>Print anyway?</p></>, confirmLabel: 'Print anyway' });
      if (!ok) return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setResult(null);
    setProgress({ done: 0, total: plan.total, mode });
    const jobId = globalThis.crypto.randomUUID();
    const outcomes = [];
    let pdfParts = [];
    try {
      const status = await buildChunks({
        template, plan, headers, prompts: promptValues, signal: controller.signal, title: template.name,
        onProgress: (done) => setProgress((p) => ({ ...p, done })),
        onChunk: async (chunk) => {
          if (mode === 'pdf') { pdfParts.push(chunk.html); return true; }
          const r = await desktop.print.job({
            html: chunk.html, page: paper, printerName, showDialog, ignoreStatus, jobId, chunkIndex: chunk.index, chunkCount: chunk.count, labelCount: chunk.labelCount,
            meta: { templateId: template.id, templateName: template.name, templateRevision: template.revision, source: 'manual', dataFile: connection?.fileName || '', sheetName: connection?.sheets?.[connection.sheetIndex]?.name || '', totalLabels: plan.total, rows: plan.entries.map((e) => String(e.record.rowNumber)) }
          });
          outcomes.push(r);
          if (!r.ok) return false;
          return !controller.signal.aborted;
        }
      });
      if (mode === 'pdf') {
        if (status.cancelled) { setResult({ kind: 'info', text: 'PDF export cancelled.' }); return; }
        // a single PDF: merge chunk bodies into one document
        const bodies = pdfParts.map((html) => html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>')));
        const html = pdfParts[0].slice(0, pdfParts[0].indexOf('<body>') + 6) + bodies.join('') + '</body></html>';
        const r = await desktop.print.pdfDialog({ html, page: paper, suggestedName: template.name });
        if (r?.canceled) setResult({ kind: 'info', text: 'PDF export cancelled.' });
        else setResult({ kind: 'ok', text: 'Saved ' + plan.total + ' label(s) as PDF' + (r?.path && r.path !== 'download' ? ': ' + r.path : '.'), path: r?.path });
        return;
      }
      const failed = outcomes.find((o) => !o.ok);
      const sent = outcomes.filter((o) => o.ok).length;
      if (status.cancelled && !failed) {
        await desktop.print.cancelled?.(jobId).catch(() => {});
        setResult({ kind: 'warn', text: 'Stopped. ' + sent + ' of ' + outcomes.length + ' part(s) had already been sent to Windows; they may still print.' });
      } else if (failed) {
        setResult({ kind: 'error', text: failed.message || 'Printing failed.', partial: sent > 0 ? sent + ' part(s) were sent before the error.' : '' });
      } else {
        const warnings = outcomes.map((o) => o.warning).filter(Boolean);
        const simulated = outcomes.some((o) => o.simulatedFile);
        setResult({ kind: warnings.length ? 'warn' : 'ok', text: (simulated ? 'Simulated printer wrote ' : isDesktop ? 'Sent ' : 'Opened print for ') + plan.total.toLocaleString() + ' label(s)' + (isDesktop && !simulated ? ' to the Windows spooler for "' + (printer?.displayName || printerName || 'the selected printer') + '". Check the printed labels — Windows cannot confirm physical printing.' : '.'), warnings });
        const state = serialStateAfter(template, plan);
        if (JSON.stringify(state) !== JSON.stringify(template.serialState || {})) onSerialState?.(state);
        onPrinted?.({ jobId, total: plan.total });
      }
    } catch (error) {
      setResult({ kind: 'error', text: error.message || String(error) });
    } finally {
      setProgress(null);
    }
  }

  async function testPrint() {
    const html = printDocumentHtml([testPatternLabelHtml(template.page)], template.page, { title: 'Alignment test' });
    try {
      const r = await desktop.print.job({ html, page: paper, printerName, showDialog, ignoreStatus, labelCount: 1, meta: { templateId: template.id, templateName: template.name + ' (test)', source: 'test' } });
      setResult(r.ok ? { kind: 'ok', text: 'Alignment test sent. The border should sit 0.5 mm inside the label edge; adjust Offset X/Y in Label properties if it does not.' } : { kind: 'error', text: r.message || 'Test print failed.' });
    } catch (error) { setResult({ kind: 'error', text: error.message }); }
  }

  return <Modal title={'Print — ' + template.name} onClose={progress ? undefined : onClose} width={920} testId="print-dialog" className="print-dialog"
    footer={<>
      <Button icon={Ruler} onClick={testPrint} disabled={Boolean(progress)} title="Print a border and ruler pattern to check alignment" testId="test-print">Test print</Button>
      <Button icon={FileDown} onClick={() => run('pdf')} disabled={!canPrint} testId="save-pdf">Save as PDF…</Button>
      <span className="spacer" />
      {progress ? <Button kind="danger" onClick={() => abort.current?.abort()} testId="cancel-print">Stop</Button> : <Button onClick={onClose}>Close</Button>}
      <Button kind="primary" icon={Printer} onClick={() => run('print')} disabled={!canPrint || (!printerName && isDesktop && !showDialog)} testId="print-now">Print {plan.total ? plan.total.toLocaleString() + ' label' + (plan.total > 1 ? 's' : '') : ''}</Button>
    </>}>
    <div className="print-grid">
      <div className="print-options">
        {isDesktop && <>
          <div className="row-with-button">
            <SelectField label="Printer" value={printerName} onChange={setPrinterName} testId="printer-select"
              options={[{ value: '', label: printers.length ? '— choose printer —' : 'No printers found' }, ...printers.map((p) => ({ value: p.name, label: p.displayName + (p.isDefault ? ' (default)' : '') }))]} />
            <Button icon={RefreshCw} onClick={onRefreshPrinters} title="Refresh printers and status" />
          </div>
          <PrinterLine printer={printer} />
          {printer?.blocking && <Check label="Print anyway (ignore printer status)" checked={ignoreStatus} onChange={setIgnoreStatus} />}
          <Check label="Show the Windows print dialog" checked={showDialog} onChange={setShowDialog} />
        </>}
        <fieldset disabled={!table}>
          <legend>Records</legend>
          <label className="radio"><input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} /> Selected rows ({rows.filter((r) => selection.has(r.id)).length})</label>
          <label className="radio"><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All rows after filters ({rows.length})</label>
          <label className="radio"><input type="radio" checked={scope === 'current'} onChange={() => setScope('current')} disabled={!previewId} /> Current preview row</label>
          <label className="radio"><input type="radio" checked={scope === 'range'} onChange={() => setScope('range')} /> Excel rows from</label>
          {scope === 'range' && <div className="grid-2"><NumberField label="From row" value={range.from} step={1} decimals={0} onChange={(from) => setRange((r) => ({ ...r, from }))} /><NumberField label="To row" value={range.to} step={1} decimals={0} onChange={(to) => setRange((r) => ({ ...r, to }))} /></div>}
        </fieldset>
        <fieldset>
          <legend>Copies</legend>
          {template.data.quantityField && <Check label={'Quantity per row from column "' + template.data.quantityField + '"'} checked={useQuantity} onChange={setUseQuantity} testId="use-quantity" />}
          {!useQuantity && <NumberField label="Copies of each label" value={copies} min={1} max={100000} step={1} decimals={0} onChange={setCopies} testId="copies" />}
          {plan.zeroQuantity > 0 && <p className="hint">{plan.zeroQuantity} row(s) have quantity 0 or blank and are skipped.</p>}
        </fieldset>
        {template.prompts.length > 0 && <fieldset><legend>Values for this print</legend>
          {template.prompts.map((p) => p.type === 'choice'
            ? <SelectField key={p.name} label={(p.label || p.name) + (p.required ? ' *' : '')} value={promptValues[p.name] ?? ''} onChange={(v) => setPromptValues((s) => ({ ...s, [p.name]: v }))} options={['', ...p.choices]} />
            : <TextField key={p.name} label={(p.label || p.name) + (p.required ? ' *' : '')} value={promptValues[p.name] ?? ''} onChange={(v) => setPromptValues((s) => ({ ...s, [p.name]: v }))} live />)}
        </fieldset>}
      </div>
      <div className="print-summary">
        <div className="summary-head">
          <div><b data-testid="label-total">{plan.total.toLocaleString()}</b> label(s) · {template.page.width} × {template.page.height} mm{template.page.printRotation ? ' · rotated ' + template.page.printRotation + '°' : ''}</div>
          {plan.total > 250 && <div className="hint">Sent to Windows in {Math.ceil(plan.total / 250)} parts of up to 250 labels.</div>}
        </div>
        {blocking.length > 0 && <div className="issues bad" data-testid="print-blocking">{blocking.map((b) => <div key={b}><XCircle size={13} /> {b}</div>)}</div>}
        {!blocking.length && !check && plan.total > 0 && <div className="issues"><Loader2 size={13} className="spin" /> Checking labels…</div>}
        {issues.length > 0 && <div className="issues bad" data-testid="print-issues">{issues.slice(0, 8).map((b) => <div key={b}><XCircle size={13} /> {b}</div>)}</div>}
        {check && check.clipped.length > 0 && <div className="issues warn" data-testid="print-clipped">{check.clipped.slice(0, 5).map((b) => <div key={b}><AlertTriangle size={13} /> {b}</div>)}</div>}
        {check && !issues.length && !check.clipped.length && !blocking.length && <div className="issues ok"><CheckCircle2 size={13} /> All {check.checked.toLocaleString()} checked label(s) are valid.</div>}
        <div className="preview-strip" data-testid="print-previews">
          <style>{LABEL_CSS}</style>
          {previews.map((p) => {
            const zoom = Math.min(1.6, 200 / (template.page.width * 3.78));
            return <figure key={p.key} className="preview-thumb">
              <div className="thumb-paper" style={{ width: template.page.width * 3.7795 * zoom, height: template.page.height * 3.7795 * zoom }}>
                <div style={{ transform: 'scale(' + zoom + ')', transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: p.html }} />
              </div>
              <figcaption>Row {p.row}{p.copy > 1 ? ' · copy ' + p.copy : ''}</figcaption>
            </figure>;
          })}
        </div>
        {progress && <div className="progress" data-testid="print-progress">
          <div className="bar"><span style={{ width: Math.round((progress.done / Math.max(1, progress.total)) * 100) + '%' }} /></div>
          <span>{progress.mode === 'pdf' ? 'Preparing PDF' : 'Printing'} {progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>
        </div>}
        {result && <div className={'result result-' + result.kind} data-testid="print-result">
          <p>{result.text}</p>
          {result.partial && <p>{result.partial}</p>}
          {(result.warnings || []).map((w) => <p key={w}><AlertTriangle size={13} /> {w}</p>)}
          {result.path && result.path !== 'download' && <Button kind="ghost" onClick={() => desktop.shell.showFile(result.path)}>Show in folder</Button>}
        </div>}
      </div>
    </div>
  </Modal>;
}
