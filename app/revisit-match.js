const { createHash } = require('node:crypto');

// D45: inspectable local matching between one evidence item and one revisit condition.
// No model is involved. Every reason that led to a candidate is recorded with it.
const words = value => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const normalize = value => words(value).join(' ');
const stopwords = new Set(['about', 'above', 'after', 'again', 'against', 'would', 'should', 'could', 'there', 'their', 'these', 'those', 'which', 'while', 'where', 'other', 'being', 'because', 'before', 'between', 'reports', 'report', 'shows', 'capture', 'evidence', 'something', 'decision']);

function paragraphs(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), found = [];
  let start = 0;
  for (let index = 0; index <= lines.length; index++) if (index === lines.length || !lines[index].trim()) {
    if (start < index) found.push({ start: start + 1, end: index, text: lines.slice(start, index).join('\n') });
    start = index + 1;
  }
  return found;
}
// A single-word cue matches a whole word. A multi-word cue matches the words in order.
function cueMatches(paragraph, terms) {
  const normal = ` ${normalize(paragraph)} `;
  return terms.filter(term => { const cue = normalize(term); return cue && normal.includes(` ${cue} `); });
}
function linkedTo(condition, evidence) {
  const related = new Set([evidence.key, ...(evidence.linked || []).map(id => `capture:${id}`), ...(evidence.associatedIds || []).map(id => `capture:${id}`)]);
  if (evidence.associated) related.add(`capture:${evidence.associated}`);
  return condition.links.filter(link => related.has(link));
}
function triggerWords(condition) { return [...new Set(words(condition.trigger).filter(word => word.length >= 5 && !stopwords.has(word)))]; }

function matchCondition(condition, evidence) {
  if (condition.kind !== 'evidence') return null;
  const found = paragraphs(evidence.text).map(p => ({ ...p, matched: cueMatches(p.text, condition.cue_terms) })).filter(p => p.matched.length)
    .sort((a, b) => b.matched.length - a.matched.length || a.start - b.start);
  const links = linkedTo(condition, evidence);
  if (!found.length && !links.length) return null;
  const reasons = [];
  const cues = [...new Set(found.flatMap(p => p.matched))];
  if (cues.length) reasons.push(`Cue terms matched: ${cues.join(', ')}`);
  for (const link of links) reasons.push(`Linked source: ${link}`);
  const evidenceWords = new Set(words(evidence.text)), shared = triggerWords(condition).filter(word => evidenceWords.has(word));
  if (shared.length) reasons.push(`Trigger words also present: ${shared.join(', ')}`);
  const passages = (found.length ? found : paragraphs(evidence.text).slice(0, 2).map(p => ({ ...p, matched: [] })))
    .slice(0, 3).map(({ start, end, text, matched }) => ({ start, end, text: [...text].slice(0, 2000).join(''), matched }));
  return { passages, reasons, score: cues.length * 10 + links.length * 5 + shared.length };
}
// Identical matched text is the same point, even from a re-import or retitled copy (D47-I02).
function fingerprint(passages) {
  return 'v2:' + createHash('sha256').update(JSON.stringify(passages.map(p => p.text))).digest('hex');
}
module.exports = { matchCondition, fingerprint, normalize, paragraphs };
