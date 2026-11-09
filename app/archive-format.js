const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const fail = () => { throw Error('History contains unsupported data. Preserve local files for repair; archive export was blocked.'); };
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail();
  return value;
}
function strings(value) { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail(); }
function pin(value) { object(value, ['id', 'version', 'digest']); if (!uuid(value.id) || !Number.isSafeInteger(value.version) || value.version < 1 || !/^[a-f0-9]{64}$/.test(value.digest)) fail(); }
function scope(value) { object(value, ['version', 'excludedSources', 'excludedHistory']); if (value.version !== null && !uuid(value.version)) fail(); strings(value.excludedSources); strings(value.excludedHistory); if (value.excludedHistory.some(id => !uuid(id))) fail(); }
function root(value) { object(value, ['root']); if (typeof value.root !== 'string') fail(); }
function usage(value) {
  if (value === null) return;
  object(value, ['total', 'last', 'modelContextWindow']);
  const fields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  for (const key of ['total', 'last']) { object(value[key], fields); if (fields.some(field => !Number.isSafeInteger(value[key][field]) || value[key][field] < 0)) fail(); }
  if (value.modelContextWindow !== null && (!Number.isSafeInteger(value.modelContextWindow) || value.modelContextWindow < 0)) fail();
}
function packageRecord(value) {
  object(value, ['schema', 'text', 'digest', 'count', 'limit', 'blocked', 'capacityBinding', 'boundEvidence', 'warnings', 'historyExclusions', 'scope', 'excludedHistory', 'dependencies', 'historyIds', 'brief', 'vault', 'question', 'speculation', 'historyDigest']);
  if (value.schema !== 1 || typeof value.text !== 'string' || hash(value.text) !== value.digest || [...value.text].length !== value.count || !Number.isSafeInteger(value.limit) || typeof value.blocked !== 'boolean' || typeof value.question !== 'string' || typeof value.speculation !== 'boolean') fail();
  for (const key of ['capacityBinding', 'boundEvidence', 'historyDigest']) if (value[key] !== null && typeof value[key] !== 'string') fail();
  strings(value.warnings); strings(value.historyIds); strings(value.excludedHistory); scope(value.scope); pin(value.brief); root(value.vault);
  if (!Array.isArray(value.dependencies) || !Array.isArray(value.historyExclusions)) fail();
  for (const dep of value.dependencies) { object(dep, ['key', 'digest', 'captureId', 'revisionId']); if (typeof dep.key !== 'string' || !/^[a-f0-9]{64}$/.test(dep.digest) || ['captureId', 'revisionId'].some(key => Object.hasOwn(dep, key) && !uuid(dep[key]))) fail(); }
  for (const item of value.historyExclusions) { object(item, ['id', 'reason']); if (!uuid(item.id) || typeof item.reason !== 'string') fail(); }
}
function conversation(value) {
  object(value, ['schema', 'id', 'vault', 'brief', 'createdAt', 'scope', 'requests', 'archiveBinding']);
  if (value.schema !== 1 || !uuid(value.id) || typeof value.createdAt !== 'string' || !Array.isArray(value.requests)) fail();
  root(value.vault); pin(value.brief); if (value.scope) scope(value.scope);
  if (value.archiveBinding !== undefined) mapping(value.archiveBinding);
  const ids = new Set();
  for (const request of value.requests) {
    object(request, ['id', 'question', 'speculation', 'package', 'status', 'reply', 'startedAt', 'completedAt', 'usage', 'usageEvidence', 'messages', 'threadId', 'turnId', 'model', 'evidence', 'error']);
    if (!uuid(request.id) || ids.has(request.id) || typeof request.question !== 'string' || typeof request.reply !== 'string' || typeof request.speculation !== 'boolean' || !['completed', 'failed', 'interrupted', 'cancelled', 'inProgress'].includes(request.status)) fail();
    ids.add(request.id); packageRecord(request.package); usage(request.usage);
    for (const key of ['startedAt', 'completedAt', 'usageEvidence', 'threadId', 'turnId', 'model', 'evidence', 'error']) if (Object.hasOwn(request, key) && request[key] !== null && typeof request[key] !== 'string') fail();
    if (request.messages !== undefined) {
      if (!Array.isArray(request.messages)) fail();
      for (const message of request.messages) { object(message, ['id', 'text', 'phase', 'completed']); if (typeof message.id !== 'string' || typeof message.text !== 'string' || message.phase !== null && typeof message.phase !== 'string' || typeof message.completed !== 'boolean') fail(); }
    }
  }
  return structuredClone(value);
}
function mapping(value, depth = 0) {
  if (depth > 24) fail();
  object(value, ['archiveId', 'originalManagedRoot', 'previous']);
  if (!uuid(value.archiveId) || typeof value.originalManagedRoot !== 'string') fail();
  if (value.previous !== undefined) mapping(value.previous, depth + 1);
}
function scheduleIntent(intent) {
  object(intent, ['schema', 'id', 'anchor', 'vault', 'parent', 'mode', 'reconnectRequired']);
  if (intent.schema !== 1 || !uuid(intent.id) || !Number.isFinite(Date.parse(intent.anchor)) || typeof intent.vault !== 'string' || typeof intent.parent !== 'string' || !['enabled', 'paused', 'disabled'].includes(intent.mode) || intent.reconnectRequired !== true) fail();
}
function inactiveIntent(value) {
  object(value, ['schema', 'archiveId', 'sourceRoot', 'targetRoot', 'intent']);
  if (value.schema !== 1 || !uuid(value.archiveId) || typeof value.sourceRoot !== 'string' || typeof value.targetRoot !== 'string') fail();
  scheduleIntent(value.intent); return value;
}
function coverage(value) {
  object(value, ['mode', 'omitted']);
  if (value.mode !== 'saved-history-only' || !Array.isArray(value.omitted) || value.omitted.length === 0) fail();
  const names = new Set();
  for (const item of value.omitted) {
    object(item, ['name', 'sha256', 'bytes', 'kind']);
    if (typeof item.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,140}\.pending$/.test(item.name) || names.has(item.name) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 128 * 1024 * 1024 || !['validated-conversation', 'unknown-data'].includes(item.kind)) fail();
    names.add(item.name);
  }
  return value;
}
function inactiveCoverage(value) {
  object(value, ['schema', 'archiveId', 'coverage']);
  if (value.schema !== 1 || !uuid(value.archiveId)) fail(); coverage(value.coverage); return value;
}
// v1 canonical JSON: sorted UTF-16 object keys, array order preserved, JSON primitive spelling.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
module.exports = { conversation, canonical, hash };

