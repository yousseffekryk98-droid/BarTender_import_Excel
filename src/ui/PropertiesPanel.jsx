import React, { useMemo } from 'react';
import { Lock, Unlock, Eye, EyeOff, Trash2, Plus, ImagePlus, AlignLeft, AlignCenter, AlignRight, AlignJustify, Bold, Italic, Underline, Strikethrough, Printer as PrinterIcon } from 'lucide-react';
import { NumberField, TextField, SelectField, Check, ColorField, Section, IconButton, Button } from './controls.jsx';
import { SAFE_FONTS, FILTER_OPERATORS, BARCODE_TYPES } from '../engine/schema.js';
import { SYMBOLOGY_LABELS } from '../engine/barcode.js';
import { makeContext, resolveText, evaluateRule } from '../engine/binding.js';
import { FUNCTION_NAMES } from '../engine/expression.js';

export const CONTENT_MODE_OPTIONS = [
  { value: 'static', label: 'Fixed text' },
  { value: 'field', label: 'Excel column' },
  { value: 'template', label: 'Combined text  {Column}…' },
  { value: 'expression', label: 'Calculated (formula)' },
  { value: 'date', label: 'Print date / time' },
  { value: 'serial', label: 'Serial number' },
  { value: 'prompt', label: 'Ask when printing' }
];

export const OPERATOR_LABELS = {
  equals: 'equals', notEquals: 'does not equal', contains: 'contains', notContains: 'does not contain', startsWith: 'starts with', endsWith: 'ends with',
  isEmpty: 'is empty', isNotEmpty: 'is not empty', greaterThan: '>', lessThan: '<', greaterOrEqual: '≥', lessOrEqual: '≤'
};

