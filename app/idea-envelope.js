const path = require('node:path');
const { generations } = require('./source-generations');
const { uuid } = require('./source-authority');
const { validProof } = require('./staged-publication');
const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

// Removal recognizes only the writer's known envelopes. Unknown nested fields
// may be independent writing and cannot inherit the selected note's consent.
function checkIdeaEnvelope(value, vault, held) {
  const fields = ['schema', 'operation', 'id', 'vault', 'destination', 'text', 'digest', 'proposalKey', 'warnings', 'input', 'referenceBindings', 'supportState'];
  if (Object.hasOwn(value, 'relationshipBindings')) fields.push('relationshipBindings');
  if (!keys(value, fields)) held();
  const shape = (item, required, optional = []) => item && typeof item === 'object' && !Array.isArray(item) && required.every(key => Object.hasOwn(item, key)) && Object.keys(item).every(key => required.includes(key) || optional.includes(key));
  const text = item => typeof item === 'string';
  const texts = item => Array.isArray(item) && item.every(text);
  const sha = item => text(item) && /^[a-f0-9]{64}$/.test(item);
  const copies = item => Array.isArray(item) && item.every(copy => keys(copy, ['file', 'hash']) && text(copy.file) && sha(copy.hash));
  const identity = item => text(item) && (uuid(item) || /^annotation:[a-f0-9-]{36}$/.test(item) && uuid(item.slice(11)));
  const choice = item => item === null || keys(item, ['file', 'copies']) && text(item.file) && copies(item.copies);
  const issue = item => item === null || item && (
    item.kind === 'duplicate' && keys(item, ['kind', 'id', 'reason', 'files', 'token']) && copies(item.files) ||
    item.kind === 'missing' && keys(item, ['kind', 'id', 'sourceHash', 'reason', 'token']) && sha(item.sourceHash)
  ) && identity(item.id) && text(item.reason) && sha(item.token);
  const input = value.input, experimentFields = ['hypothesis', 'borrowed_mechanism', 'project_application', 'smallest_test', 'observable_result'];
  if (!shape(input, ['conversationId', 'requestId', 'title', 'explanation', 'limitations'], ['kind', 'experiment', 'referenceIds']) || !uuid(input.conversationId) || !uuid(input.requestId) || !['title', 'explanation', 'limitations'].every(key => text(input[key])) || Object.hasOwn(input, 'kind') && !['observation', 'failed_analogy', 'experiment_proposal'].includes(input.kind) || Object.hasOwn(input, 'experiment') && (!keys(input.experiment, experimentFields) || !experimentFields.every(key => text(input.experiment[key]))) || Object.hasOwn(input, 'referenceIds') && (!Array.isArray(input.referenceIds) || !input.referenceIds.every(uuid))) held();
  if (!texts(value.warnings) || !Array.isArray(value.referenceBindings) || !Array.isArray(value.supportState)) held();
  for (const binding of value.referenceBindings) {
    if (!keys(binding, ['referenceId', 'conversationId', 'requestId', 'anchor', 'label']) || ![binding.referenceId, binding.conversationId, binding.requestId].every(uuid) || !text(binding.label)) held();
    const anchor = binding.anchor;
    if (!keys(anchor, ['kind', 'capture_id', 'revision_id', 'snapshot_sha256', 'evidence_id', 'evidence_kind', 'start_seconds', 'end_seconds', 'excerpt', 'excerpt_sha256']) || anchor.kind !== 'imported_evidence' || !uuid(anchor.capture_id) || !uuid(anchor.revision_id) || !sha(anchor.snapshot_sha256) || !text(anchor.evidence_id) || !text(anchor.evidence_kind) || !text(anchor.excerpt) || !sha(anchor.excerpt_sha256) || ![anchor.start_seconds, anchor.end_seconds].every(time => time === null || typeof time === 'number' && Number.isFinite(time))) held();
  }
  for (const state of value.supportState) {
    if (!shape(state, ['key', 'originalDigest', 'currentDigest', 'excluded', 'authority', 'warnings'], ['originalSourceGenerations', 'currentSourceGenerations']) || !text(state.key) || !sha(state.originalDigest) || state.currentDigest !== null && !sha(state.currentDigest) || typeof state.excluded !== 'boolean' || !texts(state.warnings)) held();
    // Legacy six-field records retain their absence; inspecting removal never
    // supplies a generation or repairs historical attribution.
    try {
      if (Object.hasOwn(state, 'originalSourceGenerations')) generations(state.originalSourceGenerations);
      if (Object.hasOwn(state, 'currentSourceGenerations') && state.currentSourceGenerations !== null) generations(state.currentSourceGenerations);
    } catch { held(); }
    const authority = state.authority, captured = ['sourceHash', 'file', 'currentRevision', 'currentHash', 'removed', 'rejected', 'supportEligible', 'conflict', 'pending', 'blocked', 'suppressed'];
    if (!shape(authority, ['identityChoice', 'identityIssue'], captured) || !choice(authority.identityChoice) || !issue(authority.identityIssue)) held();
    if (captured.some(key => Object.hasOwn(authority, key)) && (!keys(authority, ['identityChoice', 'identityIssue', ...captured]) || !sha(authority.sourceHash) || !text(authority.file) || !uuid(authority.currentRevision) || !sha(authority.currentHash) || !captured.slice(4).every(key => typeof authority[key] === 'boolean'))) held();
  }
  if (Object.hasOwn(value, 'relationshipBindings')) {
    const bindings = value.relationshipBindings, seen = new Set();
    const contained = file => {
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || path.extname(file).toLowerCase() !== '.md') return false;
      const relative = path.relative(vault.vault, file);
      return !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
    };
    if (!Array.isArray(bindings)) held();
    for (const binding of bindings) {
      const capture = Object.hasOwn(binding || {}, 'captureId');
      const required = ['file', 'proof', 'label', ...(capture ? ['captureId', 'claims'] : [])];
      if (!keys(binding, required) || !contained(binding.file) || seen.has(binding.label) ||
          !keys(binding.proof, ['dev', 'ino', 'digest']) || !validProof(binding.proof)) held();
      if (capture) {
        if (!uuid(binding.captureId) || binding.label !== `Capture note ${binding.captureId}` || !Array.isArray(binding.claims) ||
            !binding.claims.includes(binding.file) || !binding.claims.every(contained) || new Set(binding.claims).size !== binding.claims.length) held();
      } else if (typeof binding.label !== 'string' || !/^Approved brief version [1-9][0-9]*$/.test(binding.label)) held();
      seen.add(binding.label);
    }
  }
}

module.exports = { checkIdeaEnvelope };
