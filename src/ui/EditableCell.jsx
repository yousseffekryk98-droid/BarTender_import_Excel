import React, { useEffect, useRef, useState } from 'react';

// Reusable inline editor: no changes to the source workbook; commit on Enter/blur.
export default function EditableCell({ value, onCommit, testId }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));
  const cancel = useRef(false);
  const input = useRef(null);
  useEffect(() => { if (!editing) setDraft(String(value ?? '')); }, [value, editing]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  function save() {
    setEditing(false);
    if (!cancel.current && draft !== String(value ?? '')) onCommit(draft);
    cancel.current = false;
  }
  if (editing) return <input ref={input} className="cell-inline-input" value={draft}
    data-testid={testId} aria-label="Edit Excel cell"
    onClick={(e) => e.stopPropagation()}
    onChange={(e) => setDraft(e.target.value)}
    onBlur={save}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.current?.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel.current = true; input.current?.blur(); }
    }} />;
  return <button type="button" className="cell-edit-trigger" title="Double-click to edit this cell"
    data-testid={testId} onClick={(e) => e.stopPropagation()}
    onDoubleClick={(e) => { e.stopPropagation(); setDraft(String(value ?? '')); setEditing(true); }}>
    {String(value ?? '') || '\u00a0'}
  </button>;
}
