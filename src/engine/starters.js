// Starter templates (original designs). Users create new templates from them; they are never modified.

import { createTemplate, createObject } from './schema.js';

const text = (x, y, w, h, content, style = {}, extra = {}) => createObject('text', { x, y, width: w, height: h, content: { mode: 'static', text: '', ...content }, style: { fontSize: 9, ...style }, ...extra });
const field = (name, x, y, w, h, style = {}, extra = {}) => text(x, y, w, h, { mode: 'field', field: name }, style, { name, ...extra });
const label = (value, x, y, w, h, style = {}, extra = {}) => text(x, y, w, h, { mode: 'static', text: value }, style, { name: value, ...extra });
const line = (x, y, w, extra = {}) => createObject('line', { x, y, width: w, height: 0.6, stroke: { width: 0.3, color: '#000000', style: 'solid' }, ...extra });
const rect = (x, y, w, h, extra = {}) => createObject('rect', { x, y, width: w, height: h, stroke: { width: 0.35, color: '#000000', style: 'solid' }, ...extra });

const STARTERS = [
  {
    key: 'price-tag', name: 'Price tag', category: 'Retail', description: 'Product name, large price and SKU. Columns: Product Name, Price, SKU.',
    page: { width: 50, height: 30 },
    objects: () => [
      field('Product Name', 2, 2, 46, 9, { fontSize: 10, bold: true, align: 'center', vAlign: 'middle' }),
      text(2, 11.5, 46, 11, { mode: 'field', field: 'Price' }, { fontSize: 22, bold: true, align: 'center', vAlign: 'middle' }, { name: 'Price', format: { kind: 'currency', currencySymbol: 'EGP', decimals: 2, thousands: true } }),
      field('SKU', 2, 24, 46, 4.5, { fontSize: 7, align: 'center' }, { prefix: 'SKU: ' })
    ]
  },
  {
    key: 'inventory', name: 'Inventory label', category: 'Warehouse', description: 'Item, location, quantity and date received. Columns: Item, Location, Quantity, Received.',
    page: { width: 70, height: 40 },
    objects: () => [
      field('Item', 3, 2.5, 64, 9, { fontSize: 12, bold: true }),
      line(3, 12, 64),
      label('Location', 3, 14, 20, 4, { fontSize: 7 }), field('Location', 3, 18, 30, 7, { fontSize: 13, bold: true }),
      label('Qty', 40, 14, 20, 4, { fontSize: 7 }), field('Quantity', 40, 18, 27, 7, { fontSize: 13, bold: true }),
      label('Received', 3, 28, 20, 4, { fontSize: 7 }),
      text(3, 32, 40, 5, { mode: 'field', field: 'Received' }, { fontSize: 9 }, { name: 'Received', format: { kind: 'date', datePattern: 'dd/MM/yyyy' } })
    ]
  },
  {
    key: 'shelf', name: 'Shelf label', category: 'Retail', description: 'Wide shelf-edge label with description and price. Columns: Product Name, Description, Price.',
    page: { width: 100, height: 30 },
    objects: () => [
      field('Product Name', 3, 2, 62, 9, { fontSize: 13, bold: true }),
      field('Description', 3, 12, 62, 15, { fontSize: 8, lineSpacing: 1.15 }),
      text(66, 4, 31, 22, { mode: 'field', field: 'Price' }, { fontSize: 26, bold: true, align: 'right', vAlign: 'middle' }, { name: 'Price', format: { kind: 'number', decimals: 2, thousands: true } })
    ]
  },
  {
    key: 'address', name: 'Address label', category: 'Mailing', description: 'Name and address block. Columns: Name, Address, City, Phone.',
    page: { width: 89, height: 36 },
    objects: () => [
      field('Name', 4, 3, 81, 7, { fontSize: 12, bold: true }),
      text(4, 11, 81, 16, { mode: 'template', template: '{Address}\n{City}' }, { fontSize: 10, lineSpacing: 1.2 }, { name: 'Address' }),
      field('Phone', 4, 28, 81, 5, { fontSize: 8 }, { prefix: 'Tel: ' })
    ]
  },
  {
    key: 'shipping', name: 'Shipping label 4×6', category: 'Shipping', description: 'Sender, recipient, order number and weight. Columns: Recipient, Address, City, Order, Weight.',
    page: { width: 100, height: 150 },
    objects: () => [
      label('FROM', 5, 5, 30, 5, { fontSize: 7, bold: true }),
      text(5, 10, 90, 15, { mode: 'static', text: 'Your company name\nStreet, City' }, { fontSize: 9 }, { name: 'Sender' }),
      line(5, 28, 90),
      label('SHIP TO', 5, 31, 30, 5, { fontSize: 8, bold: true }),
      field('Recipient', 5, 37, 90, 10, { fontSize: 16, bold: true }),
      text(5, 48, 90, 30, { mode: 'template', template: '{Address}\n{City}' }, { fontSize: 13, lineSpacing: 1.2 }, { name: 'Ship-to address' }),
      rect(5, 85, 90, 28),
      label('ORDER', 8, 88, 40, 5, { fontSize: 7 }), field('Order', 8, 93, 50, 9, { fontSize: 16, bold: true }),
      label('WEIGHT', 62, 88, 30, 5, { fontSize: 7 }), field('Weight', 62, 93, 30, 9, { fontSize: 14, bold: true }, { suffix: ' kg' }),
      text(5, 140, 90, 5, { mode: 'date' }, { fontSize: 7, align: 'right' }, { name: 'Print date', prefix: 'Printed ' })
    ]
  },
  {
    key: 'description', name: 'Product description', category: 'Retail', description: 'Multi-line description that shrinks to fit. Columns: Product Name, Description, Origin.',
    page: { width: 60, height: 40 },
    objects: () => [
      field('Product Name', 3, 2, 54, 8, { fontSize: 11, bold: true }),
      field('Description', 3, 11, 54, 22, { fontSize: 9, lineSpacing: 1.15, overflow: 'shrink', minFontSize: 5 }),
      field('Origin', 3, 34, 54, 4.5, { fontSize: 7 }, { prefix: 'Origin: ' })
    ]
  },
  {
    key: 'serial', name: 'Serial-number label', category: 'Manufacturing', description: 'Model from Excel plus an automatic serial number that increases per label.',
    page: { width: 50, height: 25 },
    objects: () => [
      field('Model', 2, 2, 46, 7, { fontSize: 10, bold: true }),
      text(2, 10, 46, 8, { mode: 'serial', serial: { start: '000001', step: 1, width: 6, mode: 'numeric', perCopy: true, continueFromLast: true } }, { fontSize: 14, bold: true }, { name: 'Serial', prefix: 'SN ' }),
      text(2, 19.5, 46, 4, { mode: 'date' }, { fontSize: 6.5 }, { name: 'Date', format: { kind: 'date', datePattern: 'MM/yyyy' }, prefix: 'Mfg ' })
    ]
  },
  {
    key: 'plain', name: 'Plain text label', category: 'General', description: 'One centred text field from the first column you map. Column: Text.',
    page: { width: 50, height: 25 },
    objects: () => [field('Text', 2, 2, 46, 21, { fontSize: 14, align: 'center', vAlign: 'middle' })]
  },
  {
    key: 'calibration-small', name: 'Calibration label 50×25', category: 'Calibration', description: 'Lab calibration label. Columns: Cert. No., Cal. Date, Due Date, S.N., ID, Qty.',
    page: { width: 50, height: 25 }, data: { quantityField: 'Qty', quantityMode: 'field' },
    objects: () => [
      label('Trust Egypt for Quality Systems (TEQ)', 1.5, 0.8, 47, 3.6, { fontSize: 6.5, bold: true, align: 'center', overflow: 'shrink' }),
      line(1.5, 4.3, 47, { stroke: { width: 0.35, color: '#000000', style: 'solid' } }),
      ...[['Cert. No.#:', 'Cert. No.'], ['Cal.Date:', 'Cal. Date'], ['Due Date:', 'Due Date'], ['S.N.:', 'S.N.'], ['ID:', 'ID']].flatMap(([caption, column], i) => {
        const y = 5.2 + i * 3.85;
        const isDate = column.includes('Date');
        return [
          label(caption, 1.5, y, 14, 3.6, { fontSize: 6.5, bold: true, vAlign: 'middle' }),
          text(15.5, y, 33, 3.6, { mode: 'field', field: column }, { fontSize: 7, vAlign: 'middle', bold: column === 'Due Date', overflow: 'shrink' }, { name: column, ...(isDate ? { format: { kind: 'date', datePattern: 'dd/MM/yyyy' } } : {}) })
        ];
      })
    ]
  },
  {
    key: 'calibration-large', name: 'Calibration label 70×40', category: 'Calibration', description: 'Large lab calibration label. Columns: Cert. No., Cal. Date, Due Date, S.N., ID, Qty.',
    page: { width: 70, height: 40 }, data: { quantityField: 'Qty', quantityMode: 'field' },
    objects: () => [
      label('Trust Egypt for Quality Systems (TEQ)', 2, 1.5, 66, 6, { fontSize: 9.5, bold: true, align: 'center', vAlign: 'middle', overflow: 'shrink' }),
      line(2, 7.6, 66, { stroke: { width: 0.45, color: '#000000', style: 'solid' } }),
      ...[['Cert. No.#:', 'Cert. No.'], ['Cal.Date:', 'Cal. Date'], ['Due Date:', 'Due Date'], ['S.N.:', 'S.N.'], ['ID:', 'ID']].flatMap(([caption, column], i) => {
        const y = 9 + i * 6.1;
        const isDate = column.includes('Date');
        return [
          label(caption, 2, y, 20, 5.6, { fontSize: 9.5, bold: true, vAlign: 'middle' }),
          text(22, y, 46, 5.6, { mode: 'field', field: column }, { fontSize: 10, vAlign: 'middle', bold: column === 'Due Date', overflow: 'shrink' }, { name: column, ...(isDate ? { format: { kind: 'date', datePattern: 'dd/MM/yyyy' } } : {}) })
        ];
      })
    ]
  },
  {
    key: 'arabic-product', name: 'Arabic / English product label', category: 'Retail', description: 'Bilingual label: Arabic name (right-to-left) and English name. Columns: الاسم, Name, Price.',
    page: { width: 60, height: 35 },
    objects: () => [
      field('الاسم', 2, 2, 56, 9, { fontSize: 12, bold: true, align: 'right', direction: 'rtl', fontFamily: 'Tahoma' }),
      field('Name', 2, 12, 56, 7, { fontSize: 10, align: 'left', direction: 'ltr' }),
      text(2, 21, 56, 11, { mode: 'field', field: 'Price' }, { fontSize: 18, bold: true, align: 'center', vAlign: 'middle' }, { name: 'Price', suffix: ' ج.م' })
    ]
  }
];

