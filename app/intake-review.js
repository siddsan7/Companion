// Portable Reel to MD finalized bundles. Original producer paths are provenance,
// never read targets. Validation includes reviewed exports, which producer's loader
// does not itself compare against the selected target.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, canonical, decode } = require('./producer-json');
const { schema, validate, validateEvidence, render, hash } = require('./intake-producer');
const fail = message => { throw Error(message); };
const equal = (a, b) => require('node:util').isDeepStrictEqual(a, b);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function safeNumbers(value) {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) fail('Unsafe integer in review semantics. Preserve the source and use supported numeric values.');
  if (value && typeof value === 'object') for (const item of Object.values(value)) safeNumbers(item);
}
function candidates(target) {
  const rows = [];
  if (!target || typeof target !== 'object' || Array.isArray(target)) return rows;
  if (typeof target.title === 'string' && target.title.trim()) rows.push({ path: '/title', text: target.title, evidence_ids: [] });
  for (const group of ['claims', 'steps', 'conflicts', 'unknowns', 'omissions']) {
    if (!Array.isArray(target[group])) continue;
    target[group].forEach((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      for (const key of group === 'steps' ? ['text', 'command'] : [group === 'omissions' ? 'reason' : 'text']) if (typeof item[key] === 'string' && item[key].trim()) rows.push({ path: `/${group}/${i}/${key}`, text: item[key], evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids : [] });
    });
  }
  return rows;
}
function validateReview(source, review) {
  schema(review, require('./producer-schema/review.schema.json'));
  if (source.schema_version !== '1.0' || !source.run || !source.evidence || !Array.isArray(source.assets) || !['first_pass', 'reviewed'].includes(source.variant)) fail('Unsupported finalized source structure.');
  for (const value of [source.evidence, source.target, source.candidates, source.assets, source.video, review]) safeNumbers(value);
  // Evidence semantics remain mandatory even when the original target was rejected.
  const packet = source.evidence;
  validateEvidence(packet);
  const synthetic = source.run.input_kind === 'synthetic_fixture' || ['synthetic_wiring_only', 'synthetic_video_wiring'].includes(source.run.result_kind) ? true : source.run.input_kind === 'local_video' || source.run.result_kind === 'local_video_unreviewed' ? false : null;
  if (synthetic === null || synthetic !== source.synthetic) fail('Legacy or unknown review classification. Produce an explicitly classified finalized bundle.');
  if (!equal(candidates(source.target), source.candidates)) fail('Finalized source candidates do not match the original target.');
  for (const key of ['reviewer', 'clip_key', 'source_group', 'condition']) if (!review[key].trim() || [...review[key]].length > 200) fail('Review identity is incomplete.');
  if (!uuid(review.review_id) || review.decision === 'pending' || !['source_reviewed', 'source_matches_attempt', 'unit_coverage_confirmed', 'reference_inventory_complete'].every(key => review[key] === true)) fail('Finalized human decision or attestations are incomplete.');
  if (synthetic && review.split !== 'challenge' || !synthetic && !source.video) fail('Review source classification or video is incomplete.');
  const paths = new Map(source.candidates.map(item => [item.path, item])), units = new Map(), spans = new Set(), covered = new Map(), known = new Set(packet.evidence.map(item => item.id));
  for (const unit of review.units) {
    const original = paths.get(unit.path), span = JSON.stringify([unit.path, unit.start, unit.end]);
    if (units.has(unit.id) || spans.has(span)) fail('Duplicate review atomic unit.');
    units.set(unit.id, unit); spans.add(span);
    const chars = original && [...original.text];
    if (!chars || !Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end) || unit.start >= unit.end || unit.end > chars.length || chars.slice(unit.start, unit.end).join('') !== unit.text) fail('Review unit is not a literal original output span.');
    const intervals = covered.get(unit.path) || []; intervals.push([unit.start, unit.end]); covered.set(unit.path, intervals);
    if (!equal(unit.citations.map(link => link.evidence_id), original.evidence_ids)) fail('Review citations do not match original links.');
    if (unit.factual === null || unit.factual && (unit.input_support === null || unit.source_consistent === null || unit.citations.some(link => link.supports === null || link.supports && (typeof link.evidence_id !== 'string' || !known.has(link.evidence_id)))) || !unit.factual && !unit.exclusion_reason.trim()) fail('Review factual or citation labels are incomplete.');
  }
  for (const [key, original] of paths) {
    const intervals = covered.get(key) || [];
    // Python str.isspace includes C0 separators, but excludes the BOM.
    if (!intervals.length || [...original.text].some((char, i) => !/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(char) && !intervals.some(([start, end]) => start <= i && i < end))) fail('Review units omit original output text.');
  }
  for (const key of ['facts', 'conflicts', 'gaps']) if (new Set(review[key].map(item => item.id)).size !== review[key].length || new Set(review[key].map(item => item.text)).size !== review[key].length) fail('Duplicate review reference item.');
  for (const fact of review.facts) if (fact.recovered_by.some(id => !units.get(id)?.factual) || fact.source_supported && fact.input_available && fact.incorrectly_unknown === null) fail('Review fact judgments are incomplete.');
  for (const item of [...review.conflicts, ...review.gaps]) if (item.represented === null || item.output_paths.some(key => !paths.has(key)) || !!item.output_paths.length !== item.represented) fail('Review conflict/gap judgment is incomplete.');
  if (review.decision === 'edit') { if (!review.corrected_target || equal(review.corrected_target, source.target)) fail('Edit requires a distinct corrected target.'); validate(packet, review.corrected_target); }
  else if (review.corrected_target !== null) fail('Corrections require an edit decision.');
  else if (review.decision === 'accept') validate(packet, source.target);
}
function scores(source, review) {
  const units = new Map(review.units.map(unit => [unit.id, unit])), factual = review.units.filter(unit => unit.factual), facts = review.facts.filter(fact => fact.source_supported), important = facts.filter(fact => fact.important), available = important.filter(fact => fact.input_available);
  const recovered = (fact, input = false) => fact.recovered_by.some(key => units.get(key).source_consistent && (!input || units.get(key).input_support === 'full'));
  const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
  const count = (items, predicate) => items.filter(predicate).length;
  const links = factual.flatMap(unit => unit.citations), ids = new Set(source.evidence.evidence.map(item => item.id)), refs = ['claims', 'steps', 'conflicts', 'unknowns', 'omissions'].flatMap(group => Array.isArray(source.target?.[group]) ? source.target[group].flatMap(item => Array.isArray(item?.evidence_ids) ? item.evidence_ids : []) : []);
  const technical = facts.filter(fact => fact.important && fact.input_available && fact.technical_value !== null), answerable = facts.filter(fact => fact.input_available);
  return { synthesis_recall: ratio(count(available, fact => recovered(fact, true)), available.length), end_to_end_recall: ratio(count(important, fact => recovered(fact)), important.length), unsupported_claim_rate: ratio(count(factual, unit => unit.input_support !== 'full'), factual.length), source_error_rate: ratio(count(factual, unit => !unit.source_consistent), factual.length), citation_support_precision: ratio(count(links, link => link.supports), links.length), reference_validity: ratio(count(refs, ref => typeof ref === 'string' && ids.has(ref)), refs.length), technical_item_accuracy: ratio(count(technical, fact => fact.recovered_by.some(key => units.get(key).source_consistent && units.get(key).text === fact.technical_value)), technical.length), conflict_recall: ratio(count(review.conflicts, item => item.represented), review.conflicts.length), uncertainty_recall: ratio(count(review.gaps, item => item.represented), review.gaps.length), unnecessary_uncertainty: ratio(count(answerable, fact => fact.incorrectly_unknown), answerable.length) };
}
async function readReview(folder) {
  const root = await fs.realpath(folder), captured = new Map(); let total = 0;
  const read = async (name, limit = 16 * 1024 * 1024) => {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || /[. ]$/.test(name)) fail('Unsafe finalized bundle path.');
    const file = path.join(root, ...name.split('/'));
    let current = root;
    for (const part of name.split('/')) { current = path.join(current, part); const info = await fs.lstat(current); if (info.isSymbolicLink()) fail('Finalized bundle paths cannot be links.'); }
    const resolved = await fs.realpath(file), relative = path.relative(root, resolved), info = await fs.lstat(file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !info.isFile() || info.size > limit) fail('Unsupported finalized bundle file.');
    if ((total += info.size) > 256 * 1024 * 1024) fail('Finalized bundle exceeds 256 MiB.');
    const bytes = await fs.readFile(file); if (bytes.length > limit) fail('Finalized bundle file grew during admission.'); captured.set(name, bytes); return bytes;
  };
  const manifestBytes = await read('manifest.json'), manifest = parse(decode(manifestBytes));
  if (manifest.schema_version !== '1.0' || !uuid(manifest.finalization_id) || !uuid(manifest.review_id) || typeof manifest.finalized_utc !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(manifest.finalized_utc) || !Number.isFinite(Date.parse(manifest.finalized_utc)) || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object' || Object.keys(manifest.files).length > 1005) fail('Unsupported finalization manifest identity or structure.');
  if (!['source.json', 'review.json', 'scores.json'].every(name => Object.hasOwn(manifest.files, name)) || Object.hasOwn(manifest.files, 'manifest.json')) fail('Incomplete finalization manifest.');
  for (const [name, expected] of Object.entries(manifest.files)) if (!sha(expected) || hash(await read(name, name.startsWith('assets/') ? 100 * 1024 * 1024 : undefined)) !== expected) fail('Finalized review integrity mismatch.');
  const text = name => decode(captured.get(name)), sourceText = text('source.json'), source = parse(sourceText), review = parse(text('review.json')), metrics = parse(text('scores.json'));
  if (manifest.review_id !== review.review_id) fail('Finalized review identity mismatch.');
  if (hash(canonical(parse(sourceText, true))) !== review.source_digest) fail('Finalized source digest mismatch.');
  validateReview(source, review);
  for (const asset of source.assets) if (!asset || typeof asset.file !== 'string' || !asset.file.startsWith('assets/') || !sha(asset.sha256) || manifest.files[asset.file] !== asset.sha256) fail('Finalization is missing a source asset.');
  if (source.video && (!sha(source.video.sha256) || !source.assets.some(asset => asset.file === source.video.file && asset.sha256 === source.video.sha256))) fail('Finalized video identity is not verified.');
  if (!equal(scores(source, review), metrics)) fail('Stored scores do not match original annotations.');
  const sourceHash = source.run.input_sha256 || source.video?.sha256;
  if (!sha(sourceHash) || source.video && source.video.sha256 !== sourceHash) fail('Missing or inconsistent source byte identity. Produce a finalized bundle with a source hash.');
  if (!uuid(source.run.attempt_id) || !sha(source.run.job_id) || typeof source.run.started_utc !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(source.run.started_utc) || !Number.isFinite(Date.parse(source.run.started_utc))) fail('Missing or unsupported original attempt identity.');
  if (source.evidence.clip_id !== source.run.job_id) fail('Finalized evidence does not match the original attempt identity.');
  const target = review.decision === 'edit' ? review.corrected_target : source.target;
  let notes;
  if (review.decision !== 'reject') {
    if (!['reviewed-target.json', 'reviewed-notes.md'].every(name => Object.hasOwn(manifest.files, name))) fail('Finalization is missing reviewed exports.');
    if (!equal(parse(text('reviewed-target.json')), target) || text('reviewed-notes.md').replace(/\r\n/g, '\n') !== render(source.evidence, target)) fail('Reviewed exports do not match the selected reviewed target.');
    notes = text('reviewed-notes.md').replace(/\r\n/g, '\n');
  } else {
    if (Object.hasOwn(manifest.files, 'reviewed-target.json') || Object.hasOwn(manifest.files, 'reviewed-notes.md')) fail('Rejection must not publish reviewed exports.');
    notes = '> Human review rejected this source. Ineligible as supporting evidence. Original material remains inspectable in revision history.\n';
  }
  // A second complete read prevents accepting a mixed transfer. Hashes are not signatures.
  total = 0;
  for (const [name, bytes] of captured) if (!(await read(name, name.startsWith('assets/') ? 100 * 1024 * 1024 : undefined)).equals(bytes)) fail('Finalized files changed during admission.');
  return { sourceHash, identity: `finalization:${manifest.finalization_id}`, fingerprint: hash(manifestBytes), run: source.run, evidence: source.evidence, target, text: notes, locator: folder, synthetic: source.synthetic, humanReview: review.decision, extraction: ['complete', 'partial', 'insufficient_evidence'].includes(target?.status) ? target.status : 'unknown', processing: source.run.state || 'unknown', supportEligible: review.decision !== 'reject', review, manifest, metrics, reviewSourceText: sourceText, uncertainty: { channels: source.evidence.channels, truncated: source.evidence.truncated, uncertainEvidence: source.evidence.evidence.filter(item => item.review_flag === 'uncertain').map(item => item.id), unknowns: target?.unknowns || [], conflicts: target?.conflicts || [] } };
}
module.exports = { readReview };