const TYPE_NAMES = { text: 'Text', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', image: 'Image', barcode: 'Barcode / 2D code', table: 'Table' };

function FieldPicker({ label, value, onChange, fields, testId }) {
  const listId = 'fields-' + (testId || label || 'x').replace(/\W+/g, '');
  const known = fields.some((f) => f.toLocaleLowerCase() === String(value || '').toLocaleLowerCase());
  return <label className="field">
    {label && <span className="field-label">{label}</span>}
    <select value={known ? fields.find((f) => f.toLocaleLowerCase() === String(value).toLocaleLowerCase()) : (value ? '__custom' : '')} onChange={(e) => { if (e.target.value !== '__custom') onChange(e.target.value); }} data-testid={testId}>
      <option value="">— choose column —</option>
      {fields.map((f) => <option key={f} value={f}>{f}</option>)}
      {value && !known && <option value="__custom">{value} (not in current data)</option>}
    </select>
    {!fields.length && <input list={listId} placeholder="Type the Excel column name" defaultValue={value} onBlur={(e) => onChange(e.target.value.trim())} />}
    <datalist id={listId}>{fields.map((f) => <option key={f} value={f} />)}</datalist>
  </label>;
}

function InsertField({ fields, onInsert, prompts }) {
  return <select className="insert-field" value="" onChange={(e) => { if (e.target.value) onInsert(e.target.value); }} title="Insert a column or prompt">
    <option value="">+ Insert…</option>
    {fields.map((f) => <option key={'f' + f} value={'{' + f + '}'}>{f}</option>)}
    {prompts.map((p) => <option key={'p' + p.name} value={'{?' + p.name + '}'}>Prompt: {p.name}</option>)}
  </select>;
}

function ContentEditor({ object, onPatch, fields, template, previewCtx }) {
  const c = object.content;
  const set = (patch) => onPatch({ content: patch });
  let preview = ''; let previewError = '';
  try { preview = resolveText(object, previewCtx); } catch (error) { previewError = error.message; }
  return <>
    <SelectField label="Source" value={c.mode} onChange={(mode) => set({ mode })} options={CONTENT_MODE_OPTIONS} testId="content-mode" />
    {c.mode === 'static' && <TextField label="Text" value={c.text} onChange={(text) => set({ text })} multiline rows={2} testId="static-text" />}
    {c.mode === 'field' && <FieldPicker label="Excel column" value={c.field} onChange={(field) => onPatch({ content: { field }, name: object.name && object.name !== 'Text' ? object.name : field })} fields={fields} testId="field-picker" />}
    {c.mode === 'template' && <>
      <TextField label="Combined text" value={c.template} onChange={(t) => set({ template: t })} multiline rows={3} placeholder="{Product Name} – {Price} EGP" testId="template-text" />
      <InsertField fields={fields} prompts={template.prompts} onInsert={(token) => set({ template: (c.template || '') + token })} />
      <p className="hint">Use {'{Column}'} for Excel values, {'{?Prompt}'} for print-time prompts and {'{=formula}'} for calculations.</p>
    </>}
    {c.mode === 'expression' && <>
      <TextField label="Formula" value={c.expression} onChange={(expression) => set({ expression })} multiline rows={3} mono placeholder={'UPPER([Product Name]) & " " & FIXED([Price], 2)'} testId="expression" />
      <select className="insert-field" value="" onChange={(e) => { if (e.target.value) set({ expression: (c.expression || '') + e.target.value }); }}>
        <option value="">+ Insert…</option>
        {fields.map((f) => <option key={'f' + f} value={'[' + f + ']'}>Column: {f}</option>)}
        {FUNCTION_NAMES.map((fn) => <option key={fn} value={fn + '('}>{fn}()</option>)}
      </select>
    </>}
    {c.mode === 'date' && <div className="grid-2">
      <NumberField label="Add days" value={c.date.offsetDays} step={1} decimals={0} onChange={(offsetDays) => set({ date: { offsetDays } })} />
      <NumberField label="Add months" value={c.date.offsetMonths} step={1} decimals={0} onChange={(offsetMonths) => set({ date: { offsetMonths } })} />
    </div>}
    {c.mode === 'serial' && <>
      <div className="grid-2">
        <TextField label="Start value" value={c.serial.start} onChange={(start) => set({ serial: { start } })} />
        <NumberField label="Increment" value={c.serial.step} step={1} decimals={0} onChange={(step) => set({ serial: { step: step || 1 } })} />
        <SelectField label="Sequence" value={c.serial.mode} onChange={(mode) => set({ serial: { mode } })} options={[{ value: 'numeric', label: '0–9' }, { value: 'hex', label: 'Hexadecimal' }, { value: 'alpha', label: 'A–Z (A…Z, AA…)' }, { value: 'alphanumeric', label: '0–9 A–Z' }]} />
        <NumberField label="Minimum digits" value={c.serial.width} min={0} max={30} step={1} decimals={0} onChange={(width) => set({ serial: { width } })} />
      </div>
      <Check label="Increase for every copy (off: once per Excel row)" checked={c.serial.perCopy} onChange={(perCopy) => set({ serial: { perCopy } })} />
      <Check label="Continue from the last printed number" checked={c.serial.continueFromLast} onChange={(continueFromLast) => set({ serial: { continueFromLast } })} />
      {c.serial.continueFromLast && <p className="hint">Next print starts at <b>{template.serialState?.[object.id] || c.serial.start}</b>.</p>}
    </>}
    {c.mode === 'prompt' && <SelectField label="Prompt" value={c.prompt} onChange={(prompt) => set({ prompt })}
      options={[{ value: '', label: template.prompts.length ? '— choose prompt —' : 'Add a prompt in Label properties' }, ...template.prompts.map((p) => ({ value: p.name, label: p.label || p.name }))]} />}
    <div className="grid-2">
      <TextField label="Prefix" value={object.prefix} onChange={(prefix) => onPatch({ prefix })} placeholder="SN: " testId="prefix" />
      <TextField label="Suffix" value={object.suffix} onChange={(suffix) => onPatch({ suffix })} placeholder=" EGP" testId="suffix" />
    </div>
    <div className={'preview-value' + (previewError ? ' error' : '')} data-testid="content-preview"><span>Result:</span> {previewError || preview || <em>(empty)</em>}</div>
  </>;
}

function FormatEditor({ object, onPatch }) {
  const f = object.format;
  const set = (patch) => onPatch({ format: patch });
  return <>
    <SelectField label="Format" value={f.kind} onChange={(kind) => set(kind === 'currency' ? { kind, thousands: true, decimals: f.decimals ?? 2 } : { kind })} options={[
      { value: 'none', label: 'As in Excel' }, { value: 'number', label: 'Number' }, { value: 'currency', label: 'Currency' },
      { value: 'percent', label: 'Percent' }, { value: 'date', label: 'Date / time' }, { value: 'pattern', label: 'Custom pattern' }]} testId="format-kind" />
    {(f.kind === 'number' || f.kind === 'currency' || f.kind === 'percent') && <div className="grid-2">
      <NumberField label="Decimals" value={f.decimals ?? ''} min={0} max={10} step={1} decimals={0} onChange={(decimals) => set({ decimals })} />
      <Check label="Thousands separator" checked={f.thousands} onChange={(thousands) => set({ thousands })} />
      {f.kind === 'number' && <NumberField label="Min. integer digits" value={f.minInteger} min={1} max={30} step={1} decimals={0} onChange={(minInteger) => set({ minInteger })} />}
    </div>}
    {f.kind === 'currency' && <div className="grid-2">
      <TextField label="Symbol" value={f.currencySymbol} onChange={(currencySymbol) => set({ currencySymbol })} />
      <SelectField label="Position" value={f.symbolPosition} onChange={(symbolPosition) => set({ symbolPosition })} options={[{ value: 'after', label: '325.00 EGP' }, { value: 'before', label: 'EGP 325.00' }]} />
    </div>}
    {f.kind === 'date' && <>
      <SelectField label="Date pattern" value={['dd/MM/yyyy', 'dd-MM-yyyy', 'yyyy-MM-dd', 'dd MMM yyyy', 'MMMM yyyy', 'MM/yyyy', 'dd/MM/yyyy HH:mm', 'HH:mm', 'dddd dd MMMM yyyy'].includes(f.datePattern) ? f.datePattern : '__custom'}
        onChange={(v) => { if (v !== '__custom') set({ datePattern: v }); }}
        options={['dd/MM/yyyy', 'dd-MM-yyyy', 'yyyy-MM-dd', 'dd MMM yyyy', 'MMMM yyyy', 'MM/yyyy', 'dd/MM/yyyy HH:mm', 'HH:mm', 'dddd dd MMMM yyyy', { value: '__custom', label: 'Custom…' }]} />
      <TextField label="Custom pattern" value={f.datePattern} onChange={(datePattern) => set({ datePattern })} mono />
      <SelectField label="Month/day names" value={f.locale} onChange={(locale) => set({ locale })} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} />
    </>}
    {f.kind === 'pattern' && <TextField label="Pattern" value={f.pattern} onChange={(pattern) => set({ pattern })} placeholder="000000 · #,##0.00 · dd/MM/yyyy" mono />}
    <div className="grid-2">
      <SelectField label="Letter case" value={f.case} onChange={(c) => set({ case: c })} options={[{ value: 'none', label: 'Unchanged' }, { value: 'upper', label: 'UPPERCASE' }, { value: 'lower', label: 'lowercase' }, { value: 'title', label: 'Title Case' }]} />
      <SelectField label="Digits" value={f.digits} onChange={(digits) => set({ digits })} options={[{ value: 'latin', label: '0123' }, { value: 'arabic', label: '٠١٢٣' }]} />
    </div>
    <TextField label="Text when empty" value={f.emptyText} onChange={(emptyText) => set({ emptyText })} placeholder="(nothing)" />
  </>;
}

