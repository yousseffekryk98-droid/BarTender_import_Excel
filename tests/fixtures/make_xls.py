"""Regenerate the legacy .xls (BIFF8) fixtures used by the importer tests.  pip install xlwt"""
import datetime, os, xlwt
here = os.path.dirname(os.path.abspath(__file__))
wb = xlwt.Workbook(encoding='utf-8')
ws = wb.add_sheet('Products')
date_style = xlwt.easyxf(num_format_str='DD/MM/YYYY')
money = xlwt.easyxf(num_format_str='#,##0.00')
text = xlwt.easyxf(num_format_str='@')
for c, h in enumerate(['Product Name', 'Serial', 'Price', 'Received', 'الاسم', 'Qty']):
    ws.write(0, c, h)
rows = [('Mouse', '00123', 325, datetime.date(2026, 10, 19), 'ماوس', 2), ('Keyboard', '00124', 1500.5, datetime.date(2026, 1, 5), 'لوحة مفاتيح', 1)]
for r, (name, serial, price, received, ar, qty) in enumerate(rows, start=1):
    ws.write(r, 0, name); ws.write(r, 1, serial, text); ws.write(r, 2, price, money)
    ws.write(r, 3, received, date_style); ws.write(r, 4, ar); ws.write(r, 5, qty)
ws.write(3, 0, xlwt.Formula('"Cable"&" 1m"'))
ws.write(3, 2, 99.75, money)
ws.write_merge(5, 5, 0, 2, 'Merged note')
ws2 = wb.add_sheet('Second')
ws2.write(0, 0, 'Code'); ws2.write(0, 1, 'Value')
for i in range(1, 6):
    ws2.write(i, 0, 'C%03d' % i); ws2.write(i, 1, i * 1.5)
wb.save(os.path.join(here, 'legacy.xls'))
# many unique strings so the shared-string table spans CONTINUE records
wb2 = xlwt.Workbook(encoding='utf-8')
s = wb2.add_sheet('Big')
s.write(0, 0, 'Name'); s.write(0, 1, 'Arabic')
for i in range(1, 3001):
    s.write(i, 0, 'Item number %05d with a reasonably long description text' % i)
    s.write(i, 1, 'منتج رقم %d' % i)
wb2.save(os.path.join(here, 'many-strings.xls'))
print('written')
