// Windows manages printer pairing; this verifies the installed queue and saves its selection.
export async function connectWindowsPrinter({ printerName, listPrinters, saveDefault }) {
  if (typeof printerName !== 'string' || !printerName.trim()) throw new Error('Select a printer first.');
  const printers = await listPrinters(true);
  const printer = printers.find((item) => item.name === printerName);
  if (!printer) throw new Error('Printer "' + printerName + '" was not found in Windows. Connect and power on the printer, install its driver, and add it in Windows Settings → Bluetooth & devices → Printers & scanners.');
  if (printer.blocking) throw new Error('Windows reports a problem with "' + printer.displayName + '": ' + (printer.problems?.join(', ') || printer.status) + '. Check power, cabling, paper and the Windows printer queue.');
  await saveDefault(printer.name);
  return { printer, printers };
}
export function printerConnectionMessage(printer) {
  if (printer.status === 'unknown' || printer.status === 'other') return { kind: 'warn', text: '"' + printer.displayName + '" selected and saved, but Windows could not confirm its status. Use Test print to confirm the device is reachable.' };
  if (printer.problems?.length) return { kind: 'warn', text: '"' + printer.displayName + '" selected and saved. Windows reports: ' + printer.problems.join(', ') + '. Use Test print to confirm it works.' };
  return { kind: 'ok', text: '"' + printer.displayName + '" selected and saved. Windows reports "' + printer.status + '". Use Test print to verify that physical labels print.' };
}