function FontEditor({ style, onPatch, fonts }) {
  const set = (patch) => onPatch({ style: patch });
  const families = [...new Set([...(fonts || []), ...SAFE_FONTS, style.fontFamily])].sort((a, b) => a.localeCompare(b));
  return <>
    <div className="grid-2">
      <SelectField label="Font" value={style.fontFamily} onChange={(fontFamily) => set({ fontFamily })} options={families} testId="font-family" />
      <NumberField label="Size" unit="pt" value={style.fontSize} min={2} max={400} step={0.5} onChange={(fontSize) => set({ fontSize })} testId="font-size" />
    </div>
    <div className="button-row">
      <IconButton icon={Bold} label="Bold" active={style.bold} onClick={() => set({ bold: !style.bold })} shortcut="Ctrl+B" testId="bold" />
      <IconButton icon={Italic} label="Italic" active={style.italic} onClick={() => set({ italic: !style.italic })} shortcut="Ctrl+I" />
      <IconButton icon={Underline} label="Underline" active={style.underline} onClick={() => set({ underline: !style.underline })} shortcut="Ctrl+U" />
      <IconButton icon={Strikethrough} label="Strikethrough" active={style.strike} onClick={() => set({ strike: !style.strike })} />
      <span className="sep" />
      <IconButton icon={AlignLeft} label="Align left" active={style.align === 'left'} onClick={() => set({ align: 'left' })} testId="align-left" />
      <IconButton icon={AlignCenter} label="Center" active={style.align === 'center'} onClick={() => set({ align: 'center' })} testId="align-center" />
      <IconButton icon={AlignRight} label="Align right" active={style.align === 'right'} onClick={() => set({ align: 'right' })} testId="align-right" />
      <IconButton icon={AlignJustify} label="Justify" active={style.align === 'justify'} onClick={() => set({ align: 'justify' })} />
    </div>
    <div className="grid-2">
      <ColorField label="Text colour" value={style.color} onChange={(color) => set({ color })} allowTransparent={false} />
      <ColorField label="Background" value={style.background} onChange={(background) => set({ background })} />
    </div>
  </>;
}

