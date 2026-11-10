const { isDeepStrictEqual } = require('node:util');
const { parse } = require('./producer-json');
const { schema } = require('./intake-producer');
const { normalizeReview } = require('./intake-review');
const fail = () => { throw Error('Finalized source recovery contains unsupported metadata or writing. Preserve it for explicit review.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const producerId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const label = value => typeof value === 'string' && value.length <= 4096;
const date = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => value === null || Number.isSafeInteger(value) && value >= 0;
const list = value => Array.isArray(value) && value.length <= 1000;
const portable = value => typeof value === 'string' && !!value && !/[\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
const states = ['queued', 'extracting', 'synthesizing', 'validating', 'complete', 'partial', 'failed'];

// Exact known producer metadata, not an arbitrary run payload. This inventory
// wrapper does not broaden or restrict readReview's intake contract.
function knownRun(run) {
  if (!fields(run, ['job_id', 'attempt_id', 'started_utc', 'input_sha256', 'input_kind', 'result_kind', 'state', 'validation', 'draft_mode', 'versions', 'stages', 'transitions', 'input_tokens', 'output_tokens', 'cost_usd', 'paid_cash_usd', 'retry_count', 'schema_repairs', 'current_stage', 'channel_failures', 'error_category', 'latency_seconds', 'model_calls', 'canonical_probe']) || !sha(run.job_id) || !producerId(run.attempt_id) || !date(run.started_utc)) fail();
  if (run.input_sha256 !== undefined && !sha(run.input_sha256) || run.input_kind !== undefined && !['local_video', 'synthetic_fixture'].includes(run.input_kind) || run.result_kind !== undefined && !['local_video_unreviewed', 'synthetic_video_wiring', 'synthetic_wiring_only'].includes(run.result_kind) || run.state !== undefined && !states.includes(run.state) || run.validation !== undefined && !['not_run', 'passed', 'failed'].includes(run.validation) || run.draft_mode !== undefined && !['bound_excerpts_v1', 'conservative_extracts'].includes(run.draft_mode)) fail();
  for (const key of ['input_tokens', 'output_tokens']) if (run[key] !== undefined && !count(run[key])) fail();
  for (const key of ['retry_count', 'schema_repairs']) if (run[key] !== undefined && (!Number.isSafeInteger(run[key]) || run[key] < 0)) fail();
  for (const key of ['cost_usd', 'paid_cash_usd', 'latency_seconds']) if (run[key] !== undefined && !amount(run[key])) fail();
  if (run.current_stage !== undefined && run.current_stage !== null && !label(run.current_stage) || run.error_category !== undefined && !label(run.error_category)) fail();
  if (run.channel_failures !== undefined && (!fields(run.channel_failures, ['audio', 'ocr', 'vision']) || Object.values(run.channel_failures).some(value => !label(value)))) fail();
  if (run.stages !== undefined && (!list(run.stages) || run.stages.some(item => !fields(item, ['name', 'cache_hit', 'status', 'error_category', 'latency_seconds']) || !label(item.name) || typeof item.cache_hit !== 'boolean' || !['success', 'failed'].includes(item.status) || !amount(item.latency_seconds) || item.error_category !== undefined && !label(item.error_category)))) fail();
  if (run.transitions !== undefined && (!list(run.transitions) || run.transitions.some(item => !fields(item, ['state', 'reason', 'utc']) || !states.includes(item.state) || !label(item.reason) || !date(item.utc)))) fail();
  if (run.model_calls !== undefined && (!list(run.model_calls) || run.model_calls.some(item => !fields(item, ['input_tokens', 'output_tokens', 'cost_usd', 'cache_hit']) || !count(item.input_tokens) || !count(item.output_tokens) || !amount(item.cost_usd) || typeof item.cache_hit !== 'boolean'))) fail();
  if (run.versions !== undefined) {
    const value = run.versions;
    if (!fields(value, ['pipeline', 'source_sha256', 'python', 'packages', 'ollama', 'ffmpeg', 'ffprobe', 'tesseract', 'asr_files']) || !sha(value.source_sha256) || !['pipeline', 'python', 'ffmpeg', 'ffprobe', 'tesseract'].every(key => label(value[key])) || value.ollama !== null && !label(value.ollama) || !fields(value.packages, ['jsonschema', 'Pillow', 'faster-whisper', 'av', 'ctranslate2', 'onnxruntime']) || Object.values(value.packages).some(item => item !== null && !label(item)) || !fields(value.asr_files, ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'vocabulary.json']) || Object.values(value.asr_files).some(item => !sha(item))) fail();
  }
  if (run.canonical_probe !== undefined) {
    const value = run.canonical_probe;
    if (!fields(value, ['\ue000', '\u{10000}', 'text', 'numbers']) || Object.keys(value).length !== 4 || !['\ue000', '\u{10000}', 'text'].every(key => label(value[key])) || !Array.isArray(value.numbers) || value.numbers.length > 64 || value.numbers.some(item => typeof item !== 'number' || !Number.isFinite(item))) fail();
  }
}
function knownSource(source) {
  if (!fields(source, ['schema_version', 'attempt', 'original_hashes', 'evidence', 'run', 'target', 'variant', 'target_file', 'target_sha256', 'raw_response', 'synthetic', 'validity', 'assets', 'video', 'video_matches_run', 'candidates']) || source.schema_version !== '1.0' || !label(source.attempt) || !['first_pass', 'reviewed'].includes(source.variant) || source.target_file !== null && !label(source.target_file) || source.target_sha256 !== null && !sha(source.target_sha256) || source.raw_response !== null && typeof source.raw_response !== 'string' || typeof source.synthetic !== 'boolean' || !fields(source.validity, ['schema', 'semantic']) || typeof source.validity.schema !== 'boolean' || typeof source.validity.semantic !== 'boolean' || source.video_matches_run !== null && typeof source.video_matches_run !== 'boolean') fail();
  knownRun(source.run);
  if (!fields(source.original_hashes, ['evidence.json', 'run.json', 'first-pass-target.json', 'first-pass-response.txt', 'notes.md', 'frames.json']) || !sha(source.original_hashes['evidence.json']) || !sha(source.original_hashes['run.json']) || Object.values(source.original_hashes).some(value => !sha(value))) fail();
  if (!list(source.assets) || source.assets.some(item => !fields(item, ['file', 'sha256', 'seconds']) || !portable(item.file) || !item.file.startsWith('assets/') || !sha(item.sha256) || item.seconds !== undefined && !amount(item.seconds))) fail();
  if (source.video !== null && (!fields(source.video, ['original_path', 'sha256', 'file']) || !label(source.video.original_path) || !portable(source.video.file) || !source.video.file.startsWith('assets/') || !sha(source.video.sha256))) fail();
  if (!list(source.candidates) || source.candidates.some(item => !fields(item, ['path', 'text', 'evidence_ids']) || !label(item.path) || typeof item.text !== 'string' || !Array.isArray(item.evidence_ids) || item.evidence_ids.some(value => typeof value !== 'string'))) fail();
  // A rejected original may be null. Other unsupported original target shapes
  // hold here, without changing the human-review reader's rejection semantics.
  if (source.target !== null) schema(source.target, require('./producer-schema/target.schema.json'));
}
function knownManifest(manifest) {
  if (!fields(manifest, ['schema_version', 'finalization_id', 'finalized_utc', 'review_id', 'files']) || manifest.schema_version !== '1.0' || !producerId(manifest.finalization_id) || !producerId(manifest.review_id) || !date(manifest.finalized_utc) || !object(manifest.files) || Object.keys(manifest.files).length > 1005 || !['source.json', 'review.json', 'scores.json'].every(name => sha(manifest.files[name]))) fail();
  for (const [name, value] of Object.entries(manifest.files)) if (!sha(value) || !portable(name) || !['source.json', 'review.json', 'scores.json', 'reviewed-target.json', 'reviewed-notes.md'].includes(name) && !name.startsWith('assets/')) fail();
}
function validateNormalizedReview(revision, captureId, sourceHash) {
  if (!fields(revision, ['schema', 'id', 'captureId', 'importedAt', 'sourceHash', 'identity', 'fingerprint', 'run', 'evidence', 'target', 'text', 'locator', 'synthetic', 'humanReview', 'extraction', 'processing', 'supportEligible', 'review', 'manifest', 'metrics', 'reviewSourceText', 'uncertainty']) || revision.schema !== 1 || !uuid(revision.id) || revision.captureId !== captureId || revision.sourceHash !== sourceHash || !date(revision.importedAt) || !sha(revision.fingerprint) || typeof revision.locator !== 'string' || typeof revision.reviewSourceText !== 'string') fail();
  if (!object(revision.review)) fail();
  knownManifest(revision.manifest); knownSource(parse(revision.reviewSourceText));
  const normalized = normalizeReview(revision.manifest, revision.reviewSourceText, revision.review, revision.metrics);
  // The normalized record passed through JSON.stringify when journaled. Raw
  // int/float/-0 distinctions remain in sourceText and its lossless digest.
  for (const [key, value] of Object.entries(normalized)) if (!isDeepStrictEqual(revision[key], JSON.parse(JSON.stringify(value)))) fail();
  // Original manifest/review/export bytes are not retained here. Their recorded
  // fingerprint is checked against acceptance elsewhere, never reconstructed.
}
module.exports = { validateNormalizedReview };
