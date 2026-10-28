import React, { useEffect, useState } from 'react';
import { RefreshCw, Printer } from 'lucide-react';
import { Modal, Button, SelectField } from '../controls.jsx';
import { isDesktop } from '../../platform/api.js';
import { printerConnectionMessage } from '../../platform/printer-connection.js';

export default function PrinterConnectionDialog({ printers, defaultPrinter, onRefreshPrinters, onConnectPrinter, onClose }) {
  const [name, setName] = useState(defaultPrinter || '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const selected = printers.find((p) => p.name === name);
  useEffect(() => {
    if (!name && printers.length) setName(printers.find((p) => p.name === defaultPrinter)?.name || printers.find((p) => p.isDefault)?.name || printers[0].name);
  }, [name, printers, defaultPrinter]);
  async function refresh() {
    setFeedback(null); setBusy(true);
    try { await onRefreshPrinters(); }
    catch (error) { setFeedback({ kind: 'bad', text: 'Could not refresh printers: ' + error.message }); }
    finally { setBusy(false); }
  }
  async function connect() {
    setFeedback(null); setBusy(true);
    try { setFeedback(printerConnectionMessage(await onConnectPrinter(name))); }
    catch (error) { setFeedback({ kind: 'bad', text: error.message || 'Printer connection check failed.' }); }
    finally { setBusy(false); }
  }
  return <Modal title="Connect printer" testId="printer-setup" width={550} onClose={onClose}
    footer={<><Button onClick={onClose}>Close</Button><Button kind="primary" icon={Printer} testId="printer-setup-connect" onClick={connect} disabled={!isDesktop || !name || busy}>{busy ? 'Checking…' : 'Connect printer'}</Button></>}>
    <div className="print-options">
      {isDesktop ? <>
        <div className="row-with-button">
          <SelectField label="Windows printer" testId="printer-setup-select" value={name} onChange={(value) => { setName(value); setFeedback(null); }}
            options={[{ value: '', label: printers.length ? '— choose printer —' : 'No printers found' }, ...(name && !selected ? [{ value: name, label: 'Not found: ' + name }] : []), ...printers.map((p) => ({ value: p.name, label: p.displayName + (p.isDefault ? ' (Windows default)' : '') }))]} />
          <Button onClick={refresh} icon={RefreshCw} disabled={busy} testId="printer-setup-refresh">Refresh</Button>
        </div>
        {selected && <div className={'printer-status ' + (selected.blocking ? 'bad' : selected.problems?.length ? 'warn' : 'ok')}>Windows status: {selected.status}{selected.problems?.length ? ' — ' + selected.problems.join(', ') : ''}</div>}
        {feedback && <div role="status" data-testid="printer-setup-status" className={'printer-status ' + feedback.kind}>{feedback.text}</div>}
        {!printers.length && <p className="hint" data-testid="printer-setup-empty">No printers found. Power on your printer, install its manufacturer driver, add it under Windows Settings → Bluetooth & devices → Printers & scanners, and click Refresh.</p>}
        <p className="hint">Windows manages USB, Bluetooth and network connections. Connect verifies the installed Windows printer, then saves it as the app default. Open Print → Test print to confirm actual hardware communication.</p>
      </> : <p className="hint" data-testid="printer-setup-browser">Printer discovery is only available in the Windows desktop app. Browsers use the system print dialog.</p>}
    </div>
  </Modal>;
}
