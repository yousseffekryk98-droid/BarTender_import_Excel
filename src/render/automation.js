// Handles render requests from the automation service (watch folders / local API).
// Uses exactly the same import, validation and rendering code as manual printing.

import { readSpreadsheet } from '../data/importers.js';
import { normalizeTable } from '../data/table.js';
import { sanitizeTemplate } from '../engine/schema.js';
import { applyFilters, sortRecords, planJob } from '../engine/jobs.js';
import { validateJob, buildChunks, paperSize } from './pipeline.js';

function pickSheet(result, sheetName) {
  const populated = result.sheets.filter((s) => s.table?.records.length);
  if (sheetName) {
    const wanted = sheetName.trim().toLocaleLowerCase();
    const match = result.sheets.find((s) => s.name.trim().toLocaleLowerCase() === wanted);
    if (!match) throw new Error('Sheet "' + sheetName + '" was not found. Sheets in the file: ' + result.sheets.map((s) => s.name).join(', '));
    return match;
  }
  return populated[0];
}

export async function handleAutomationRender(request) {
  const template = sanitizeTemplate(request.template);
  if (!template) return { ok: false, error: 'The template is invalid.' };
  let headers; let records;
  if (request.file) {
    const result = await readSpreadsheet({ name: request.file.name, size: request.file.bytes.length, bytes: request.file.bytes });
    const sheet = pickSheet(result, request.sheetName);
    const table = template.data.headerRow > 1 ? normalizeTable(sheet.name, sheet.grid, { meta: sheet.meta, headerIndex: template.data.headerRow - 1 }) : sheet.table;
    headers = table.headers; records = table.records;
    const errors = table.warnings.filter((w) => w.level === 'error');
    if (errors.length) return { ok: false, error: errors.map((w) => w.message).join(' ') };
  } else if (typeof request.csv === 'string') {
    const bytes = new TextEncoder().encode(request.csv);
    const result = await readSpreadsheet({ name: 'api.csv', size: bytes.length, bytes });
    headers = result.sheets[0].table.headers; records = result.sheets[0].table.records;
  } else {
    const grid = [request.headers || [], ...(request.rows || [])];
    const table = normalizeTable('API', grid, { headerIndex: 0 });
    if (!table) return { ok: false, error: 'No records were provided.' };
    headers = table.headers; records = table.records;
  }
  const filtered = sortRecords(applyFilters(records, headers, template.data.filters), headers, template.data.sort);
  const plan = planJob({ template, headers, records: filtered, quantityField: request.quantityField || undefined, copies: request.copies });
  if (plan.blocking.length) return { ok: false, error: plan.blocking.join(' ') };
  const maxLabels = Number(request.maxLabels) || 1000;
  if (plan.total > maxLabels) return { ok: false, error: 'The data would print ' + plan.total + ' labels, more than this automation allows (' + maxLabels + '). Raise the limit in the rule if this is intended.' };
  const missingPrompts = template.prompts.filter((p) => p.required && !String(request.prompts?.[p.name] ?? p.default ?? '').trim()).map((p) => p.name);
  if (missingPrompts.length) return { ok: false, error: 'Required prompt value(s) missing: ' + missingPrompts.join(', ') };
  const prompts = Object.fromEntries(template.prompts.map((p) => [p.name, request.prompts?.[p.name] ?? p.default]));
  const check = await validateJob({ template, plan, headers, prompts, limit: Math.min(plan.total, 20000) });
  const problems = [...check.errors, ...check.barcodeErrors];
  if (problems.length) return { ok: false, error: problems.slice(0, 5).join(' | ') };
  const warnings = check.clipped.slice(0, 10);
  if (request.dryRun) return { ok: true, total: plan.total, warnings };
  const chunks = [];
  await buildChunks({ template, plan, headers, prompts, onChunk: async (chunk) => { chunks.push({ html: chunk.html, labelCount: chunk.labelCount }); } });
  return { ok: true, total: plan.total, warnings, chunks, paper: paperSize(template.page) };
}
