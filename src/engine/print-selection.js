// Select print rows without removing them from the editable print grid.
// All modes honor unchecked rows. IDs are compared as strings for imported files.
export function selectPrintableRecords(rows, checkedIds, scope = 'selected', previewId = null, range = {}) {
  const selected = rows.filter((row) => checkedIds.has(row.id));
  if (scope === 'current') return selected.filter((row) => row.id === previewId).slice(0, 1);
  if (scope === 'range') return selected.filter((row) =>
    row.rowNumber >= Number(range.from) && row.rowNumber <= Number(range.to));
  return selected;
}
