// Re-map template column bindings, e.g. when a new workbook calls "Product" "Item Name".
import { headerKey } from './binding.js';

function replaceInTemplateText(text, from, to) {
  const key = headerKey(from);
  return String(text || '').replace(/\{([^{}?=][^{}]*)\}/g, (match, name) => (headerKey(name) === key ? '{' + to + '}' : match));
}

function replaceInExpression(text, from, to) {
  const key = headerKey(from);
  return String(text || '').replace(/\[([^\]]+)\]|\{([^{}?][^{}]*)\}/g, (match, a, b) => (headerKey(a ?? b) === key ? '[' + to + ']' : match));
}

function remapContent(content, from, to) {
  if (!content) return content;
  const next = { ...content };
  if (content.mode === 'field' && headerKey(content.field) === headerKey(from)) next.field = to;
  if (content.template) next.template = replaceInTemplateText(content.template, from, to).replace(/\{=([^}]*)\}/g, (m, e) => '{=' + replaceInExpression(e, from, to) + '}');
  if (content.expression) next.expression = replaceInExpression(content.expression, from, to);
  return next;
}

/** Return a copy of the template with every reference to column `from` pointing to `to`. */
export function renameField(template, from, to) {
  if (!from || !to || headerKey(from) === headerKey(to) && from === to) return template;
  const k = headerKey(from);
  const objects = template.objects.map((o) => {
    const next = { ...o };
    if (o.content) next.content = remapContent(o.content, from, to);
    if (o.type === 'table') next.cells = o.cells.map((row) => row.map((cell) => ({ ...cell, content: remapContent(cell.content, from, to) })));
    if (o.visibleIf?.kind === 'field' && headerKey(o.visibleIf.field) === k) next.visibleIf = { ...o.visibleIf, field: to };
    if (o.visibleIf?.kind === 'expression') next.visibleIf = { ...o.visibleIf, expression: replaceInExpression(o.visibleIf.expression, from, to) };
    if (o.name && headerKey(o.name) === k) next.name = to;
    return next;
  });
  const data = {
    ...template.data,
    quantityField: headerKey(template.data.quantityField) === k ? to : template.data.quantityField,
    filters: template.data.filters.map((f) => (headerKey(f.field) === k ? { ...f, field: to } : f)),
    sort: template.data.sort.map((s) => (headerKey(s.field) === k ? { ...s, field: to } : s))
  };
  return { ...template, objects, data };
}

export function applyRenames(template, renames) {
  return Object.entries(renames || {}).reduce((t, [from, to]) => (to ? renameField(t, from, to) : t), template);
}


// Deleting a working-copy column must detach ALL references in the template,
// otherwise print planning rejects the job with "Column ... was not found".
import { referencedFields } from './expression.js';

function referencesDeleted(expression, key) {
  try { return referencedFields(expression || '').some((name) => headerKey(name) === key); }
  catch { return false; } // Preserve invalid expressions so existing validation can report them.
}

function detachContent(content, key) {
  if (!content) return content;
  if (content.mode === 'field' && headerKey(content.field) === key) {
    return { ...content, mode: 'static', text: '', field: '' };
  }
  if (content.mode === 'expression' && referencesDeleted(content.expression, key)) {
    return { ...content, mode: 'static', text: '', expression: '' };
  }
  if (content.mode !== 'template') return content;
  const rewritten = String(content.template || '').replace(/(?<!\{)\{([^{}]+)\}(?!\})/g, (match, body) => {
    const name = body.trim();
    if (name.startsWith('=')) return referencesDeleted(name.slice(1), key) ? '' : match;
    return headerKey(name) === key ? '' : match;
  });
  return rewritten === content.template ? content : { ...content, template: rewritten };
}

/** Remove every dependency on a column excluded from the working import. */
export function detachDeletedField(template, field) {
  const key = headerKey(field);
  if (!key) return template;
  return {
    ...template,
    objects: template.objects.map((object) => {
      const next = { ...object };
      if (object.content) {
        next.content = detachContent(object.content, key);
        if (object.content.mode === 'field' && next.content.mode === 'static' && next.content !== object.content) {
          next.prefix = ''; next.suffix = '';
        }
      }
      if (object.type === 'table') {
        next.cells = object.cells.map((row) => row.map((cell) => ({ ...cell, content: detachContent(cell.content, key) })));
      }
      const rule = object.visibleIf;
      if (rule?.kind === 'field' && headerKey(rule.field) === key ||
          rule?.kind === 'expression' && referencesDeleted(rule.expression, key)) next.visibleIf = null;
      return next;
    }),
    data: {
      ...template.data,
      quantityField: headerKey(template.data.quantityField) === key ? '' : template.data.quantityField,
      quantityMode: headerKey(template.data.quantityField) === key ? 'fixed' : template.data.quantityMode,
      filters: template.data.filters.filter((item) => headerKey(item.field) !== key),
      sort: template.data.sort.filter((item) => headerKey(item.field) !== key)
    }
  };
}
