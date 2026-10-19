// Print-job planning: record filtering/sorting, quantities, label expansion,
// serial continuation, template selection and batching. Pure functions.

import { resolveColumn, matchesOperator, missingFields, serialValue } from './binding.js';
import { toNumber, parseDateValue } from './format.js';

export const MAX_COPIES_PER_RECORD = 100_000;
export const MAX_LABELS_PER_JOB = 200_000;
export const CONFIRM_LABELS_ABOVE = 1_000;
export const SPOOL_CHUNK = 250;

export function applyFilters(records, headers, filters = []) {
  const active = (filters || []).filter((f) => f && f.field);
  if (!active.length) return records;
  const indexes = active.map((f) => resolveColumn(headers, f.field));
  return records.filter((record) => active.every((filter, i) =>
    matchesOperator(indexes[i] < 0 ? '' : record.cells[indexes[i]], filter.op, filter.value)));
}

export function sortRecords(records, headers, sort = []) {
  const keys = (sort || []).map((s) => ({ index: resolveColumn(headers, s.field), dir: s.dir === 'desc' ? -1 : 1 })).filter((k) => k.index >= 0);
  if (!keys.length) return records;
  const collator = new Intl.Collator(['en', 'ar'], { numeric: true, sensitivity: 'base' });
  const compareCell = (a, b) => {
    const x = String(a ?? ''); const y = String(b ?? '');
    if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
    const nx = toNumber(x); const ny = toNumber(y);
    if (nx !== null && ny !== null) return nx - ny;
    const dx = /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/.test(x) ? parseDateValue(x) : null;
    const dy = dx ? parseDateValue(y) : null;
    if (dx && dy) return dx - dy;
    return collator.compare(x, y);
  };
  return records.map((record, order) => ({ record, order })).sort((a, b) => {
    for (const key of keys) {
      const c = compareCell(a.record.cells[key.index], b.record.cells[key.index]);
      if (c) return c * key.dir;
    }
    return a.order - b.order;
  }).map((x) => x.record);
}

export function searchRecords(records, query) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q) return records;
  return records.filter((record) => record.cells.some((cell) => String(cell).toLocaleLowerCase().includes(q)));
}

/** Parse a quantity cell. Returns { copies, problem } — never guesses a value. */
export function parseQuantity(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { copies: 0, problem: '' };
  const n = toNumber(raw);
  if (n === null || !Number.isFinite(n)) return { copies: 0, problem: 'Quantity "' + raw.slice(0, 30) + '" is not a number' };
  if (!Number.isInteger(n)) return { copies: 0, problem: 'Quantity ' + raw + ' is not a whole number' };
  if (n < 0) return { copies: 0, problem: 'Quantity ' + raw + ' is negative' };
  if (n > MAX_COPIES_PER_RECORD) return { copies: 0, problem: 'Quantity ' + raw + ' exceeds the per-row limit of ' + MAX_COPIES_PER_RECORD.toLocaleString('en-US') };
  return { copies: n, problem: '' };
}

/**
 * Plan a print job.
 * options: { template, headers, records (already filtered/sorted, in print order), selectedIds: Set|null,
 *            copies (fixed copies per record, default template.page.copies), quantityField, ignoreQuantity,
 *            allowMissing }
 * Returns { entries: [{ record, recordIndex, copies }], total, zeroQuantity, problems, missing, blocking }
 */
