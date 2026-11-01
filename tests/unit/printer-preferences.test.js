import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { openPrinterPreferences } = require('../../electron/printer-preferences.cjs');

const getPrinters = async () => [{ name: 'Xprinter XP-470B' }];
test('opens real Windows printer driver preferences for exact installed printer', async () => {
  let launched;
  const launch = (exe, args, opts) => {
    launched = { exe, args, opts };
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  assert.deepEqual(await openPrinterPreferences('Xprinter XP-470B', { platform: 'win32', getPrinters, launch }),
    { opened: true, printerName: 'Xprinter XP-470B' });
  assert.equal(launched.exe, 'rundll32.exe');
  assert.deepEqual(launched.args, ['printui.dll,PrintUIEntry', '/e', '/n', 'Xprinter XP-470B']);
  assert.equal(launched.opts.stdio, 'ignore');
});
test('refuses simulated/unknown printers, unsupported OS, malformed names', async () => {
  const launch = () => { throw new Error('must not launch'); };
  for (const name of ['Wrong', 'Xprinter XP-470B" /dl', 'Xprinter\nXP']) {
    await assert.rejects(() => openPrinterPreferences(name, { platform: 'win32', getPrinters, launch }));
  }
  await assert.rejects(() => openPrinterPreferences('Xprinter XP-470B', { platform: 'linux', getPrinters, launch }), /Windows/);
});
test('surfaces OS launch errors instead of pretending preferences opened', async () => {
  const launch = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('missing rundll32')));
    return child;
  };
  await assert.rejects(() => openPrinterPreferences('Xprinter XP-470B', { platform: 'win32', getPrinters, launch }), /missing rundll32/);
});
