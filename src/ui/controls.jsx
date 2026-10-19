import React, { useEffect, useRef, useState, createContext, useContext, useCallback } from 'react';
import { X, ChevronDown, ChevronRight } from 'lucide-react';

/** Number input that commits on Enter/blur (never mid-typing), with min/max/step and arrow-key nudging. */
export function NumberField({ label, value, onChange, min = -Infinity, max = Infinity, step = 0.1, unit, disabled, title, width, decimals = 3, testId }) {
  const [text, setText] = useState(format(value, decimals));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(format(value, decimals)); }, [value, decimals]);
  const commit = (raw = text) => {
    const n = Number(String(raw).replace(',', '.'));
    if (raw === '' || !Number.isFinite(n)) { setText(format(value, decimals)); return; }
    const clamped = Math.max(min, Math.min(max, n));
    setText(format(clamped, decimals));
    if (clamped !== value) onChange(clamped);
  };
  return <label className="field" title={title} style={width ? { width } : undefined}>
    {label && <span className="field-label">{label}</span>}
    <span className="field-input-wrap">
      <input type="text" inputMode="decimal" value={text} disabled={disabled} data-testid={testId}
        onFocus={(e) => { focused.current = true; e.target.select(); }}
        onBlur={() => { focused.current = false; commit(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
          else if (e.key === 'Escape') { setText(format(value, decimals)); e.currentTarget.blur(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const n = Math.max(min, Math.min(max, Math.round(((Number(text) || 0) + delta) * 1000) / 1000));
            setText(format(n, decimals)); onChange(n);
          }
        }} />
      {unit && <span className="field-unit">{unit}</span>}
    </span>
  </label>;
}

function format(value, decimals) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 10 ** decimals) / 10 ** decimals) : '';
}

/** Text input that commits on blur/Enter (multi-line optional). */
export function TextField({ label, value, onChange, placeholder, multiline, rows = 3, disabled, dir = 'auto', maxLength = 5000, live = false, testId, mono }) {
  const [text, setText] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value ?? ''); }, [value]);
  const commit = () => { if (text !== (value ?? '')) onChange(text); };
  const props = {
    value: text, placeholder, disabled, dir, maxLength, 'data-testid': testId, className: mono ? 'mono' : undefined,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; commit(); },
    onChange: (e) => { setText(e.target.value); if (live) onChange(e.target.value); },
    onKeyDown: (e) => { if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); commit(); } if (e.key === 'Escape') { setText(value ?? ''); } }
  };
  return <label className="field">
    {label && <span className="field-label">{label}</span>}
    {multiline ? <textarea rows={rows} {...props} /> : <input type="text" {...props} />}
  </label>;
}

export function SelectField({ label, value, onChange, options, disabled, title, testId }) {
  return <label className="field" title={title}>
    {label && <span className="field-label">{label}</span>}
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </select>
  </label>;
}

export function Check({ label, checked, onChange, disabled, title, testId }) {
  return <label className="check" title={title}>
    <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
    <span>{label}</span>
  </label>;
}

export function ColorField({ label, value, onChange, allowTransparent = true }) {
  const transparent = value === 'transparent';
  return <label className="field color-field">
    {label && <span className="field-label">{label}</span>}
    <span className="color-row">
      <input type="color" value={transparent ? '#ffffff' : (value || '#000000').slice(0, 7)} onChange={(e) => onChange(e.target.value)} disabled={transparent} />
      {allowTransparent && <label className="check small"><input type="checkbox" checked={transparent} onChange={(e) => onChange(e.target.checked ? 'transparent' : '#ffffff')} /><span>None</span></label>}
    </span>
  </label>;
}

export function Section({ title, children, defaultOpen = true, actions }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={'section' + (open ? ' open' : '')}>
    <header className="section-head">
      <button type="button" className="section-toggle" onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{title}</span></button>
      {actions}
    </header>
    {open && <div className="section-body">{children}</div>}
  </section>;
}