export function planJob(options) {
  const { template, headers = [], records = [] } = options;
  const selected = options.selectedIds instanceof Set ? options.selectedIds : null;
  const missing = headers.length || records.length ? missingFields(template, headers) : [];
  const quantityField = options.ignoreQuantity ? '' : (options.quantityField ?? (template.data?.quantityMode === 'field' ? template.data.quantityField : ''));
  const qIndex = quantityField ? resolveColumn(headers, quantityField) : -1;
  const fixed = Math.max(1, Math.min(MAX_COPIES_PER_RECORD, Math.round(Number(options.copies ?? template.page?.copies ?? 1)) || 1));
  const entries = [];
  const problems = [];
  let zeroQuantity = 0;
  let total = 0;
  const chosen = selected ? records.filter((r) => selected.has(r.id)) : records;
  chosen.forEach((record, recordIndex) => {
    let copies = fixed;
    if (quantityField) {
      if (qIndex < 0) return;
      const q = parseQuantity(record.cells[qIndex]);
      if (q.problem) { problems.push({ rowNumber: record.rowNumber ?? record.id, message: q.problem }); return; }
      if (q.copies === 0) { zeroQuantity++; return; }
      copies = q.copies * (options.multiplyByCopies ? fixed : 1);
    }
    entries.push({ record, recordIndex, copies });
    total += copies;
  });
  const blocking = [];
  if (missing.length && !options.allowMissing) {
    blocking.push(...missing.map((m) => (m.reason === 'ambiguous'
      ? 'Column "' + m.field + '" appears more than once in the sheet. Rename the duplicate headings.'
      : 'Column "' + m.field + '" was not found in the data (used by ' + (m.objects.join(', ') || 'template') + ').')));
  }
  if (quantityField && qIndex < 0) blocking.push('Quantity column "' + quantityField + '" was not found.');
  if (problems.length) blocking.push(problems.length + ' row(s) have an invalid quantity. Fix them or print without the quantity column.');
  if (total > MAX_LABELS_PER_JOB) blocking.push('This job has ' + total.toLocaleString('en-US') + ' labels; the limit per job is ' + MAX_LABELS_PER_JOB.toLocaleString('en-US') + '. Select fewer rows.');
  if (!total && !blocking.length) blocking.push(chosen.length ? 'Every selected row has quantity 0 or blank — nothing to print.' : 'No rows are selected.');
  return { entries, total, zeroQuantity, problems, missing, blocking, needsConfirmation: total > CONFIRM_LABELS_ABOVE, quantityField };
}

/**
 * Iterate labels of a planned job, optionally a slice [start, end).
 * Yields { record, recordIndex, copyNumber, copies, labelIndex }.
 */
export function* iterateLabels(plan, start = 0, end = Infinity) {
  let labelIndex = 0;
  for (const entry of plan.entries) {
    if (labelIndex + entry.copies <= start) { labelIndex += entry.copies; continue; }
    for (let copy = 0; copy < entry.copies; copy++, labelIndex++) {
      if (labelIndex < start) continue;
      if (labelIndex >= end) return;
      yield { record: entry.record, recordIndex: entry.recordIndex, copyNumber: copy + 1, copies: entry.copies, labelIndex };
    }
  }
}

export function chunkRanges(total, size = SPOOL_CHUNK) {
  const ranges = [];
  for (let start = 0; start < total; start += size) ranges.push([start, Math.min(total, start + size)]);
  return ranges;
}

/** Serial objects that continue from the last printed value, and the values to store after a job. */
export function serialStartsFor(template) {
  const starts = {};
  for (const object of template.objects || []) {
    const serial = object.content?.mode === 'serial' ? object.content.serial : null;
    if (serial?.continueFromLast && template.serialState?.[object.id]) starts[object.id] = template.serialState[object.id];
  }
  return starts;
}

export function serialStateAfter(template, plan, starts = serialStartsFor(template)) {
  const state = { ...(template.serialState || {}) };
  for (const object of template.objects || []) {
    const serial = object.content?.mode === 'serial' ? object.content.serial : null;
    if (!serial?.continueFromLast) continue;
    const steps = serial.perCopy === false ? plan.entries.length : plan.total;
    state[object.id] = serialValue(serial, steps, starts[object.id]);
  }
  return state;
}

/**
 * Data-driven template selection: choose a template id per record.
 * selector = { field, cases: [{ op, value, templateId }], defaultTemplateId }
 */
export function selectTemplateId(selector, headers, record) {
  if (!selector?.field) return selector?.defaultTemplateId || '';
  const index = resolveColumn(headers, selector.field);
  const cell = index < 0 ? '' : record.cells[index];
  const match = (selector.cases || []).find((c) => matchesOperator(cell, c.op || 'equals', c.value));
  return match?.templateId || selector.defaultTemplateId || '';
}

export function groupByTemplate(selector, headers, records) {
  const groups = new Map();
  const unmatched = [];
  for (const record of records) {
    const id = selectTemplateId(selector, headers, record);
    if (!id) { unmatched.push(record); continue; }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  return { groups, unmatched };
}
