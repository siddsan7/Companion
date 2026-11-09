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
  object(value, ['schema', 'id', 'vault', 'brief', 'createdAt', 'scope', 'requests']);
  if (value.schema !== 1 || !uuid(value.id) || typeof value.createdAt !== 'string' || !Array.isArray(value.requests)) fail();
  root(value.vault); pin(value.brief); if (value.scope) scope(value.scope);
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
// v1 canonical JSON: sorted UTF-16 object keys, array order preserved, JSON primitive spelling.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
module.exports = { conversation, canonical, hash };