function ParagraphEditor({ style, onPatch }) {
  const set = (patch) => onPatch({ style: patch });
  return <>
    <div className="grid-2">
      <SelectField label="Vertical align" value={style.vAlign} onChange={(vAlign) => set({ vAlign })} options={[{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} testId="valign" />
      <SelectField label="Direction" value={style.direction} onChange={(direction) => set({ direction })} options={[{ value: 'auto', label: 'Automatic (mixed)' }, { value: 'ltr', label: 'Left → right' }, { value: 'rtl', label: 'Right → left (Arabic)' }]} testId="direction" />
      <NumberField label="Line spacing" value={style.lineSpacing} min={0.6} max={4} step={0.05} onChange={(lineSpacing) => set({ lineSpacing })} />
      <NumberField label="Letter spacing" unit="pt" value={style.letterSpacing} min={-2} max={10} step={0.1} onChange={(letterSpacing) => set({ letterSpacing })} />
      <NumberField label="Padding" unit="mm" value={style.padding} min={0} max={50} step={0.1} onChange={(padding) => set({ padding })} />
      <SelectField label="If text is too long" value={style.overflow} onChange={(overflow) => set({ overflow })} options={[{ value: 'shrink', label: 'Shrink to fit' }, { value: 'clip', label: 'Cut off (warn)' }, { value: 'visible', label: 'Overflow box' }]} testId="overflow" />
    </div>
    {style.overflow === 'shrink' && <NumberField label="Smallest font size" unit="pt" value={style.minFontSize} min={2} max={style.fontSize} step={0.5} onChange={(minFontSize) => set({ minFontSize })} />}
    <Check label="Wrap onto several lines" checked={style.wrap} onChange={(wrap) => set({ wrap })} testId="wrap" />
    <div className="grid-2">
      <NumberField label="Border" unit="mm" value={style.border.width} min={0} max={10} step={0.1} onChange={(width) => set({ border: { width } })} />
      <ColorField label="Border colour" value={style.border.color} onChange={(color) => set({ border: { color } })} allowTransparent={false} />
      <SelectField label="Border style" value={style.border.style} onChange={(s) => set({ border: { style: s } })} options={['solid', 'dashed', 'dotted']} />
      <NumberField label="Corner radius" unit="mm" value={style.border.radius} min={0} max={50} step={0.5} onChange={(radius) => set({ border: { radius } })} />
    </div>
  </>;
}

function StrokeEditor({ object, onPatch, fill }) {
  return <>
    <div className="grid-2">
      <NumberField label="Line width" unit="mm" value={object.stroke.width} min={0} max={20} step={0.1} onChange={(width) => onPatch({ stroke: { width } })} />
      <ColorField label="Line colour" value={object.stroke.color} onChange={(color) => onPatch({ stroke: { color } })} allowTransparent={false} />
      <SelectField label="Line style" value={object.stroke.style} onChange={(style) => onPatch({ stroke: { style } })} options={['solid', 'dashed', 'dotted']} />
      {fill && <ColorField label="Fill" value={object.fill} onChange={(f) => onPatch({ fill: f })} />}
      {object.type === 'rect' && <NumberField label="Corner radius" unit="mm" value={object.radius} min={0} max={100} step={0.5} onChange={(radius) => onPatch({ radius })} />}
      {object.type === 'line' && <SelectField label="Direction" value={object.direction} onChange={(direction) => onPatch({ direction })} options={[{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }, { value: 'diagonal-down', label: 'Diagonal ↘' }, { value: 'diagonal-up', label: 'Diagonal ↗' }]} />}
    </div>
  </>;
}

function RuleEditor({ object, onPatch, fields, previewCtx }) {
  const rule = object.visibleIf;
  const set = (next) => onPatch({ visibleIf: next }, true);
  let state = '';
  try { state = rule ? (evaluateRule(rule, previewCtx) ? 'Printed for the current record' : 'Hidden for the current record') : ''; } catch (error) { state = 'Error: ' + error.message; }
  return <>
    <SelectField label="Print this object" value={rule ? rule.kind : 'always'} onChange={(kind) => set(kind === 'always' ? null : kind === 'field' ? { kind: 'field', field: fields[0] || '', op: 'isNotEmpty', value: '' } : { kind: 'expression', expression: '' })}
      options={[{ value: 'always', label: 'Always' }, { value: 'field', label: 'Only when a column…' }, { value: 'expression', label: 'Only when a formula is true' }]} testId="visibility-mode" />
    {rule?.kind === 'field' && <>
      <FieldPicker label="Column" value={rule.field} onChange={(field) => set({ ...rule, field })} fields={fields} />
      <div className="grid-2">
        <SelectField label="Condition" value={rule.op} onChange={(op) => set({ ...rule, op })} options={FILTER_OPERATORS.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))} />
        {!['isEmpty', 'isNotEmpty'].includes(rule.op) && <TextField label="Value" value={rule.value} onChange={(value) => set({ ...rule, value })} />}
      </div>
    </>}
    {rule?.kind === 'expression' && <TextField label="Formula" value={rule.expression} onChange={(expression) => set({ ...rule, expression })} mono placeholder={'[Price] > 100'} />}
    {state && <p className={'hint' + (state.startsWith('Error') ? ' error' : '')}>{state}</p>}
  </>;
}

