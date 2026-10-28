// Non-destructive edits of imported data; source Excel files are never modified.
export function removeWorkingRows(table, ids) {
  const set = new Set([...ids].map(String));
  return { ...table, records: table.records.filter((r) => !set.has(String(r.id))) };
}
export function removeWorkingColumn(table, index) {
  if (!Number.isInteger(index) || index < 0 || index >= table.headers.length) throw new Error('Invalid Excel column.');
  return { ...table, headers: table.headers.filter((_, i) => i !== index),
    records: table.records.map((r) => ({ ...r, cells: r.cells.filter((_, i) => i !== index), raw: r.raw.filter((_, i) => i !== index) })) };
}
export function editWorkingRow(table, rowId, cells, labelOverrides = {}) {
  const index = table.records.findIndex((r) => String(r.id) === String(rowId));
  if (index < 0) throw new Error('Row no longer exists.');
  if (!Array.isArray(cells) || cells.length !== table.headers.length) throw new Error('Columns changed. Reopen the editor.');
  const prev = table.records[index];
  const values = cells.map((v) => String(v ?? ''));
  const raw = values.map((v, i) => v === prev.cells[i] ? prev.raw[i] : null);
  const overrides = Object.fromEntries(Object.entries(labelOverrides)
    .filter(([id, value]) => id && typeof value === 'string')
    .map(([id, value]) => [id, value.slice(0, 5000)]));
  return { ...table, records: table.records.map((r, i) => i === index ? { ...r, cells: values, raw, labelOverrides: overrides } : r) };
}