export function IconButton({ icon: Icon, label, onClick, disabled, active, shortcut, testId, size = 16, className = '' }) {
  return <button type="button" className={'icon-btn ' + (active ? 'active ' : '') + className} onClick={onClick} disabled={disabled}
    title={label + (shortcut ? ' (' + shortcut + ')' : '')} aria-label={label} aria-pressed={active === undefined ? undefined : Boolean(active)} data-testid={testId}>
    <Icon size={size} />
  </button>;
}

export function Button({ children, onClick, disabled, kind = 'default', icon: Icon, testId, title, type = 'button' }) {
  return <button type={type} className={'btn btn-' + kind} onClick={onClick} disabled={disabled} data-testid={testId} title={title}>
    {Icon && <Icon size={15} />}{children}
  </button>;
}

export function Modal({ title, onClose, children, footer, width = 560, testId, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('input,select,textarea,button:not(.modal-close)')?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && onClose) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus?.(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
    <div className={'modal ' + className} role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} data-testid={testId}>
      <header className="modal-head"><h2>{title}</h2>{onClose && <button type="button" className="modal-close" aria-label="Close" onClick={onClose}><X size={16} /></button>}</header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-foot">{footer}</footer>}
    </div>
  </div>;
}

// ---------- confirm / alert dialogs ----------
const DialogContext = createContext(null);

/**
 * ask({ title, message, confirmLabel, danger, buttons: [{label, value, kind}], input: { defaultValue, placeholder } })
 * Resolves with the clicked button's value; with `input`, resolves with the text (or null when cancelled).
 */
export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [text, setText] = useState('');
  const ask = useCallback((options) => new Promise((resolve) => { setText(options.input?.defaultValue ?? ''); setDialog({ ...options, resolve }); }), []);
  const close = (value) => {
    const result = dialog?.input ? (value ? text.trim() : null) : value;
    dialog?.resolve(result);
    setDialog(null);
  };
  return <DialogContext.Provider value={ask}>
    {children}
    {dialog && <Modal title={dialog.title || 'Excel Label Studio'} onClose={() => close(dialog.cancelValue ?? false)} width={dialog.width || 460} testId="confirm-dialog"
      footer={<>
        {(dialog.buttons || [{ label: 'Cancel', value: false }, { label: dialog.confirmLabel || 'OK', value: true, kind: dialog.danger ? 'danger' : 'primary' }]).map((b) =>
          <Button key={b.label} kind={b.kind || 'default'} onClick={() => close(b.value)} testId={'dialog-' + String(b.label).toLowerCase().replace(/\W+/g, '-')}>{b.label}</Button>)}
      </>}>
      <div className="dialog-message">{dialog.message}</div>
      {dialog.input && (dialog.input.multiline
        ? <textarea className="wide" rows={4} value={text} placeholder={dialog.input.placeholder} maxLength={dialog.input.maxLength || 5000} dir="auto" data-testid="dialog-input"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) close(true); }} autoFocus />
        : <input className="wide" value={text} placeholder={dialog.input.placeholder} maxLength={dialog.input.maxLength || 120} dir="auto" data-testid="dialog-input"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) close(true); }} autoFocus />)}
    </Modal>}
  </DialogContext.Provider>;
}

export function useDialog() { return useContext(DialogContext); }

export function Tabs({ tabs, active, onChange }) {
  return <div className="tabs" role="tablist">
    {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={'tab' + (active === t.id ? ' active' : '')} onClick={() => onChange(t.id)} data-testid={'tab-' + t.id} title={t.title}>
      {t.icon && <t.icon size={14} />}<span>{t.label}</span>{t.badge ? <em className="badge">{t.badge}</em> : null}
    </button>)}
  </div>;
}

export function Notice({ kind = 'info', children, onClose }) {
  return <div className={'notice notice-' + kind} role={kind === 'error' ? 'alert' : 'status'}>
    <div className="notice-text">{children}</div>
    {onClose && <button type="button" aria-label="Dismiss" onClick={onClose}><X size={14} /></button>}
  </div>;
}
