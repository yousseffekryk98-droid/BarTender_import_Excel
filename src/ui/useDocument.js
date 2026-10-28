// Document state for the designer: template, undo/redo, selection and clipboard.
import { useCallback, useMemo, useRef, useState } from 'react';
import { sanitizeTemplate, newId } from '../engine/schema.js';

const LIMIT = 200;

export function useDocument(initial) {
  const [state, setState] = useState(() => ({
    template: initial, savedJson: JSON.stringify(initial), baseRevision: initial.revision, storedId: null,
    past: [], future: [], coalesce: null, selection: []
  }));
  const clipboard = useRef(null);

  const update = useCallback((fn, options = {}) => {
    setState((s) => {
      const draft = fn(s.template);
      if (!draft || draft === s.template) return s;
      let next;
      try { next = sanitizeTemplate(draft); } catch { return s; }
      if (!next) return s;
      // keep identity fields stable; sanitizing must not change them
      next.revision = s.template.revision; next.createdAt = s.template.createdAt; next.updatedAt = s.template.updatedAt;
      const coalesce = options.coalesce && options.coalesce === s.coalesce;
      const past = coalesce ? s.past : [...s.past, s.template].slice(-LIMIT);
      const ids = new Set(next.objects.map((o) => o.id));
      return { ...s, template: next, past, future: [], coalesce: options.coalesce || null, selection: s.selection.filter((id) => ids.has(id)) };
    });
  }, []);

  const endCoalesce = useCallback(() => setState((s) => (s.coalesce ? { ...s, coalesce: null } : s)), []);

  const undo = useCallback(() => setState((s) => {
    if (!s.past.length) return s;
    const previous = s.past[s.past.length - 1];
    const ids = new Set(previous.objects.map((o) => o.id));
    return { ...s, template: previous, past: s.past.slice(0, -1), future: [s.template, ...s.future], coalesce: null, selection: s.selection.filter((id) => ids.has(id)) };
  }), []);

  const redo = useCallback(() => setState((s) => {
    if (!s.future.length) return s;
    const [next, ...rest] = s.future;
    const ids = new Set(next.objects.map((o) => o.id));
    return { ...s, template: next, past: [...s.past, s.template], future: rest, coalesce: null, selection: s.selection.filter((id) => ids.has(id)) };
  }), []);

  /** Replace the whole document (open/new). `stored` marks it as saved. */
  const load = useCallback((template, { stored = false } = {}) => {
    setState({ template, savedJson: stored ? JSON.stringify(template) : '', baseRevision: stored ? template.revision : null, storedId: stored ? template.id : null, past: [], future: [], coalesce: null, selection: [] });
  }, []);

  /** After a successful save: adopt stored revision without touching undo history. */
  const markSaved = useCallback((saved) => {
    setState((s) => {
      const template = { ...s.template, id: saved.id, revision: saved.revision, updatedAt: saved.updatedAt, createdAt: saved.createdAt, serialState: saved.serialState, name: saved.name, category: saved.category, description: saved.description, tags: saved.tags };
      return { ...s, template, savedJson: JSON.stringify(template), baseRevision: saved.revision, storedId: saved.id };
    });
  }, []);

  /** Update stored-only fields (e.g. serial continuation after printing) without dirtying the document. */
  const patchStored = useCallback((saved) => {
    setState((s) => {
      const wasClean = s.savedJson === JSON.stringify(s.template);
      const template = { ...s.template, revision: saved.revision, updatedAt: saved.updatedAt, serialState: saved.serialState };
      return { ...s, template, baseRevision: saved.revision, savedJson: wasClean ? JSON.stringify(template) : s.savedJson };
    });
  }, []);

  const select = useCallback((ids, mode = 'replace') => setState((s) => {
    const list = Array.isArray(ids) ? ids : [ids];
    let selection;
    if (mode === 'toggle') { const set = new Set(s.selection); for (const id of list) { if (set.has(id)) set.delete(id); else set.add(id); } selection = [...set]; }
    else if (mode === 'add') selection = [...new Set([...s.selection, ...list])];
    else selection = list.filter(Boolean);
    return { ...s, selection };
  }), []);

  const dirty = useMemo(() => state.savedJson !== JSON.stringify(state.template), [state.savedJson, state.template]);

  // ---------- object operations ----------
  const selected = useMemo(() => state.template.objects.filter((o) => state.selection.includes(o.id)), [state.template, state.selection]);

  const patchObjects = useCallback((ids, patch, options) => update((t) => ({
    ...t, objects: t.objects.map((o) => (ids.includes(o.id) ? deepMerge(o, typeof patch === 'function' ? patch(o) : patch) : o))
  }), options), [update]);

  const addObjects = useCallback((objects) => {
    update((t) => ({ ...t, objects: [...t.objects, ...objects] }));
    setState((s) => ({ ...s, selection: objects.map((o) => o.id) }));
  }, [update]);

  const removeSelected = useCallback(() => {
    const ids = new Set(state.selection);
    if (!ids.size) return;
    update((t) => ({ ...t, objects: t.objects.filter((o) => !ids.has(o.id) || o.locked) }));
  }, [state.selection, update]);

  const copy = useCallback(() => { if (selected.length) clipboard.current = JSON.parse(JSON.stringify(selected)); return selected.length; }, [selected]);
  const cut = useCallback(() => { const n = copy(); if (n) removeSelected(); return n; }, [copy, removeSelected]);
  const paste = useCallback((offset = 2) => {
    if (!clipboard.current?.length) return 0;
    const groupMap = new Map();
    const objects = clipboard.current.map((o) => {
      const groupId = o.groupId ? (groupMap.get(o.groupId) || groupMap.set(o.groupId, newId('grp')).get(o.groupId)) : '';
      return { ...JSON.parse(JSON.stringify(o)), id: newId(o.type), x: o.x + offset, y: o.y + offset, groupId, locked: false };
    });
    clipboard.current = objects.map((o) => ({ ...o }));
    addObjects(objects);
    return objects.length;
  }, [addObjects]);
  const duplicate = useCallback(() => { if (copy()) paste(2); }, [copy, paste]);

  return {
    template: state.template, selection: state.selection, selected, dirty, baseRevision: state.baseRevision, storedId: state.storedId,
    canUndo: state.past.length > 0, canRedo: state.future.length > 0,
    update, endCoalesce, undo, redo, load, markSaved, patchStored, select, patchObjects, addObjects, removeSelected,
    copy, cut, paste, duplicate, hasClipboard: () => Boolean(clipboard.current?.length)
  };
}

export function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(target) ? [...target] : { ...(target || {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && target && typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])
      ? deepMerge(target[key], value) : value;
  }
  return out;
}
