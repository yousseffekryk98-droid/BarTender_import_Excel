# Codebase Audit — Excel Label Studio v0.2.0 (baseline)

Audited commit: `5e8c00d` (main, "Remove unused React plugin dependency after Vite JSX migration").
Audit date: 2026-10-19. Environment: Node 22.22, npm 10.9, Ubuntu 24.04 (+ Xvfb, Wine 9 for Windows packaging).

## 1. Inventory

| Area | Files | Lines | Notes |
|---|---|---:|---|
| Electron main / preload | `electron/main.cjs`, `electron/preload.cjs` | 119 | One window, two IPC handlers (`label:get-printers`, `label:print`) |
| React UI | `src/App.jsx`, `src/main.jsx`, `src/styles.css` | 956 | Single 731-line component holds all state and UI |
| Engine | `src/core.js`, `src/templates.js`, `src/text-print.js` | 283 | Mix of legacy barcode-era helpers and text-template helpers |
| Import | `src/importers.js` | 83 | ExcelJS (.xlsx) and PapaParse (.csv) |
| Tests | `src/*.test.js` | 180 | 17 `node:test` unit tests, all passing |
| CI | `.github/workflows/windows.yml` | 47 | Ubuntu test/build job + Windows `dist:win` job |
| Packaging | `package.json#build` | — | NSIS + portable targets, no icon, no fuses |
| Docs | `README.md` | 110 | Accurate for the text-only workflow |

No TypeScript, no lockfile committed, no E2E tests, no `docs/` folder.

## 2. Build, test and runtime results (baseline)

| Check | Result |
|---|---|
| `npm install` | OK (no lockfile → non-reproducible dependency tree) |
| `npm test` | **17/17 pass** |
| `npm run build` | OK; one 1.16 MB JS chunk (ExcelJS bundled eagerly) |
| Electron launch (Xvfb) | Starts, no console errors |
| `npm audit` | **20 vulnerabilities: 1 critical, 13 high, 6 moderate** |

### npm audit detail

| Package (via) | Severity | Root cause | Fix |
|---|---|---|---|
| `tar` (electron-builder → @electron/rebuild, node-gyp) | critical | Hardlink path traversal | electron-builder 26.x |
| `electron` 33.4 | high | ASAR integrity bypass; EOL major | Electron 44.x |
| `extract-zip`, `@electron/get`, `global-agent`, `roarr`, `sprintf-js` | high/moderate | Electron download tooling | Electron 44.x |
| `app-builder-lib`, `builder-util(-runtime)`, `dmg-builder`, `electron-publish`… | high | electron-builder 25 | electron-builder 26.x |
| `uuid` < 11.1.1 (via exceljs) | moderate | Buffer bounds check in v3/v5/v6 when `buf` given (ExcelJS only calls `v4()` without a buffer — not reachable) | npm `overrides` → uuid 11 |

All findings are build-time or Electron-runtime; none come from first-party code.

## 3. Defects found

Severity: **C** critical (wrong output / data loss), **H** high, **M** medium, **L** low.

| # | Sev | Where | Defect |
|---|---|---|---|
| D1 | **C** | `text-print.js` `renderTextLabel` | `font-family:` is written with `JSON.stringify` → `"Arial"` inside a double-quoted `style="…"` attribute. The attribute ends at that quote, so **bold, italic, underline, wrapping, rotation and text alignment are silently dropped** in both preview and print. Verified by rendering the default template. |
| D2 | **C** | `core.js` `copyCount` | Quantity is silently capped at 1000 (`Math.min(n, 1000)`): a row asking for 1500 labels prints 1000 with no warning. |
| D3 | **C** | `importers.js` | Rows beyond 10,000 and columns beyond 40 are **silently truncated**. |
| D4 | H | `importers.js` | Numbers with >15 significant digits or very large values arrive as `1.2345678901234568e+21`-style text; no precision warning. |
| D5 | H | `importers.js` | CSV assumed UTF-8. Arabic CSVs saved by Excel ("CSV (Comma delimited)") are Windows-1256 and import as mojibake. No TSV/semicolon support. |
| D6 | H | `importers.js` | Dates always become `YYYY-MM-DD` and lose time; currency/percent/decimal number formats ignored (`0.15` with `0%` shows `0.15`). |
| D7 | H | `App.jsx` storage | Templates live only in `localStorage`; a quota error is swallowed (`catch {}`) so saves can be **lost silently**. No file backup, no versions, no recovery. Delete is permanent. |
| D8 | H | `App.jsx` `setSize` / `editDraft` | Number inputs sanitize on every keystroke. Retyping width "50" passes through "5" → clamped to 20 → all objects are clamped/shrunk into 20 mm (destructive). |
| D9 | M | `App.jsx` template name | `sanitizeTemplate` replaces an empty name with "My template" while typing — the name box cannot be cleared. Each keystroke also creates an undo step. |
| D10 | M | `App.jsx` drag | A click with no movement still pushes an undo snapshot. |
| D11 | M | printing | Manual 100-label batches: printing 2,000 labels needs 20 manual clicks. No job history, no reprint, no PDF, no test print. |
| D12 | M | printing | A successful `webContents.print` callback is reported as "Sent N labels" — not distinguished from physical success; printer status (offline/error) never checked. |
| D13 | M | rendering | Font size in CSS px labelled "px"; label/printing industry and BarTender use points. Text that overflows its box is clipped with no warning. No vertical alignment. |
| D14 | M | `electron/main.cjs` | IPC checks the sender `webContents` but not the frame URL; no permission handlers; `will-attach-webview` not blocked; production CSP still allows `ws:`. No Electron fuses. |
| D15 | M | CI | `npm install` without lockfile; Windows job cannot be reproduced; no unit/integration split; no E2E. |
| D16 | L | `core.js` | Dead barcode-era code (`printableRecords`, `isValidEAN`, `COLUMN_FIELDS`) still exported and tested. |
| D17 | L | packaging | No application icon (`build/icon.ico`); EXE uses the default Electron icon. |
| D18 | L | `importers.js` | Hidden rows/columns and merged cells imported without any indication. Legacy `.xls` rejected. |

## 4. Architecture assessment

- **Good foundations to keep:** strict column binding by header name (never substitutes another column), HTML escaping of spreadsheet data, millimetre coordinate model, sandboxed renderer with `contextIsolation`, header-row re-selection, cached formula results.
- **Problems:** all UI state in one component; engine mixes legacy and new concepts; rendering and storage are not separable from React; no persistence layer; print path cannot be tested without a printer.

## 5. Decisions

1. Keep JavaScript (ES modules + JSDoc) instead of a TypeScript rewrite — the code works and a rewrite would add risk without user value. New engine modules are pure and unit-tested.
2. Introduce a versioned template schema (v2) with a tested migration from v0.2.0 templates, so existing users keep their designs.
3. Move persistence to files in the Electron `userData` folder (survives updates), with automatic one-time migration from `localStorage`.
4. One deterministic renderer (HTML in mm/pt) shared by canvas preview, PDF export and printing.
5. Upgrade Electron and electron-builder to current majors; override `uuid`.

See `ARCHITECTURE.md` and `IMPLEMENTATION_PLAN.md`.
