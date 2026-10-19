'use strict';
// Printer status: Windows WMI (Win32_Printer) via PowerShell, plus CUPS options on Linux/macOS.
// No user input ever reaches the command line; the whole printer list is queried and parsed.

const { execFile } = require('node:child_process');

const WIN_PRINTER_STATUS = { 1: 'other', 2: 'unknown', 3: 'idle', 4: 'printing', 5: 'warming up', 6: 'stopped', 7: 'offline' };
const WIN_ERROR_STATE = {
  3: 'Low paper', 4: 'Out of paper / labels', 5: 'Low toner/ribbon', 6: 'Out of toner/ribbon', 7: 'Door/cover open',
  8: 'Paper jam', 9: 'Offline', 10: 'Service requested', 11: 'Output bin full'
};
const CUPS_REASONS = {
  'offline-report': 'Offline', 'media-empty': 'Out of paper / labels', 'media-jam': 'Paper jam', 'door-open': 'Door/cover open',
  'toner-empty': 'Out of toner/ribbon', 'marker-supply-empty': 'Out of ribbon', 'paused': 'Paused', 'stopped': 'Stopped', 'connecting-to-device': 'Connecting'
};

/** Interpret one Win32_Printer record. */
function interpretWindows(record) {
  const problems = [];
  if (record.WorkOffline) problems.push('Printer is set to "Use printer offline"');
  const status = Number(record.PrinterStatus);
  if (status === 7) problems.push('Offline');
  if (status === 6) problems.push('Stopped');
  const error = Number(record.DetectedErrorState);
  if (WIN_ERROR_STATE[error] && !problems.includes(WIN_ERROR_STATE[error])) problems.push(WIN_ERROR_STATE[error]);
  return {
    state: WIN_PRINTER_STATUS[status] || 'unknown',
    problems,
    blocking: problems.some((p) => /offline|stopped|out of|jam|open/i.test(p))
  };
}

/** Interpret Electron/CUPS printer options (Linux, macOS). */
function interpretOptions(options = {}) {
  const problems = [];
  const state = String(options['printer-state'] || '');
  if (state === '5') problems.push('Stopped');
  for (const reason of String(options['printer-state-reasons'] || '').split(',').map((r) => r.trim().replace(/-(error|warning)$/, ''))) {
    const key = Object.keys(CUPS_REASONS).find((k) => reason.startsWith(k));
    if (key && !problems.includes(CUPS_REASONS[key])) problems.push(CUPS_REASONS[key]);
  }
  return { state: { 3: 'idle', 4: 'printing', 5: 'stopped' }[state] || 'unknown', problems, blocking: problems.some((p) => /offline|stopped|out of|jam|open/i.test(p)) };
}

let cache = { at: 0, data: null };

function queryWindows(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const script = 'Get-CimInstance -ClassName Win32_Printer | Select-Object Name,PrinterStatus,WorkOffline,DetectedErrorState | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const map = new Map();
          for (const r of list) if (r && r.Name) map.set(String(r.Name), interpretWindows(r));
          resolve(map);
        } catch { resolve(null); }
      });
  });
}

/**
 * Status for every printer. Returns Map(name → { state, problems, blocking }) — may be empty when unavailable.
 */
async function printerStatuses(printers, { platform = process.platform, force = false } = {}) {
  if (platform === 'win32') {
    if (!force && cache.data && Date.now() - cache.at < 8000) return cache.data;
    const map = (await queryWindows()) || new Map();
    cache = { at: Date.now(), data: map };
    return map;
  }
  const map = new Map();
  for (const p of printers || []) map.set(p.name, interpretOptions(p.options || {}));
  return map;
}

module.exports = { printerStatuses, interpretWindows, interpretOptions };
