import test from 'node:test';
import assert from 'node:assert/strict';
import { connectWindowsPrinter, printerConnectionMessage } from '../../src/platform/printer-connection.js';

test('selects a Windows printer using a fresh scan and saves default', async () => {
  let forced = false, saved = '';
  const printer = { name: 'Zebra ZD', displayName: 'Zebra ZD', status: 'idle', blocking: false, problems: [] };
  const result = await connectWindowsPrinter({ printerName: 'Zebra ZD', listPrinters: async (f) => { forced = f; return [printer]; }, saveDefault: async (n) => { saved = n; } });
  assert.equal(forced, true); assert.equal(result.printer, printer); assert.equal(saved, 'Zebra ZD');
  assert.match(printerConnectionMessage(printer).text, /Test print/);
});
test('does not save printer missing from Windows', async () => {
  let saved = false;
  await assert.rejects(connectWindowsPrinter({ printerName: 'Missing', listPrinters: async () => [], saveDefault: async () => { saved = true; } }), /not found in Windows/);
  assert.equal(saved, false);
});
test('blocks printers Windows says are offline', async () => {
  let saved = false;
  await assert.rejects(connectWindowsPrinter({ printerName: 'Offline', listPrinters: async () => [{ name: 'Offline', displayName: 'Offline', status: 'offline', blocking: true, problems: ['Offline'] }], saveDefault: async () => { saved = true; } }), /reports a problem/);
  assert.equal(saved, false);
});
test('unknown Windows hardware status is not a confirmed connection', () => {
  const result = printerConnectionMessage({ displayName: 'Label', status: 'unknown', problems: [] });
  assert.equal(result.kind, 'warn'); assert.match(result.text, /could not confirm/);
});
