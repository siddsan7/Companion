// Reel to MD storage.digest: Python json.dumps(sort_keys=True, allow_nan=False).
// Numeric source tokens are required: JS Number alone loses int/float identity.
class Numeric { constructor(value, raw) { this.value = value; this.raw = raw; } }
function decode(bytes) {
  // Preserve any BOM so JSON.parse rejects it, as Python's UTF-8 reader does.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Error('Unreadable producer UTF-8 text. Restore the complete finalized export and retry.'); }
}
function float(value) {
  if (!Number.isFinite(value)) throw Error('Nonfinite source number.');
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const [mantissa, exponent] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', ''), e = Number(exponent), point = e + 1;
  const result = e < -4 || e >= 16 ? `${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}` : point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}.0` : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (value < 0 ? '-' : '') + result;
}
const string = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
function compare(a, b) {
  const left = Array.from(a, c => c.codePointAt(0)), right = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function canonical(value) {
  if (value instanceof Numeric) return /[.eE]/.test(value.raw) ? float(value.value) : BigInt(value.raw).toString();
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return string(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(', ')}]`;
  return `{${Object.keys(value).sort(compare).map(key => `${string(key)}: ${canonical(value[key])}`).join(', ')}}`;
}
function parse(text, lossless = false) {
  // Bound nesting and numeric token length before JSON.parse's recursive reviver.
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw Error('Producer JSON exceeds 16 MiB.');
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') { if (++depth > 64) throw Error('Producer JSON nesting exceeds 64 levels.'); }
    else if (char === ']' || char === '}') depth--;
    else if (char === '-' || /[0-9]/.test(char)) {
      let end = i + 1; while (end < text.length && /[0-9.eE+-]/.test(text[end])) end++;
      if (end - i > 4300) throw Error('Producer number exceeds the supported digit limit.');
      i = end - 1;
    }
  }
  try {
    return JSON.parse(text, (_, value, context) => {
      if (typeof value !== 'number') return value;
      if (!Number.isFinite(value)) throw Error('Nonfinite producer number.');
      if (lossless && typeof context?.source !== 'string') throw Error('This runtime cannot validate producer source digests.');
      return lossless ? new Numeric(value, context.source) : value;
    });
  } catch (error) {
    // V8 syntax errors can include an untrusted source fragment.
    if (error instanceof SyntaxError) throw Error('Unreadable producer JSON. Restore complete finalized artifacts and retry.');
    throw error;
  }
}
module.exports = { parse, canonical, decode };
