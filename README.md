# Excel Label Studio — Text-Only Label Designer

Free, offline Windows desktop application. Import Excel products, arrange **text from any Excel columns anywhere on your label**, save the layout as a **reusable template**, then print text-only labels without BarTender.

This is an **independent** application; it does not modify BarTender or bypass any paid BarTender features.

## Windows: download or create the EXE

The commands below run in PowerShell from your cloned repository, for example:

```powershell
cd C:\Users\YOUSSEF\Desktop\freebar\BarTender_import_Excel
git pull origin main
npm install
npm test
npm run desktop:dev
```

`npm run desktop:dev` **opens the app for development**; it does **not** create an EXE installer. Close it using `Ctrl+C` in PowerShell before building.

To build both an installer EXE and a portable EXE, run:

```powershell
npm run dist:win
explorer .\release
```

Your results appear in:

```text
C:\Users\YOUSSEF\Desktop\freebar\BarTender_import_Excel\release\
```

Look for an `Excel Label Studio Setup 0.2.0.exe` **installer** and a portable `Excel Label Studio 0.2.0.exe` (exact filenames can vary slightly with electron-builder). The installer installs the app on another Windows PC; the portable EXE runs without installation. **The receiving PC does not need Node.js or BarTender**.

The Windows computer doing the build needs an internet connection for initial Electron downloads. The installed application can subsequently operate offline.

## Editing text

**Edit on the label itself:** Double-click fixed text in the preview to type directly on the paper. Click Save (or Ctrl+Enter), or press Escape to cancel. Select any text to reveal an Edit button; Excel-linked text opens its data source editor rather than losing the link.

**Your own words beside Excel values:** Click **Excel value**, choose the source column, then type words before or after it (for example "Price: " before the Price column and " EGP" after). Each printed Excel row supplies its own number. Select the row to preview in the data table, and select the rows to print in the Print dialog.

**Save a stamp:** Arrange words and dynamic fields using drag-and-drop or exact X/Y coordinates, then click **Save stamp**. Reuse it from **Stamps**. The saved design retains its size, positions, word labels, Excel **column names**, and formatting; it does not freeze values from the sample row. The PDF and printer use the same layout.


Click a text object on the label, then **Edit text…** in Properties, or double-click the text object. Edit Fixed text directly. Excel-linked text is dynamic (each row uses the Excel cell); choose **Fixed text** in the editor to intentionally replace that link with typed text. This changes the label template, **not the spreadsheet**. When changing text in the regular Properties fields, press Enter or click outside to commit.

The **Connect printer** button is pinned next to **Print** so it stays visible even when the toolbar is too narrow; other editing tools can scroll horizontally.

## How to design and save a label

1. Click **Load example spreadsheet** or import your `.xlsx` / `.csv`.
2. If the spreadsheet starts with a report title, select the actual **Header row in Excel**. Choose the sheet if your workbook has several.
3. Start from **Text only · Product label**. The default sample shows:
   ```text
   +------------------------------------------------+
   |                                                |
   |                 Wireless Mouse                 |
   |                                                |
   |                    325 EGP                     |
   |                                                |
   +------------------------------------------------+
   ```
   The actual preview renders the label at its specified proportions (by default, 50 x 30 mm). **No barcode is generated or required**.
4. Set the physical label width and height in millimeters.
5. Under **Fields on this label**, click a field, select the **Excel column for this position**, then change its font, alignment, prefix/suffix, or X/Y coordinates.
6. **Drag text in the preview** to move it, or set precise X, Y, width, and height (mm).
7. Use **+ Excel column** to place another spreadsheet value. Use **+ Fixed text** for a title or static note.
8. Enter a template name, click **Save as new** (or **Save changes** after selecting your saved template).
9. Next time, import a new Excel file and select your saved template. The **position is preserved** and fields find columns by their **header names** rather than column numbers. If a column is missing, a warning appears: map it or delete the field before printing.
10. For another computer use **Export** to save the template as `.json` and **Import** in the other app. Templates otherwise stay in your local browser/Electron data storage.

**Example:** A label can contain a product title at X=2mm / Y=3mm, a price at X=2mm / Y=17mm, and an optional serial number at any other position. When you import different products, *each Excel row prints a separate label* using those locations.

## Excel input

Example `sample/products.csv`:

| Product Name | Barcode | Price | Quantity | Description |
|---|---|---:|---:|---|
| USB-C Cable | 123456789012 | 150 | 2 | 1 meter braided |
| Wireless Mouse | 987654321098 | 325 | 1 | 2.4 GHz |

Even though the sample contains a `Barcode` column, **text-only labels don't need it**. Map whichever columns you wish, e.g. patient name, item size, batch number, date, address, or serial number.

- Supports **Excel .xlsx** and **CSV**; for old `.xls` use Excel's **Save As → .xlsx**.
- Supports multiple worksheets and manually chosen header row (first 20 rows).
- Reads **actual Excel cell data**, rich text, and cached formula results. It does not calculate Excel formulas itself.
- Preserves text-valued identifiers and simple numeric zero-padding formats (e.g. `000000`). In Excel, format serials and identifiers as **Text** so Excel doesn't strip leading zeros or round long numeric strings.
- Up to **15 MB**, **10,000 rows**, and **40 columns** per worksheet are processed. For large files, split into several workbooks.
- Up to **30 label fields** and **50 saved templates**.
- Search your spreadsheet rows; browse full imported columns by scrolling the table horizontally.

## Printing

**Connect a printer:** Click **Connect printer** on the main toolbar or **Print → Connect printer…**. Choose a printer and click **Connect printer**. You can also connect from the Print dialog. The app checks that Windows lists the printer, reads its reported status, and saves your selection as the default. This is not a physical hardware handshake: use **Test print** in the Print dialog to confirm the device actually prints.

If **No printers found** appears, power on and plug in your printer, install the manufacturer's Windows driver, and add it in **Windows Settings → Bluetooth & devices → Printers & scanners**. Then click **Refresh** in the app. The browser-only preview cannot discover local Windows printers; use the desktop EXE.

1. Install your manufacturer's **Windows printer driver**, set the stock width and height in Windows printer preferences.
2. Print the first 1–2 rows to verify orientation and size.
3. Select your Windows printer or choose **System print dialog**.
4. Choose which rows to print. If you want a specific Excel quantity to control copies, select the **Quantity column** and tick **Print copies from Quantity column**.
5. Print batches up to 100 labels. Move to the next batch with the navigation buttons.

For thermal label printers, set **100% scaling**, **zero margins**, and no page headers/footers in the print dialog. Many printer drivers override software paper settings, so verify dimensions in the Windows driver too.

**Printer safety:** A successful Windows print call only means the system accepted the job; it does not confirm that every physical label printed successfully.

## Dev / tests

```powershell
npm install
npm test
npm run build
npm run desktop:dev
npm run dist:win
```

All imported spreadsheets are parsed on-device, no account, cloud database, or internet needed for printing. The Electron desktop IPC bridge only exposes installed printer names and sending a print job. Template JSON is restricted to supported fields before use; spreadsheet text is escaped before being inserted into printable HTML.

## About npm warnings

`npm install` sometimes shows **deprecated dependencies and security findings** from the packaging toolchain. These warnings do not mean installation failed. Use `npm audit` for the exact dependency paths; do not blindly run `npm audit fix --force` because it can break Electron/Vite. Security audits and native printer smoke tests should be performed before distributing binaries broadly.

This project is MIT licensed. See [LICENSE](LICENSE).