export const STARTER_LIST = STARTERS.map(({ key, name, category, description, page }) => ({ key, name, category, description, width: page.width, height: page.height }));

/** Create a fresh, editable template from a starter. */
export function templateFromStarter(key) {
  const starter = STARTERS.find((s) => s.key === key);
  if (!starter) throw new Error('Unknown starter template ' + key);
  return createTemplate({
    name: starter.name, category: starter.category, description: starter.description,
    page: { ...starter.page }, objects: starter.objects(), data: starter.data || {}
  });
}

/** Sample data for each starter so previews look real before any Excel is imported. */
export const STARTER_SAMPLE = {
  'price-tag': [['Product Name', 'Price', 'SKU'], ['Wireless Mouse', '325', 'MS-0451'], ['USB-C Cable 1 m', '150', 'CB-1180']],
  inventory: [['Item', 'Location', 'Quantity', 'Received'], ['Steel bolts M8', 'A-03-2', '250', '2026-10-12'], ['Nylon washers', 'B-11-4', '1200', '2026-10-15']],
  shelf: [['Product Name', 'Description', 'Price'], ['Olive oil 1 L', 'Extra virgin, cold pressed. Product of Egypt.', '389.50']],
  address: [['Name', 'Address', 'City', 'Phone'], ['Mona Hassan', '12 El-Tahrir St., Apt 4', 'Cairo 11511', '+20 100 000 0000']],
  shipping: [['Recipient', 'Address', 'City', 'Order', 'Weight'], ['Omar Adel', '45 Corniche Road', 'Alexandria', 'ORD-102938', '2.4']],
  description: [['Product Name', 'Description', 'Origin'], ['Herbal tea', 'A calming blend of chamomile, mint and lemongrass. Steep 5 minutes in hot water.', 'Egypt']],
  serial: [['Model'], ['Pressure gauge PG-100']],
  plain: [['Text'], ['Hello label']],
  'calibration-small': [['Cert. No.', 'Cal. Date', 'Due Date', 'S.N.', 'ID', 'Qty'], ['TEQ-M-26-0451', '19/10/2026', '19/10/2027', 'B123456', 'BAL-01', '3']],
  'calibration-large': [['Cert. No.', 'Cal. Date', 'Due Date', 'S.N.', 'ID', 'Qty'], ['TEQ-M-26-0451', '19/10/2026', '19/10/2027', 'B123456', 'BAL-01', '3']],
  'arabic-product': [['الاسم', 'Name', 'Price'], ['ماوس لاسلكي', 'Wireless mouse', '325']]
};