function TableEditor({ object, onPatch, fields }) {
  const setCell = (r, c, patch) => {
    const cells = object.cells.map((row, ri) => row.map((cell, ci) => (ri === r && ci === c ? { ...cell, ...patch, content: { ...cell.content, ...(patch.content || {}) } } : cell)));
    onPatch({ cells }, true);
  };
  return <>
    <div className="grid-2">
      <NumberField label="Rows" value={object.rows} min={1} max={40} step={1} decimals={0} onChange={(rows) => onPatch({ rows, rowHeights: Array(rows).fill(1) }, true)} />
      <NumberField label="Columns" value={object.columns} min={1} max={20} step={1} decimals={0} onChange={(columns) => onPatch({ columns, colWidths: Array(columns).fill(1) }, true)} />
    </div>
    <div className="table-cells" style={{ gridTemplateColumns: 'repeat(' + object.columns + ', 1fr)' }}>
      {object.cells.map((row, r) => row.map((cell, c) => <div key={r + '-' + c} className="table-cell-edit">
        <select value={cell.content.mode === 'field' ? 'f:' + cell.content.field : 's'} onChange={(e) => setCell(r, c, e.target.value === 's' ? { content: { mode: 'static' } } : { content: { mode: 'field', field: e.target.value.slice(2) } })}>
          <option value="s">Text</option>
          {fields.map((f) => <option key={f} value={'f:' + f}>{f}</option>)}
        </select>
        {cell.content.mode !== 'field' && <input value={cell.content.text} onChange={(e) => setCell(r, c, { content: { text: e.target.value } })} dir="auto" />}
      </div>))}
    </div>
    <StrokeEditor object={object} onPatch={onPatch} />
    <NumberField label="Font size" unit="pt" value={object.style.fontSize} min={2} max={100} step={0.5} onChange={(fontSize) => onPatch({ style: { fontSize } })} />
  </>;
}

