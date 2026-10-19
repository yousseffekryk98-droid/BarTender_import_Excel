'use strict';
// Validation helpers for IPC payloads coming from the renderer. The renderer is treated as
// untrusted: every handler validates shape, type and size before doing anything.

class IpcValidationError extends Error {
  constructor(message) { super(message); this.name = 'IpcValidationError'; }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function str(value, name, { max = 1000, min = 0, pattern } = {}) {
  if (typeof value !== 'string') throw new IpcValidationError(name + ' must be text.');
  if (value.length < min || value.length > max) throw new IpcValidationError(name + ' has an invalid length.');
  if (pattern && !pattern.test(value)) throw new IpcValidationError(name + ' has an invalid format.');
  return value;
}

function optStr(value, name, opts) { return value === undefined || value === null ? '' : str(value, name, opts); }

function num(value, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new IpcValidationError(name + ' is out of range.');
  return n;
}

function obj(value, name, { maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!isObject(value)) throw new IpcValidationError(name + ' must be an object.');
  // structured-clone payloads are already plain data; enforce a size budget
  let size = 0;
  try { size = JSON.stringify(value).length; } catch { throw new IpcValidationError(name + ' is not serialisable.'); }
  if (size > maxBytes) throw new IpcValidationError(name + ' is too large.');
  return value;
}

const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(value) {
  obj(value, 'page', { maxBytes: 10_000 });
  return { width: num(value.width, 'page width', { min: 5, max: 1200 }), height: num(value.height, 'page height', { min: 5, max: 1200 }) };
}

function printRequest(value) {
  obj(value, 'print request', { maxBytes: 45 * 1024 * 1024 });
  return {
    html: str(value.html, 'document', { min: 20, max: 40 * 1024 * 1024 }),
    page: page(value.page),
    printerName: optStr(value.printerName, 'printer', { max: 300 }),
    showDialog: Boolean(value.showDialog),
    ignoreStatus: Boolean(value.ignoreStatus),
    jobId: value.jobId === undefined ? undefined : str(value.jobId, 'job id', { pattern: UUID }),
    chunkIndex: num(value.chunkIndex ?? 0, 'chunk index', { min: 0, max: 100_000, integer: true }),
    chunkCount: num(value.chunkCount ?? 1, 'chunk count', { min: 1, max: 100_000, integer: true }),
    labelCount: num(value.labelCount ?? 0, 'label count', { min: 0, max: 1_000_000, integer: true }),
    meta: isObject(value.meta) ? obj(value.meta, 'meta', { maxBytes: 200_000 }) : {}
  };
}

const SETTINGS_KEYS = {
  keepPrintHistory: 'boolean', keepReprintData: 'boolean', autosaveSeconds: 'number', defaultPrinter: 'string',
  dateOrder: 'string', uiLanguage: 'string', theme: 'string', units: 'string', showGrid: 'boolean', snapToGrid: 'boolean',
  gridSize: 'number', confirmLargeJobs: 'boolean', lastTemplateId: 'string', legacyMigrated: 'boolean', panelSizes: 'object',
  fonts: 'object'
};

function settingsPatch(value) {
  obj(value, 'settings', { maxBytes: 200_000 });
  const out = {};
  for (const [key, type] of Object.entries(SETTINGS_KEYS)) {
    if (!(key in value)) continue;
    const v = value[key];
    if (type === 'object' ? !isObject(v) && !Array.isArray(v) : typeof v !== type) throw new IpcValidationError('Setting ' + key + ' has the wrong type.');
    if (type === 'string' && v.length > 300) throw new IpcValidationError('Setting ' + key + ' is too long.');
    if (type === 'number' && !Number.isFinite(v)) throw new IpcValidationError('Setting ' + key + ' must be a number.');
    out[key] = v;
  }
  return out;
}

module.exports = { IpcValidationError, str, optStr, num, obj, page, printRequest, settingsPatch, TEMPLATE_ID, UUID, isObject };
