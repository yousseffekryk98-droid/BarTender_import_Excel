import React, { useEffect, useState } from 'react';
import { Plus, Trash2, FolderOpen, Check as CheckIcon, X, Ban, KeyRound, Copy } from 'lucide-react';
import { Modal, Button, Tabs, TextField, SelectField, NumberField, Check, useDialog } from '../controls.jsx';
import { desktop } from '../../platform/api.js';

function FolderInput({ label, value, onChange }) {
  return <div className="row-with-button">
    <TextField label={label} value={value} onChange={onChange} placeholder="C:\\LabelJobs\\Incoming" />
    <Button icon={FolderOpen} onClick={async () => { const p = await desktop.automation.chooseFolder(label); if (p) onChange(p); }} title="Choose folder" />
  </div>;
}

function RuleEditor({ rule, onChange, onRemove, templates, printers }) {
  const set = (patch) => onChange({ ...rule, ...patch });
  return <div className="rule-card">
    <div className="rule-head">
      <Check label={<b>{rule.name}</b>} checked={rule.enabled} onChange={(enabled) => set({ enabled })} />
      <Button kind="ghost" icon={Trash2} onClick={onRemove}>Remove</Button>
    </div>
    <div className="grid-2">
      <TextField label="Rule name" value={rule.name} onChange={(name) => set({ name })} />
      <TextField label="File pattern" value={rule.pattern} onChange={(pattern) => set({ pattern })} placeholder="*.xlsx;*.csv" />
    </div>
    <FolderInput label="Incoming folder" value={rule.incoming} onChange={(incoming) => set({ incoming })} />
    <div className="grid-2">
      <FolderInput label="Completed folder" value={rule.completed} onChange={(completed) => set({ completed })} />
      <FolderInput label="Error folder" value={rule.error} onChange={(error) => set({ error })} />
    </div>
    <div className="grid-2">
      <SelectField label="Template" value={rule.templateId} onChange={(templateId) => set({ templateId })} options={[{ value: '', label: '— choose saved template —' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
      <SelectField label="Action" value={rule.action} onChange={(action) => set({ action })} options={[{ value: 'print', label: 'Print' }, { value: 'pdf', label: 'Save PDF' }, { value: 'validate', label: 'Validate only' }]} />
      {rule.action === 'print' && <SelectField label="Printer" value={rule.printerName} onChange={(printerName) => set({ printerName })} options={[{ value: '', label: '— choose printer —' }, ...printers.map((p) => ({ value: p.name, label: p.displayName }))]} />}
      {rule.action === 'pdf' && <FolderInput label="PDF folder" value={rule.pdfFolder} onChange={(pdfFolder) => set({ pdfFolder })} />}
      <TextField label="Worksheet (blank = first)" value={rule.sheetName} onChange={(sheetName) => set({ sheetName })} />
      <TextField label="Quantity column (blank = template)" value={rule.quantityField} onChange={(quantityField) => set({ quantityField })} />
      <NumberField label="Max labels per file" value={rule.maxLabels} min={1} max={100000} step={100} decimals={0} onChange={(maxLabels) => set({ maxLabels })} />
      <TextField label="Run at (HH:MM, blank = immediately)" value={rule.scheduleAt} onChange={(scheduleAt) => set({ scheduleAt })} placeholder="17:30" />
    </div>
    <Check label="Wait for my approval before printing each file (recommended)" checked={rule.requireApproval} onChange={(requireApproval) => set({ requireApproval })} />
  </div>;
}

export default function AutomationDialog({ onClose, templates, printers, notify }) {
  const ask = useDialog();
  const [tab, setTab] = useState('settings');
  const [config, setConfig] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!desktop.automation) return undefined;
    desktop.automation.get().then(setConfig).catch((e) => setError(e.message));
    const refresh = () => { desktop.automation.jobs().then(setJobs).catch(() => {}); desktop.automation.logs().then(setLogs).catch(() => {}); };
    refresh();
    const off = desktop.automation.onEvent(() => refresh());
    return off;
  }, []);

  if (!desktop.automation) return <Modal title="Automation" onClose={onClose}><p>Automation needs the Windows desktop app.</p></Modal>;
  if (!config) return <Modal title="Automation" onClose={onClose}><p>Loading…</p>{error && <div className="issues bad">{error}</div>}</Modal>;

  const save = async () => {
    setSaving(true); setError('');
    try { const next = await desktop.automation.set(config); setConfig(next); notify('Automation settings saved.' + (next.apiStatus?.error ? ' API: ' + next.apiStatus.error : '')); }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  const addRule = () => setConfig((c) => ({ ...c, folders: [...c.folders, { id: 'rule-' + Math.random().toString(36).slice(2, 8), name: 'Folder rule ' + (c.folders.length + 1), enabled: true, incoming: '', completed: '', error: '', pattern: '*.xlsx;*.xls;*.csv', templateId: '', printerName: '', sheetName: '', quantityField: '', action: 'print', pdfFolder: '', maxLabels: 1000, requireApproval: true, scheduleAt: '' }] }));
  const pending = jobs.filter((j) => j.status === 'awaiting-approval');
  const curl = 'curl -X POST http://127.0.0.1:' + config.api.port + '/api/v1/jobs -H "Authorization: Bearer ' + (token || '<token>') + '" -H "Content-Type: application/json" -d "{\\"templateId\\":\\"' + (templates[0]?.id || '<template id>') + '\\",\\"printerName\\":\\"<printer>\\",\\"records\\":[{\\"Product Name\\":\\"Mouse\\",\\"Price\\":\\"325\\"}]}"';

  return <Modal title="Automation (watch folders & local API)" onClose={onClose} width={960} testId="automation-dialog" className="automation"
    footer={<><span className="spacer" /><Button onClick={onClose}>Close</Button>{tab === 'settings' && <Button kind="primary" onClick={save} disabled={saving} testId="save-automation">Save settings</Button>}</>}>
    <Tabs active={tab} onChange={setTab} tabs={[{ id: 'settings', label: 'Settings' }, { id: 'queue', label: 'Queue', badge: pending.length || null }, { id: 'log', label: 'Log' }]} />
    {error && <div className="issues bad">{error}</div>}
    {tab === 'settings' && <div className="automation-settings">
      <Check label={<b>Enable automation</b>} checked={config.enabled} onChange={(enabled) => setConfig({ ...config, enabled })} testId="automation-enabled" />
      <p className="hint">Off by default. When on, Excel Label Studio must stay open. Incoming files are checked (file type, size, worksheet, every template column present, label limit) before anything prints; rejected files go to the Error folder with a log.</p>
      <h3>Watch folders</h3>
      {config.folders.map((rule, i) => <RuleEditor key={rule.id} rule={rule} templates={templates} printers={printers}
        onChange={(r) => setConfig({ ...config, folders: config.folders.map((x, j) => (j === i ? r : x)) })}
        onRemove={() => setConfig({ ...config, folders: config.folders.filter((_, j) => j !== i) })} />)}
      <Button icon={Plus} onClick={addRule} testId="add-rule">Add folder rule</Button>
      <h3>Local REST API</h3>
      <div className="grid-2">
        <Check label="Enable API on this computer only (127.0.0.1)" checked={config.api.enabled} onChange={(enabled) => setConfig({ ...config, api: { ...config.api, enabled } })} />
        <NumberField label="Port" value={config.api.port} min={1024} max={65535} step={1} decimals={0} onChange={(port) => setConfig({ ...config, api: { ...config.api, port } })} />
      </div>
      {config.apiStatus?.running && <p className="ok-text">Running at {config.apiStatus.url}</p>}
      {config.apiStatus?.error && <p className="issues bad">{config.apiStatus.error}</p>}
      <div className="button-row">
        <Button icon={KeyRound} onClick={async () => setToken(await desktop.automation.token(false))}>Show token</Button>
        <Button onClick={async () => { if (await ask({ title: 'New token', message: 'Create a new token? Integrations using the old one stop working.', confirmLabel: 'Create new token', danger: true })) setToken(await desktop.automation.token(true)); }}>New token</Button>
        {token && <Button icon={Copy} onClick={() => navigator.clipboard?.writeText(token)}>Copy token</Button>}
      </div>
      {token && <pre className="code">{token}</pre>}
      <details><summary>Example request</summary><pre className="code">{curl}</pre>
        <p className="hint">Endpoints: GET /api/v1/health, /templates, /printers, /jobs, /jobs/&lt;id&gt; · POST /api/v1/jobs {'{templateId, printerName, records | csv, quantityField, copies, prompts, action: print|pdf|validate, runAt, dryRun}'} · DELETE /api/v1/jobs/&lt;id&gt;. Requests from web browsers are refused.</p>
      </details>
      <h3>Retries</h3>
      <div className="grid-2">
        <NumberField label="Attempts per job" value={config.retry.maxAttempts} min={1} max={10} step={1} decimals={0} onChange={(maxAttempts) => setConfig({ ...config, retry: { ...config.retry, maxAttempts } })} />
        <NumberField label="Wait between attempts" unit="s" value={config.retry.delaySeconds} min={5} max={3600} step={5} decimals={0} onChange={(delaySeconds) => setConfig({ ...config, retry: { ...config.retry, delaySeconds } })} />
      </div>
    </div>}
    {tab === 'queue' && <table className="jobs"><thead><tr><th>Created</th><th>Job</th><th>Status</th><th>Attempts</th><th /></tr></thead>
      <tbody>{jobs.map((j) => <tr key={j.id}>
        <td>{new Date(j.createdAt).toLocaleString()}</td>
        <td>{j.description}<div className="hint">{j.source}{j.runAt > Date.now() ? ' · scheduled ' + new Date(j.runAt).toLocaleString() : ''}</div></td>
        <td className={'status-' + j.status}>{j.status}{j.error && <div className="hint">{j.error}</div>}</td>
        <td>{j.attempts}/{j.maxAttempts}</td>
        <td className="actions">
          {j.status === 'awaiting-approval' && <><Button kind="primary" icon={CheckIcon} onClick={() => desktop.automation.approve(j.id)}>Approve</Button><Button icon={X} onClick={() => desktop.automation.reject(j.id)}>Reject</Button></>}
          {['queued', 'scheduled', 'retrying'].includes(j.status) && <Button icon={Ban} onClick={() => desktop.automation.cancel(j.id)}>Cancel</Button>}
        </td>
      </tr>)}
        {!jobs.length && <tr><td colSpan={5} className="hint">No automation jobs yet.</td></tr>}
      </tbody></table>}
    {tab === 'log' && <div className="log-view">{logs.map((l, i) => <div key={i} className={'log-' + l.level}><span>{l.at ? new Date(l.at).toLocaleString() : ''}</span> {l.rule && <b>[{l.rule}]</b>} {l.message}</div>)}{!logs.length && <p className="hint">Nothing logged yet.</p>}</div>}
  </Modal>;
}
