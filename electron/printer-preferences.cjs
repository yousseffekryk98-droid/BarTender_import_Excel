'use strict';
// Open the installed Windows printer driver's own Printing Preferences.
// Heat/darkness/density are vendor-specific settings, not Electron print() options.
const { spawn } = require('node:child_process');

async function openPrinterPreferences(printerName, { platform = process.platform, getPrinters, launch = spawn } = {}) {
  if (platform !== 'win32') throw new Error('Printer darkness settings require the Windows desktop app.');
  if (typeof printerName !== 'string' || !printerName || printerName.length > 300 || /["\r\n\0]/.test(printerName)) {
    throw new Error('Select a valid installed printer.');
  }
  if (typeof getPrinters !== 'function') throw new Error('Printer discovery is unavailable.');
  const printers = await getPrinters();
  if (!Array.isArray(printers) || !printers.some((p) => p.name === printerName)) {
    throw new Error('The selected printer is no longer installed. Refresh the printer list.');
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = launch('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', printerName], {
        windowsHide: false, detached: true, stdio: 'ignore'
      });
    } catch (error) { reject(new Error('Could not open Windows Printing Preferences: ' + error.message)); return; }
    child.once('error', (error) => reject(new Error('Could not open Windows Printing Preferences: ' + error.message)));
    child.once('spawn', () => {
      child.unref?.();
      resolve({ opened: true, printerName });
    });
  });
}

module.exports = { openPrinterPreferences };
