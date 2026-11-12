const { createHash } = require('node:crypto');

const lf = text => text.replace(/\r\n?/g, '\n');
const digest = text => createHash('sha256').update(text).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const heading = question => `Question:\n${lf(question)}\n\nSources:\n`;
const historyHeading = '\n\nHistorical dialogue:\n';

function serializeSources(question, sources) {
  let text = heading(question);
  const sourceExcerpts = [];
  for (const source of sources) {
    if (sourceExcerpts.length) text += '\n\n';
    const header = text.length;
    text += `${lf(source.provenance)}\n`;
    const start = text.length, excerpt = lf(source.text);
    text += excerpt;
    sourceExcerpts.push({ key: source.key, digest: source.digest, header, start, end: text.length, excerptDigest: digest(excerpt) });
  }
  return { text, sourceExcerpts };
}

// Offsets are UTF-16 code-unit indices into the LF-normalized package, as
// used by String.slice. Each endpoint must fall between complete characters.
function sourceExcerptsValid(pkg) {
  const { text, question, dependencies, sourceExcerpts } = pkg;
  if (typeof text !== 'string' || typeof question !== 'string' || !Array.isArray(dependencies) || !Array.isArray(sourceExcerpts)) return false;
  const prefix = heading(question);
  if (!text.startsWith(prefix) || text.includes('\r')) return false;
  const boundary = index => !(text.charCodeAt(index - 1) >= 0xD800 && text.charCodeAt(index - 1) <= 0xDBFF &&
    text.charCodeAt(index) >= 0xDC00 && text.charCodeAt(index) <= 0xDFFF);
  let end = prefix.length;
  for (const [index, excerpt] of sourceExcerpts.entries()) {
    if (!excerpt || typeof excerpt !== 'object' || Array.isArray(excerpt) ||
        Object.keys(excerpt).some(key => !['key', 'digest', 'header', 'start', 'end', 'excerptDigest'].includes(key))) return false;
    const { key, digest: sourceDigest, header, start, end: limit, excerptDigest } = excerpt;
    if (typeof key !== 'string' || typeof sourceDigest !== 'string' || !sha256.test(sourceDigest) || typeof excerptDigest !== 'string' || !sha256.test(excerptDigest) ||
        !dependencies.some(dep => dep?.key === key && dep.digest === sourceDigest) ||
        ![header, start, limit].every(Number.isSafeInteger) || header !== end + (index ? 2 : 0) ||
        start <= header || start > limit || limit > text.length || text[start - 1] !== '\n' ||
        index && !text.startsWith('\n\n', end) || ![header, start, limit].every(boundary) ||
        digest(text.slice(start, limit)) !== excerptDigest) return false;
    end = limit;
  }
  return text.startsWith(historyHeading, end);
}

module.exports = { serializeSources, sourceExcerptsValid, lf };
