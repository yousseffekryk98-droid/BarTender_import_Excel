import React, { useMemo, useState } from 'react';
import { Pencil, ArrowRightLeft } from 'lucide-react';
import { Modal, Button, SelectField, NumberField } from '../controls.jsx';
import { makeContext, resolveText } from '../../engine/binding.js';
import { buildTextEditPatch, suggestedFixedText } from '../text-edit.js';

// Editing a visible label is separate from editing the Excel source file.
// Explicit conversion to fixed text freezes the currently displayed value.
const SOURCES = [
  { value: 'static', label: 'Fixed text — type your own words' },
  { value: 'field', label: 'Excel column — updates for every row' },
  { value: 'template', label: 'Combined text — include {Column} names' },
  { value: 'expression', label: 'Calculated formula' },
  { value: 'date', label: 'Print date / time' },
  { value: 'serial', label: 'Serial number' },
  { value: 'prompt', label: 'Ask when printing' }
];

export default function TextEditorDialog({ object, fields, headers, record, prompts, dateOrder, onSave, onClose }) {
  const ctx = useMemo(() => makeContext({
    headers, record: record || { cells: [] }, prompts, dateOrder, placeholders: !record
  }), [headers, record, prompts, dateOrder]);
  const preview = useMemo(() => {
    try { return resolveText(object, ctx); }
    catch { return ''; }
  }, [object, ctx]);
  const [content, setContent] = useState(() => ({ ...object.content }));
  const [changedToFixed, setChangedToFixed] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => { setContent((current) => ({ ...current, ...patch })); setError(''); };
  const setMode = (mode) => {
    if (mode === 'static' && object.content.mode !== 'static') {
      set({ mode, text: suggestedFixedText(object, preview) });
      setChangedToFixed(true);
    } else {
      set({ mode });
      setChangedToFixed(false);
    }
  };
  const save = () => {
    if (content.mode === 'field' && !String(content.field || '').trim()) { setError('Select or type an Excel column name.'); return; }
    if (content.mode === 'prompt' && !String(content.prompt || '').trim()) { setError('Select or type a prompt name.'); return; }
    onSave(buildTextEditPatch(object, content, changedToFixed));
  };
  return <Modal title={'Edit text — ' + (object.name || 'Text')} width={570} onClose={onClose} testId="text-editor"
    footer={<><Button onClick={onClose}>Cancel</Button><Button icon={Pencil} kind="primary" onClick={save} testId="save-text-edit">Save text</Button></>}>
    <div className="print-options">
      <SelectField label="Text source" value={content.mode} onChange={setMode} options={SOURCES} testId="text-source" />
      {content.mode === 'static' && <>
        {changedToFixed && <p className="text-edit-note"><ArrowRightLeft size={14} /> This replaces the Excel/automatic link with fixed text for every label. The original Excel data stays unchanged.</p>}
        <label className="field"><span className="field-label">Text on the label</span>
          <textarea rows={5} value={content.text || ''} onChange={(e) => set({ text: e.target.value })} maxLength={5000} dir="auto"
            data-testid="edit-text-input" autoFocus />
        </label>
      </>}
      {content.mode === 'field' && <>
        <label className="field"><span className="field-label">Excel column name</span>
          <input type="text" list="text-editor-columns" value={content.field || ''} onChange={(e) => set({ field: e.target.value })} data-testid="edit-text-field" />
          <datalist id="text-editor-columns">{fields.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <p className="text-edit-note">This is dynamic text, so every Excel row supplies its own value. Choose Fixed text above to type a permanent replacement.</p>
      </>}
      {content.mode === 'template' && <>
        <label className="field"><span className="field-label">Combined text</span>
          <textarea rows={4} value={content.template || ''} onChange={(e) => set({ template: e.target.value })} data-testid="edit-text-template" dir="auto" />
        </label>
        <p className="text-edit-note">Use {'{Product Name}'} and {'{Price}'} to insert Excel fields. To make the label independent of Excel, choose Fixed text.</p>
      </>}
      {content.mode === 'expression' && <label className="field"><span className="field-label">Expression</span>
        <textarea rows={4} className="mono" value={content.expression || ''} onChange={(e) => set({ expression: e.target.value })} data-testid="edit-text-expression" />
      </label>}
      {content.mode === 'date' && <div className="grid-2">
        <NumberField label="Add days" value={content.date?.offsetDays || 0} step={1} decimals={0} onChange={(offsetDays) => set({ date: { ...content.date, offsetDays } })} />
        <NumberField label="Add months" value={content.date?.offsetMonths || 0} step={1} decimals={0} onChange={(offsetMonths) => set({ date: { ...content.date, offsetMonths } })} />
      </div>}
      {content.mode === 'serial' && <label className="field"><span className="field-label">Starting serial number</span>
        <input value={content.serial?.start || ''} onChange={(e) => set({ serial: { ...content.serial, start: e.target.value } })} data-testid="edit-text-serial" />
      </label>}
      {content.mode === 'prompt' && <label className="field"><span className="field-label">Prompt name</span>
        <input value={content.prompt || ''} list="text-editor-prompts" onChange={(e) => set({ prompt: e.target.value })} data-testid="edit-text-prompt" />
        <datalist id="text-editor-prompts">{Object.keys(prompts).map((n) => <option key={n} value={n} />)}</datalist>
      </label>}
      {error && <p className="hint error" role="alert">{error}</p>}
      <p className="text-edit-note">Current label preview: <b>{preview || '(empty)'}</b></p>
    </div>
  </Modal>;
}
