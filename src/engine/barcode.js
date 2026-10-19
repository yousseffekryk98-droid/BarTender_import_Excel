// Optional barcode/2D-code generation (bwip-js, MIT). Text-only labels never load or need this.

const BCID = {
  code128: 'code128', 'gs1-128': 'gs1-128', code39: 'code39', ean13: 'ean13', ean8: 'ean8', upca: 'upca', upce: 'upce',
  itf14: 'itf14', interleaved2of5: 'interleaved2of5', codabar: 'rationalizedCodabar', qrcode: 'qrcode', datamatrix: 'datamatrix',
  pdf417: 'pdf417', azteccode: 'azteccode'
};
export const TWO_D = new Set(['qrcode', 'datamatrix', 'pdf417', 'azteccode']);
export const SYMBOLOGY_LABELS = {
  code128: 'Code 128', 'gs1-128': 'GS1-128 (AI format e.g. (01)…)', code39: 'Code 39', ean13: 'EAN-13', ean8: 'EAN-8', upca: 'UPC-A', upce: 'UPC-E',
  itf14: 'ITF-14', interleaved2of5: 'Interleaved 2 of 5', codabar: 'Codabar', qrcode: 'QR Code', datamatrix: 'Data Matrix', pdf417: 'PDF417', azteccode: 'Aztec'
};

let bwipPromise = null;
function loadBwip() {
  if (!bwipPromise) bwipPromise = import('bwip-js').then((m) => m.default || m);
  return bwipPromise;
}

const cache = new Map();

/** Returns { svg } or { error } for the given barcode object and its resolved text. */
export async function barcodeSvg(object, text) {
  const value = String(text ?? '');
  if (!value) return { error: 'No data for barcode' };
  const key = [object.symbology, object.humanReadable, object.textSize, object.height, object.color, object.quietZone, value].join('|');
  if (cache.has(key)) return cache.get(key);
  const bwip = await loadBwip();
  const twoD = TWO_D.has(object.symbology);
  const options = {
    bcid: BCID[object.symbology] || 'code128', text: value, scale: 3,
    barcolor: (object.color || '#000000').replace('#', ''),
    ...(twoD ? {} : {
      height: Math.max(2, (object.height || 10) * (object.humanReadable ? 0.72 : 0.95)),
      includetext: Boolean(object.humanReadable), textxalign: 'center', textsize: Math.max(4, Math.min(30, object.textSize || 7)),
      ...(object.quietZone ? { paddingleft: 6, paddingright: 6 } : {})
    }),
    ...(object.symbology === 'qrcode' ? { eclevel: 'M' } : {})
  };
  let result;
  try { result = { svg: bwip.toSVG(options) }; }
  catch (error) { result = { error: String(error?.message || error).replace(/^bwipp\.\w+#\d+:\s*/, '') }; }
  if (cache.size > 2000) cache.clear();
  cache.set(key, result);
  return result;
}
