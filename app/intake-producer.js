// Reel to MD 1.0 draft contract. Schemas are copied from the producer;
// semantic checks and inert rendering mirror contracts.py, not a download receipt.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = reason => { throw Error(reason); };
function schema(value, rule) {
  if (Object.hasOwn(rule, 'const') && JSON.stringify(value) !== JSON.stringify(rule.const)) fail('Unsupported producer schema or fixed field.');
  if (rule.enum && !rule.enum.includes(value)) fail('Unsupported producer field value.');
  if (rule.type) {
    const kinds = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!kinds.some(kind => kind === 'null' ? value === null : kind === 'array' ? Array.isArray(value) : kind === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : kind === 'integer' ? Number.isInteger(value) : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === kind)) fail('Invalid producer field type.');
  }
  if (typeof value === 'string' && rule.minLength && [...value].length < rule.minLength) fail('Empty producer field.');
  if (typeof value === 'number' && (rule.minimum !== undefined && value < rule.minimum || rule.exclusiveMinimum !== undefined && value <= rule.exclusiveMinimum)) fail('Invalid producer number.');
  if (Array.isArray(value)) {
    if (rule.minItems && value.length < rule.minItems || rule.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail('Invalid producer references.');
    if (rule.items) for (const item of value) schema(item, rule.items);
  } else if (value && typeof value === 'object') {
    if (rule.required?.some(key => !Object.hasOwn(value, key))) fail('Incomplete producer artifact.');
    for (const key of Object.keys(value)) {
      if (rule.additionalProperties === false && !Object.hasOwn(rule.properties, key)) fail('Unsupported producer field.');
      if (rule.properties?.[key]) schema(value[key], rule.properties[key]);
    }
  }
}
function validate(packet, target) {
  schema(packet, require('./producer-schema/evidence.schema.json')); schema(target, require('./producer-schema/target.schema.json'));
  const items = new Map(), channel = { transcript: 'audio', ocr: 'ocr', visual_description: 'vision' };
  for (const item of packet.evidence) {
    if (items.has(item.id) || !item.id.trim() || !item.text.trim()) fail('Duplicate or blank evidence identity/text.');
    if (!(0 <= item.start_seconds && item.start_seconds <= item.end_seconds && item.end_seconds <= packet.duration_seconds)) fail('Evidence time is outside the clip.');
    if (packet.channels[channel[item.kind]] !== 'available') fail('Evidence contradicts channel status.');
    items.set(item.id, item);
  }
  for (const [key, state] of Object.entries(packet.channels)) if (state === 'available' && !packet.evidence.some(x => channel[x.kind] === key)) fail('Available channel has no evidence.');
  const ids = new Set();
  for (const group of ['claims', 'steps', 'conflicts', 'unknowns', 'omissions']) for (const item of target[group]) {
    if (!item[group === 'omissions' ? 'reason' : 'text'].trim() || item.evidence_ids.some(id => !items.has(id))) fail('Blank text or missing evidence reference.');
    if (group === 'claims') {
      if (ids.has(item.id)) fail('Duplicate claim identity.'); ids.add(item.id);
      const kinds = new Set(item.evidence_ids.map(id => items.get(id).kind));
      const expected = { narration: 'transcript', screen_extraction: 'ocr', visual_description: 'visual_description' }[item.attribution];
      if (item.attribution === 'combined_evidence' ? kinds.size < 2 : kinds.size !== 1 || !kinds.has(expected)) fail('Claim attribution contradicts evidence.');
    }
    if (group === 'steps' && item.command !== null && (!item.command.trim() || !item.evidence_ids.some(id => { const e = items.get(id); return e.review_flag === 'normal' && ['transcript', 'ocr'].includes(e.kind) && e.text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).includes(item.command); }))) fail('Command has no exact normal evidence line.');
  }
  if (!target.title.trim() || target.steps.some((step, index) => step.order !== index + 1)) fail('Invalid title or step order.');
  const missing = Object.values(packet.channels).some(x => x !== 'available'), uncertain = packet.evidence.filter(x => x.review_flag === 'uncertain');
  for (const unknown of target.unknowns) if (unknown.basis === 'evidence' && !unknown.evidence_ids.length || unknown.basis === 'missing_channel' && !missing || unknown.basis === 'truncated' && !packet.truncated) fail('Uncertainty contradicts evidence.');
  if (missing && !target.unknowns.some(x => x.basis === 'missing_channel') || packet.truncated && !target.unknowns.some(x => x.basis === 'truncated') || uncertain.some(e => ![...target.unknowns, ...target.omissions].some(x => x.evidence_ids.includes(e.id)))) fail('Missing explicit uncertainty.');
  if ((missing || packet.truncated || uncertain.length || target.conflicts.length || target.unknowns.length) && target.status === 'complete' || !items.size && target.status !== 'insufficient_evidence') fail('Completeness contradicts evidence.');
}
const placeholder = value => `[REDACTED:${hash(value).slice(0, 12)}]`;
function redact(text) {
  for (const pattern of [/\b(?:api[_-]?key|access[_-]?token|aws_secret_access_key|client_secret|secret|password|authorization)["']?\s*[:=]\s*(?:Bearer\s+)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;]+))/gi, /\bBearer\s+([A-Za-z0-9._~+/=-]+)/gi]) {
    text = text.replace(pattern, (whole, ...args) => { const value = args.slice(0, -2).find(x => x !== undefined); if (value.startsWith('[REDACTED:')) return whole; const start = whole.lastIndexOf(value); return whole.slice(0, start) + placeholder(value) + whole.slice(start + value.length); });
  }
  for (const pattern of [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, /\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g]) text = text.replace(pattern, placeholder);
  return text;
}
function literal(text) {
  text = redact(text).replace(/\r\n?/g, '\n'); const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(x => x[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
function number(value) {
  // Python's :g defaults to six significant figures.
  if (!value) return '0';
  const [mantissa, exponent] = value.toExponential(5).split('e'), exp = Number(exponent);
  if (exp < -4 || exp >= 6) return `${mantissa.replace(/\.?0+$/, '')}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return Number(value.toPrecision(6)).toString();
}
function render(packet, target) {
  const lines = ['# Source notes', '', '> Untrusted source content. Claims are not independently verified. Commands are inert text.', '', literal(target.title), '', `Status: ${target.status}`];
  for (const [group, label] of [['claims', 'Claims'], ['steps', 'Steps'], ['conflicts', 'Conflicts'], ['unknowns', 'Unknowns'], ['omissions', 'Omissions']]) {
    lines.push('', `## ${label}`); if (!target[group].length) lines.push('', 'None recorded.');
    for (const item of target[group]) {
      lines.push('', literal(item.text ?? item.reason));
      if (group === 'steps') { lines.push('', `Order: ${item.order}`); if (item.command !== null) lines.push('', 'Exact command:', '', literal(item.command)); }
      if (group === 'claims') lines.push('', `Attribution: ${item.attribution}`);
      if (group === 'unknowns') lines.push('', `Basis: ${item.basis}`);
      lines.push('', 'Evidence references:', '', literal(item.evidence_ids.join(', ') || 'None'));
    }
  }
  lines.push('', '## Evidence index', '', `Truncated: ${packet.truncated}`);
  for (const [key, state] of Object.entries(packet.channels)) lines.push(`- ${key}: ${state}`);
  for (const item of packet.evidence) lines.push('', literal(item.id), '', `Kind: ${item.kind}; time: ${number(item.start_seconds)}–${number(item.end_seconds)}s; review: ${item.review_flag}`, '', literal(item.text));
  return lines.join('\n') + '\n';
}
function bound(packet, target) {
  const unknowns = [], variants = [];
  const uncertain = packet.evidence.filter(x => x.review_flag === 'uncertain').map(x => x.id);
  if (uncertain.length) unknowns.push({ text: 'These extractions are uncertain and require source review.', basis: 'evidence', evidence_ids: uncertain });
  const missing = Object.entries(packet.channels).filter(([, value]) => value !== 'available').map(([key, value]) => `${key}: ${value}`);
  if (missing.length) unknowns.push({ text: `Unavailable channels: ${missing.join('; ')}.`, basis: 'missing_channel', evidence_ids: [] });
  if (packet.truncated) unknowns.push({ text: 'Evidence extraction reached its sampling cap.', basis: 'truncated', evidence_ids: [] });
  unknowns.push({ text: 'These are verbatim extraction excerpts, not verified facts or inferred instructions. Recognition, relevance, completeness and source fidelity require review.', basis: 'not_provided', evidence_ids: [] });
  const omissions = [{ reason: 'Only selected extraction excerpts are shown. Long lines and other details remain in the full evidence; no procedure or conflict resolution is inferred.', evidence_ids: [] }];
  for (const entry of packet.evidence) {
    const texts = [...entry.text].length <= 400 ? [entry.text] : [...new Set(entry.text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).filter(x => x.trim() && [...x].length <= 400))];
    texts.forEach((text, index) => variants.push({ id: `excerpt-${entry.id}-${index}`, text, attribution: { transcript: 'narration', ocr: 'screen_extraction', visual_description: 'visual_description' }[entry.kind], evidence_ids: [entry.id] }));
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  if (target.title !== 'Selected source excerpts (unreviewed)' || target.status !== (packet.evidence.length ? 'partial' : 'insufficient_evidence') || target.steps.length || target.conflicts.length || target.claims.length < (variants.length ? 1 : 0) || target.claims.length > Math.min(8, variants.length) || target.claims.some(claim => !variants.some(v => equal(v, claim))) || !equal(target.unknowns, unknowns) || !equal(target.omissions, omissions)) fail('Bound excerpt generation validation failed.');
}
async function readDraft(folder) {
  const names = ['run.json', 'evidence.json', 'first-pass-target.json', 'notes.md'];
  const read = async () => {
    const result = [];
    for (const name of names) { const file = path.join(folder, name), info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) fail('Unsupported artifact file. Use ordinary complete producer files.'); result.push(await fs.readFile(file)); }
    return result;
  };
  let bytes; try { bytes = await read(); } catch (error) { if (error.code === 'ENOENT') fail('Incomplete transfer: run, evidence, first-pass target and notes are required. Retry after producer completion.'); throw error; }
  let run, packet, target; try { [run, packet, target] = bytes.slice(0, 3).map(x => JSON.parse(x.toString('utf8'))); } catch { fail('Unreadable producer JSON. Restore complete producer artifacts and retry.'); }
  if (!run || !['complete', 'partial'].includes(run.state) || run.validation !== 'passed') fail('Producer is not ready: wait for complete/partial with passed validation.');
  if (!/^[a-f0-9]{64}$/.test(run.input_sha256) || !/^[a-f0-9]{64}$/.test(run.job_id) || !/^[a-f0-9]{32}$/.test(run.attempt_id) || packet.clip_id !== run.job_id) fail('Missing or ambiguous source/attempt identity. Restore producer metadata; filenames cannot resolve identity.');
  if (!['local_video', 'synthetic_fixture'].includes(run.input_kind) || run.result_kind !== (run.input_kind === 'local_video' ? 'local_video_unreviewed' : 'synthetic_video_wiring') || typeof run.started_utc !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(run.started_utc) || !Number.isFinite(Date.parse(run.started_utc))) fail('Unsupported producer provenance or source timestamp.');
  if (run.draft_mode !== undefined && run.draft_mode !== 'bound_excerpts_v1') fail('Unsupported draft generation mode.');
  validate(packet, target); if (run.draft_mode) bound(packet, target);
  if ((target.status === 'complete' ? 'complete' : 'partial') !== run.state) fail('Producer terminal state contradicts target completeness.');
  const text = bytes[3].toString('utf8').replace(/\r\n/g, '\n'); if (render(packet, target) !== text) fail('Notes do not match validated producer evidence/target. Restore the ready export and retry.');
  const second = await read(); if (bytes.some((value, i) => !value.equals(second[i]))) fail('Producer files changed during admission. Retry after transfer completes.');
  return { sourceHash: run.input_sha256, identity: `${run.job_id}:${run.attempt_id}`, fingerprint: hash(Buffer.concat(bytes)), run, evidence: packet, target, text, locator: folder, humanReview: 'unreviewed', extraction: target.status, uncertainty: { channels: packet.channels, truncated: packet.truncated, uncertainEvidence: packet.evidence.filter(x => x.review_flag === 'uncertain').map(x => x.id), unknowns: target.unknowns, conflicts: target.conflicts } };
}
module.exports = { readDraft, hash };