function PromptsEditor({ template, onChange }) {
  const prompts = template.prompts;
  const set = (list) => onChange((t) => ({ ...t, prompts: list }));
  return <>
    {prompts.map((p, i) => <div key={i} className="prompt-row">
      <div className="grid-2">
        <TextField label="Name" value={p.name} onChange={(name) => set(prompts.map((x, j) => (j === i ? { ...x, name } : x)))} />
        <TextField label="Question" value={p.label} onChange={(label) => set(prompts.map((x, j) => (j === i ? { ...x, label } : x)))} />
        <SelectField label="Type" value={p.type} onChange={(type) => set(prompts.map((x, j) => (j === i ? { ...x, type } : x)))} options={[{ value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'choice', label: 'Choice list' }]} />
        <TextField label="Default" value={p.default} onChange={(d) => set(prompts.map((x, j) => (j === i ? { ...x, default: d } : x)))} />
      </div>
      {p.type === 'choice' && <TextField label="Choices (one per line)" multiline rows={3} value={p.choices.join('\n')} onChange={(text) => set(prompts.map((x, j) => (j === i ? { ...x, choices: text.split('\n').map((s) => s.trim()).filter(Boolean) } : x)))} />}
      <div className="grid-2">
        <Check label="Required" checked={p.required} onChange={(required) => set(prompts.map((x, j) => (j === i ? { ...x, required } : x)))} />
        <Button kind="ghost" icon={Trash2} onClick={() => set(prompts.filter((_, j) => j !== i))}>Remove</Button>
      </div>
    </div>)}
    <Button icon={Plus} onClick={() => set([...prompts, { name: 'Prompt' + (prompts.length + 1), label: 'Value', type: 'text', default: '', required: false, pattern: '', choices: [] }])} testId="add-prompt">Add prompt</Button>
    <p className="hint">Prompts are asked in the Print dialog. Use them in text with {'{?Name}'} or the "Ask when printing" source.</p>
  </>;
}

function PageEditor({ template, onChange, printers }) {
  const page = template.page;
  const setPage = (patch) => onChange((t) => ({ ...t, page: { ...t.page, ...patch } }));
  const setTpl = (patch) => onChange((t) => ({ ...t, ...patch }));
  return <>
    <Section title="Label">
      <TextField label="Template name" value={template.name} onChange={(name) => setTpl({ name })} testId="template-name" />
      <div className="grid-2">
        <TextField label="Category" value={template.category} onChange={(category) => setTpl({ category })} />
        <TextField label="Tags (comma separated)" value={template.tags.join(', ')} onChange={(text) => setTpl({ tags: text.split(',').map((s) => s.trim()).filter(Boolean) })} />
      </div>
      <TextField label="Description" value={template.description} onChange={(description) => setTpl({ description })} multiline rows={2} />
    </Section>
    <Section title="Size & stock">
      <div className="grid-2">
        <NumberField label="Width" unit="mm" value={page.width} min={5} max={500} step={1} onChange={(width) => setPage({ width })} testId="page-width" />
        <NumberField label="Height" unit="mm" value={page.height} min={5} max={1000} step={1} onChange={(height) => setPage({ height })} testId="page-height" />
        <NumberField label="Corner radius" unit="mm" value={page.cornerRadius} min={0} max={50} step={0.5} onChange={(cornerRadius) => setPage({ cornerRadius })} />
        <ColorField label="Background" value={page.background} onChange={(background) => setPage({ background })} allowTransparent={false} />
      </div>
      <div className="preset-row">{[[50, 25], [50, 30], [40, 30], [58, 40], [70, 40], [100, 50], [100, 150]].map(([w, h]) => <button key={w + 'x' + h} type="button" className="chip" onClick={() => setPage({ width: w, height: h })}>{w}×{h}</button>)}</div>
    </Section>
    <Section title="Printer" defaultOpen={false}>
      <SelectField label="Default printer" value={page.printerName} onChange={(printerName) => setPage({ printerName })} options={[{ value: '', label: 'Ask / Windows default' }, ...printers.map((p) => ({ value: p.name, label: p.displayName }))]} />
      <div className="grid-2">
        <SelectField label="Printer resolution" value={String(page.dpi)} onChange={(dpi) => setPage({ dpi: Number(dpi) })} options={['150', '200', '203', '300', '600'].map((d) => ({ value: d, label: d + ' dpi' }))} />
        <SelectField label="Rotate when printing" value={String(page.printRotation)} onChange={(r) => setPage({ printRotation: Number(r) })} options={['0', '90', '180', '270'].map((d) => ({ value: d, label: d + '°' }))} />
        <NumberField label="Offset X" unit="mm" value={page.offsetX} min={-20} max={20} step={0.1} onChange={(offsetX) => setPage({ offsetX })} />
        <NumberField label="Offset Y" unit="mm" value={page.offsetY} min={-20} max={20} step={0.1} onChange={(offsetY) => setPage({ offsetY })} />
        <NumberField label="Default copies" value={page.copies} min={1} max={10000} step={1} decimals={0} onChange={(copies) => setPage({ copies })} />
      </div>
      <Check label="Snap positions to printer dots" checked={page.snapToDots} onChange={(snapToDots) => setPage({ snapToDots })} />
      <p className="hint">Use offsets to correct small printer misalignment without moving objects. Rotate if your driver feeds labels sideways.</p>
    </Section>
    <Section title="Data" defaultOpen={false}>
      <SelectField label="Dates written as" value={template.data.dateOrder} onChange={(dateOrder) => onChange((t) => ({ ...t, data: { ...t.data, dateOrder } }))} options={[{ value: 'DMY', label: 'Day/Month/Year (19/10/2026)' }, { value: 'MDY', label: 'Month/Day/Year (10/19/2026)' }, { value: 'YMD', label: 'Year-Month-Day' }]} />
    </Section>
    <Section title={'Print-time prompts (' + template.prompts.length + ')'} defaultOpen={false}>
      <PromptsEditor template={template} onChange={onChange} />
    </Section>
  </>;
}