// Parse selected archive JSON with duplicate-member and nesting checks before trusting a manifest.
function parseArchive(text) {
  let offset = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(text[offset] || '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) { const character = text[offset++]; if (character === '\\') offset++; else if (character === '"') return JSON.parse(text.slice(start, offset)); }
    throw Error('Incomplete archive JSON.');
  };
  const value = depth => {
    if (depth > 48) throw Error('Archive nesting exceeds 48 levels.');
    whitespace(); const character = text[offset];
    if (character === '"') return string();
    if (character === '{' || character === '[') {
      const array = character === '[', result = array ? [] : Object.create(null), keys = new Set(); offset++; whitespace();
      if (text[offset] === (array ? ']' : '}')) { offset++; return result; }
      while (offset < text.length) {
        whitespace(); let key;
        if (!array) { if (text[offset] !== '"') throw Error('Invalid archive member.'); key = string(); if (keys.has(key)) throw Error('Duplicate archive JSON member.'); keys.add(key); whitespace(); if (text[offset++] !== ':') throw Error('Invalid archive member.'); }
        const item = value(depth + 1); if (array) result.push(item); else result[key] = item;
        whitespace(); const end = text[offset++]; if (end === (array ? ']' : '}')) return result; if (end !== ',') throw Error('Invalid archive JSON.');
      }
      throw Error('Incomplete archive JSON.');
    }
    const match = text.slice(offset).match(/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);
    if (!match) throw Error('Invalid archive JSON value.'); offset += match[0].length;
    const result = JSON.parse(match[0]); if (typeof result === 'number' && !Number.isFinite(result)) throw Error('Invalid archive number.'); return result;
  };
  try { const archive = value(0); whitespace(); if (offset !== text.length) throw Error('Trailing archive data.'); return archive; }
  catch (error) { if (error instanceof SyntaxError) throw Error('Invalid archive JSON.'); throw error; }
}
function archiveRecord(value) {
  object(value, ['format', 'version', 'id', 'createdAt', 'appVersion', 'payload', 'integrity', 'coverage']);
  if (value.format !== 'companion-local-history' || value.version !== 1) throw Error('Unsupported history archive format or version.');
  if (!uuid(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.appVersion !== 'string') fail();
  object(value.integrity, ['algorithm', 'digest']);
  if (value.coverage !== undefined) coverage(value.coverage);
  if (value.integrity.algorithm !== 'sha256' || value.integrity.digest !== hash(canonical(value.coverage ? { payload: value.payload, coverage: value.coverage } : value.payload))) throw Error('History archive integrity check failed. Preserve the original file; nothing was restored.');
  const payload = object(value.payload, ['settings', 'contextScopes', 'scheduleIntent', 'vaultBindings', 'conversations']);
  if (payload.settings !== null) { object(payload.settings, ['vault', 'parent', 'inactiveScheduleIntents', 'inactiveArchiveCoverage']); if (typeof payload.settings.vault !== 'string' || typeof payload.settings.parent !== 'string') fail(); if (payload.settings.inactiveScheduleIntents !== undefined) { if (!Array.isArray(payload.settings.inactiveScheduleIntents)) fail(); payload.settings.inactiveScheduleIntents.forEach(inactiveIntent); } if (payload.settings.inactiveArchiveCoverage !== undefined) { if (!Array.isArray(payload.settings.inactiveArchiveCoverage)) fail(); payload.settings.inactiveArchiveCoverage.forEach(inactiveCoverage); } }
  if (!Array.isArray(payload.contextScopes) || !Array.isArray(payload.vaultBindings) || !Array.isArray(payload.conversations)) fail();
  const scopes = new Set(), roots = new Set(), ids = new Set();
  for (const item of payload.contextScopes) { object(item, ['binding', 'schema', 'files']); if (!/^[a-f0-9]{64}$/.test(item.binding) || scopes.has(item.binding) || item.schema !== 1) fail(); strings(item.files); scopes.add(item.binding); }
  for (const binding of payload.vaultBindings) {
    object(binding, ['managedRoot', 'vault', 'parent', 'matchingRequired', 'pins']);
    if (typeof binding.managedRoot !== 'string' || roots.has(binding.managedRoot) || binding.matchingRequired !== true || !Array.isArray(binding.pins) || ['vault', 'parent'].some(key => binding[key] !== null && typeof binding[key] !== 'string')) fail();
    binding.pins.forEach(pin); roots.add(binding.managedRoot);
  }
  if (payload.scheduleIntent !== null) {
    scheduleIntent(payload.scheduleIntent);
  }
  for (const record of payload.conversations) { conversation(record); if (ids.has(record.id) || !roots.has(record.vault.root)) fail(); ids.add(record.id); }
  return structuredClone(value);
}
module.exports.parseArchive = parseArchive;
module.exports.archiveRecord = archiveRecord;
module.exports.inactiveIntent = inactiveIntent;
module.exports.inactiveCoverage = inactiveCoverage;
