import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExpression, parseExpression, renderTextTemplate, referencedFields, templateFields, ExpressionError, tokenize } from '../../src/engine/expression.js';

const row = { 'Product Name': 'Mouse', Price: '325', Qty: '3', Date: '2026-10-19', Empty: '', 'Cal. Date': '19/10/2026' };
const ctx = (extra = {}) => ({ field: (n) => row[n] ?? '', prompt: (n) => ({ Batch: 'B-7' })[n] ?? '', now: () => new Date(2026, 9, 19, 14, 30), ...extra });

test('arithmetic, concatenation and precedence', () => {
  assert.equal(evaluateExpression('1 + 2 * 3', ctx()), 7);
  assert.equal(evaluateExpression('(1 + 2) * 3', ctx()), 9);
  assert.equal(evaluateExpression('[Price] * [Qty]', ctx()), 975);
  assert.equal(evaluateExpression('[Product Name] & " x" & [Qty]', ctx()), 'Mouse x3');
  assert.equal(evaluateExpression('"A" + "B"', ctx()), 'AB');
  assert.equal(evaluateExpression('-[Price] + 25', ctx()), -300);
  assert.equal(evaluateExpression('10 % 4', ctx()), 2);
});

test('field references in brackets or braces, prompts with {?…}', () => {
  assert.equal(evaluateExpression('{Product Name}', ctx()), 'Mouse');
  assert.equal(evaluateExpression('{?Batch} & "/" & [Qty]', ctx()), 'B-7/3');
  assert.deepEqual(referencedFields('UPPER([Product Name]) & FIELD("Qty") & {Price}').sort(), ['Price', 'Product Name', 'Qty']);
});

test('comparison and logic', () => {
  assert.equal(evaluateExpression('[Price] > 300 AND [Qty] = 3', ctx()), true);
  assert.equal(evaluateExpression('NOT ([Price] < 300) OR FALSE', ctx()), true);
  assert.equal(evaluateExpression('"abc" = "ABC"', ctx()), true);
  assert.equal(evaluateExpression('[Price] <> 325', ctx()), false);
  assert.equal(evaluateExpression('IF([Qty] >= 3, "BULK", "SINGLE")', ctx()), 'BULK');
  assert.equal(evaluateExpression('IF(ISEMPTY([Empty]), "none", [Empty])', ctx()), 'none');
});

test('IF only evaluates the chosen branch', () => {
  assert.equal(evaluateExpression('IF(TRUE, 1, 1/0)', ctx()), 1);
  assert.throws(() => evaluateExpression('IF(FALSE, 1, 1/0)', ctx()), /Division by zero/);
});

test('text functions handle Unicode and Arabic', () => {
  assert.equal(evaluateExpression('UPPER("mouse")', ctx()), 'MOUSE');
  assert.equal(evaluateExpression('PROPER("hello world-wide")', ctx()), 'Hello World-Wide');
  assert.equal(evaluateExpression('LEFT("مرحبا", 2)', ctx()), 'مر');
  assert.equal(evaluateExpression('RIGHT("ABCDEF", 3)', ctx()), 'DEF');
  assert.equal(evaluateExpression('MID("ABCDEF", 2, 3)', ctx()), 'BCD');
  assert.equal(evaluateExpression('LEN("مرحبا")', ctx()), 5);
  assert.equal(evaluateExpression('PADLEFT([Qty], 5, "0")', ctx()), '00003');
  assert.equal(evaluateExpression('REPLACE("a-b-c", "-", "/")', ctx()), 'a/b/c');
  assert.equal(evaluateExpression('TRIM("  a   b ")', ctx()), 'a b');
  assert.equal(evaluateExpression('CONCAT("SN", "-", 7)', ctx()), 'SN-7');
  assert.equal(evaluateExpression('COALESCE([Empty], [Product Name])', ctx()), 'Mouse');
  assert.equal(evaluateExpression('CONTAINS([Product Name], "OUS")', ctx()), true);
});

test('number and date functions', () => {
  assert.equal(evaluateExpression('FIXED([Price] / 3, 2)', ctx()), '108.33');
  assert.equal(evaluateExpression('ROUND(2.345, 2)', ctx()), 2.35);
  assert.equal(evaluateExpression('FORMATNUMBER(1234567.891, 2)', ctx()), '1,234,567.89');
  assert.equal(evaluateExpression('FORMATDATE(ADDMONTHS([Cal. Date], 12), "dd/MM/yyyy")', ctx()), '19/10/2027');
  assert.equal(evaluateExpression('FORMATDATE(ADDDAYS([Date], 13), "yyyy-MM-dd")', ctx()), '2026-11-01');
  assert.equal(evaluateExpression('FORMATDATE(ADDMONTHS(DATE(2024,1,31), 1), "dd/MM/yyyy")', ctx()), '29/02/2024');
  assert.equal(evaluateExpression('FORMATDATE(TODAY(), "dd/MM/yyyy")', ctx()), '19/10/2026');
  assert.equal(evaluateExpression('YEAR([Date]) * 100 + MONTH([Date])', ctx()), 202610);
  assert.equal(evaluateExpression('TEXT(0.155, "0.0%")', ctx()), '15.5%');
  assert.equal(evaluateExpression('TEXT(42, "000000")', ctx()), '000042');
  assert.equal(evaluateExpression('RECORDNUMBER() & "/" & LABELNUMBER() & "/" & COPYNUMBER() & "/" & COPIES()', ctx({ recordNumber: 4, labelNumber: 9, copyNumber: 2, copies: 3 })), '4/9/2/3');
});

test('errors are explicit and never run arbitrary code', () => {
  assert.throws(() => evaluateExpression('constructor.constructor("return process")()', ctx()), ExpressionError);
  assert.throws(() => evaluateExpression('process.exit(1)', ctx()), ExpressionError);
  assert.throws(() => evaluateExpression('UNKNOWNFN(1)', ctx()), /Unknown function/);
  assert.throws(() => evaluateExpression('UPPER()', ctx()), /expects 1/);
  assert.throws(() => evaluateExpression('"abc', ctx()), /closing quote/);
  assert.throws(() => evaluateExpression('[Price', ctx()), /closing/);
  assert.throws(() => evaluateExpression('1 +', ctx()), /ended unexpectedly/);
  assert.throws(() => evaluateExpression('[Product Name] * 2', ctx()), /not a number/);
  assert.throws(() => evaluateExpression('x'.repeat(2001), ctx()), /too long/);
  assert.throws(() => parseExpression('('.repeat(60) + '1' + ')'.repeat(60)), /nested too deeply/);
  assert.throws(() => tokenize('1 $ 2'), /Unexpected character/);
});

test('combined {Field} text templates', () => {
  assert.equal(renderTextTemplate('{Product Name} – {Price} EGP', ctx()), 'Mouse – 325 EGP');
  assert.equal(renderTextTemplate('Batch {?Batch}: {=[Price]*2}', ctx()), 'Batch B-7: 650');
  assert.equal(renderTextTemplate('{{literal}} {Qty}', ctx()), '{literal} 3');
  assert.equal(renderTextTemplate('unclosed {brace', ctx()), 'unclosed {brace');
  assert.deepEqual(templateFields('{A} and {B} and {?P} and {=[C]+1}').sort(), ['A', 'B', 'C']);
});