export default function PropertiesPanel({ template, selected, onPatch, onChange, fields, headers, record, prompts, printers, fonts, onPickImage, dataLoaded }) {
  const previewCtx = useMemo(() => makeContext({ headers: headers || [], record: record || { cells: [] }, prompts, placeholders: !dataLoaded, dateOrder: template.data.dateOrder }), [headers, record, prompts, dataLoaded, template.data.dateOrder]);
  if (!selected.length) return <div className="props" data-testid="properties"><PageEditor template={template} onChange={onChange} printers={printers} /></div>;
  if (selected.length > 1) {
    const texts = selected.filter((o) => o.type === 'text');
    return <div className="props" data-testid="properties">
      <Section title={selected.length + ' objects selected'}>
        <p className="hint">Use Format → Align to line them up. Changes below apply to all selected objects.</p>
        <div className="grid-2">
          <NumberField label="Y (all)" unit="mm" value={selected[0].y} step={0.5} onChange={(y) => onPatch(selected.map((o) => o.id), { y })} />
          <NumberField label="X (all)" unit="mm" value={selected[0].x} step={0.5} onChange={(x) => onPatch(selected.map((o) => o.id), { x })} />
        </div>
        {texts.length > 0 && <>
          <NumberField label={'Font size (' + texts.length + ' text)'} unit="pt" value={texts[0].style.fontSize} min={2} max={400} step={0.5} onChange={(fontSize) => onPatch(texts.map((o) => o.id), { style: { fontSize } })} />
          <SelectField label="Font" value={texts[0].style.fontFamily} onChange={(fontFamily) => onPatch(texts.map((o) => o.id), { style: { fontFamily } })} options={[...new Set([...SAFE_FONTS, ...(fonts || [])])]} />
        </>}
        <Check label="Locked" checked={selected.every((o) => o.locked)} onChange={(locked) => onPatch(selected.map((o) => o.id), { locked })} />
      </Section>
    </div>;
  }
  const o = selected[0];
  const patch = (p, replace) => onPatch([o.id], p, replace);
  return <div className="props" data-testid="properties">
    <Section title={TYPE_NAMES[o.type]} actions={<span className="head-actions">
      <IconButton icon={o.locked ? Lock : Unlock} label={o.locked ? 'Unlock' : 'Lock position'} active={o.locked} onClick={() => patch({ locked: !o.locked })} size={14} />
      <IconButton icon={o.hidden ? EyeOff : Eye} label={o.hidden ? 'Show in designer' : 'Hide in designer'} active={o.hidden} onClick={() => patch({ hidden: !o.hidden })} size={14} />
      <IconButton icon={PrinterIcon} label={o.printable ? 'Printed (click: do not print)' : 'Not printed'} active={!o.printable} onClick={() => patch({ printable: !o.printable })} size={14} />
    </span>}>
      <TextField label="Name" value={o.name} onChange={(name) => patch({ name })} testId="object-name" />
      <div className="grid-2">
        <NumberField label="X" unit="mm" value={o.x} step={0.5} onChange={(x) => patch({ x })} disabled={o.locked} testId="prop-x" />
        <NumberField label="Y" unit="mm" value={o.y} step={0.5} onChange={(y) => patch({ y })} disabled={o.locked} testId="prop-y" />
        <NumberField label="Width" unit="mm" value={o.width} min={0.1} step={0.5} onChange={(width) => patch({ width })} disabled={o.locked} testId="prop-width" />
        <NumberField label="Height" unit="mm" value={o.height} min={o.type === 'line' ? 0 : 0.1} step={0.5} onChange={(height) => patch({ height })} disabled={o.locked} testId="prop-height" />
        <NumberField label="Rotation" unit="°" value={o.rotation} min={-360} max={360} step={15} decimals={1} onChange={(rotation) => patch({ rotation })} disabled={o.locked} testId="prop-rotation" />
      </div>
    </Section>
    {(o.type === 'text' || o.type === 'barcode') && <Section title="Data source"><ContentEditor object={o} onPatch={patch} fields={fields} template={template} previewCtx={previewCtx} /></Section>}
    {o.type === 'text' && <>
      <Section title="Format"><FormatEditor object={o} onPatch={patch} /></Section>
      <Section title="Font"><FontEditor style={o.style} onPatch={patch} fonts={fonts} /></Section>
      <Section title="Paragraph & border" defaultOpen={false}><ParagraphEditor style={o.style} onPatch={patch} /></Section>
    </>}
    {o.type === 'barcode' && <Section title="Barcode">
      <SelectField label="Symbology" value={o.symbology} onChange={(symbology) => patch({ symbology })} options={BARCODE_TYPES.map((b) => ({ value: b, label: SYMBOLOGY_LABELS[b] || b }))} testId="symbology" />
      <div className="grid-2">
        <Check label="Human-readable text" checked={o.humanReadable} onChange={(humanReadable) => patch({ humanReadable })} />
        <Check label="Quiet zone" checked={o.quietZone} onChange={(quietZone) => patch({ quietZone })} />
        <NumberField label="Text size" unit="pt" value={o.textSize} min={3} max={30} step={0.5} onChange={(textSize) => patch({ textSize })} />
        <ColorField label="Colour" value={o.color} onChange={(color) => patch({ color })} allowTransparent={false} />
      </div>
      <Section title="Format" defaultOpen={false}><FormatEditor object={o} onPatch={patch} /></Section>
    </Section>}
    {(o.type === 'line' || o.type === 'rect' || o.type === 'ellipse') && <Section title="Appearance"><StrokeEditor object={o} onPatch={patch} fill={o.type !== 'line'} /></Section>}
    {o.type === 'image' && <Section title="Image">
      <Button icon={ImagePlus} onClick={() => onPickImage(o.id)} testId="choose-image">{o.src ? 'Replace image…' : 'Choose image…'}</Button>
      <SelectField label="Fit" value={o.fit} onChange={(fit) => patch({ fit })} options={[{ value: 'contain', label: 'Fit inside' }, { value: 'cover', label: 'Fill (crop)' }, { value: 'stretch', label: 'Stretch' }]} />
    </Section>}
    {o.type === 'table' && <Section title="Table"><TableEditor object={o} onPatch={patch} fields={fields} /></Section>}
    <Section title="Conditional printing" defaultOpen={Boolean(o.visibleIf)}><RuleEditor object={o} onPatch={patch} fields={fields} previewCtx={previewCtx} /></Section>
  </div>;
}
