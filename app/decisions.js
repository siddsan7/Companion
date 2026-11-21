const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash, randomUUID } = require('node:crypto');
const { withBriefMutation } = require('./briefs-lock');
const {
  readExactSync, writeStage, removeStageIfPresentSync, publishReplacement, initialPublicationPending, recoverInitialPublication,
  firstPublicationSuffix
} = require('./staged-publication');

// D41-D43: technical decisions are versioned, readable vault notes. Each version is an
// immutable file published exclusively, so an interrupted save can never create a
// duplicate version and earlier wording stays readable after every change.
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const decisionStates = ['active', 'withdrawn', 'superseded'];
const conditionStates = ['active', 'met', 'withdrawn'];
const conditionKinds = ['evidence', 'time'];
const resolutionActions = ['reaffirm', 'revise', 'withdraw', 'dismiss'];
const versionName = /^version-([1-9][0-9]*)\.md$/;
const stageName = /^\.decision-[a-f0-9-]{36}\.pending$/;
const decisionChanged = () => Error('This decision changed since its preview. Review the latest version and preview again.');
const queues = new Map(), lockWait = 10000;
const busy = () => Error('Decision ledger is busy in another Companion window or check. Keep your edits and retry when it finishes.');

function text(value, label, max, { required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw Error(`${label} must be text.`);
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  if (required && !trimmed) throw Error(`${label} is required.`);
  if ([...trimmed].length > max) throw Error(`${label} is longer than ${max} characters.`);
  return trimmed;
}
function list(value, label, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw Error(`${label} must be a list.`);
  const items = value.map(item => text(item, label, maxLength, { required: false })).filter(Boolean);
  if (items.length > maxItems) throw Error(`${label} allows at most ${maxItems} entries.`);
  return [...new Set(items)];
}
const cueTerms = value => list(value, 'Cue terms', 20, 60).map(term => term.toLowerCase().replace(/\s+/g, ' '));
const sourceKey = value => typeof value === 'string' && /^(?:capture|annotation|idea|brief):[\w.-]{1,80}$/.test(value);

function normalizeReference(ref) {
  if (!ref || typeof ref !== 'object' || !sourceKey(ref.key) || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) throw Error('A relied-on source reference is invalid. Choose it again from the current sources.');
  return {
    key: ref.key, digest: ref.digest, title: text(ref.title, 'Source title', 300, { required: false }) || ref.key,
    ...(uuid(ref.revisionId) ? { revision_id: ref.revisionId } : {})
  };
}

// Builds the condition list of a new version from the user's draft and the previous
// version. A condition keeps its version while its wording is unchanged; any change to
// what it watches for publishes a new condition version (D43-I02, D43-I03). Conditions
// removed from the draft stay in the note as withdrawn so their wording remains visible.
function conditionsFor(draft, previous, now) {
  if (!Array.isArray(draft)) throw Error('Revisit conditions must be a list.');
  if (draft.length > 20) throw Error('A decision allows at most 20 revisit conditions.');
  const earlier = new Map((previous?.conditions || []).map(condition => [condition.id, condition]));
  const result = [], seen = new Set();
  for (const input of draft) {
    if (!input || typeof input !== 'object') throw Error('A revisit condition is invalid.');
    const prior = input.id === undefined || input.id === null || input.id === '' ? null : earlier.get(input.id);
    if (input.id && !prior) throw Error('A revisit condition no longer exists in the latest version. Reload the decision.');
    if (prior && seen.has(prior.id)) throw Error('A revisit condition appears twice.');
    const kind = conditionKinds.includes(input.kind) ? input.kind : null;
    if (!kind) throw Error('Choose whether each revisit condition is evidence-based or time-based.');
    const watched = {
      label: text(input.label, 'Condition label', 200), kind,
      trigger: text(input.trigger, 'Condition trigger', 1000), action: text(input.action, 'Condition action', 1000),
      cue_terms: kind === 'evidence' ? cueTerms(input.cueTerms) : [],
      links: kind === 'evidence' ? list(input.links, 'Linked sources', 20, 100).map(key => { if (!sourceKey(key)) throw Error('A linked source is invalid.'); return key; }) : [],
      review_by: kind === 'time' ? input.reviewBy : null
    };
    if (kind === 'time' && !isoDate(watched.review_by)) throw Error('A time-based condition needs a review-by date (YYYY-MM-DD).');
    if (kind === 'evidence' && !watched.cue_terms.length && !watched.links.length) throw Error(`Condition "${watched.label}" needs at least one cue term or linked source so new evidence can be matched locally.`);
    const state = input.state === undefined ? 'active' : input.state;
    if (!conditionStates.includes(state)) throw Error('A revisit condition state is invalid.');
    const same = prior && JSON.stringify(watchedFields(prior)) === JSON.stringify(watched);
    const condition = {
      id: prior?.id || randomUUID(), version: prior ? (same ? prior.version : prior.version + 1) : 1,
      ...watched, state, created_at: same ? prior.created_at : now
    };
    // A changed condition starts active again unless the user withdrew it.
    if (!same && state === 'met') condition.state = 'active';
    seen.add(condition.id); result.push(condition);
  }
  for (const prior of earlier.values()) if (!seen.has(prior.id)) result.push({ ...prior, state: 'withdrawn' });
  return result;
}
const watchedFields = condition => ({
  label: condition.label, kind: condition.kind, trigger: condition.trigger, action: condition.action,
  cue_terms: condition.cue_terms, links: condition.links, review_by: condition.review_by
});

function validRecord(record, id, version) {
  const valid = record && record.artifact_type === 'decision' && record.schema_version === 1 && record.decision_id === id && record.version === version &&
    typeof record.project === 'string' && instant(record.decided_at) && instant(record.saved_at) && decisionStates.includes(record.state) &&
    typeof record.title === 'string' && record.title && typeof record.choice === 'string' && record.choice &&
    Array.isArray(record.reasons) && Array.isArray(record.alternatives) && Array.isArray(record.relied_on) && Array.isArray(record.conditions) &&
    record.conditions.every(c => c && uuid(c.id) && Number.isSafeInteger(c.version) && c.version > 0 && conditionKinds.includes(c.kind) &&
      conditionStates.includes(c.state) && typeof c.label === 'string' && typeof c.trigger === 'string' && typeof c.action === 'string' &&
      Array.isArray(c.cue_terms) && Array.isArray(c.links) && (c.kind !== 'time' || isoDate(c.review_by)) && instant(c.created_at)) &&
    (record.superseded_by === null || uuid(record.superseded_by)) &&
    (record.resolution === null || record.resolution && uuid(record.resolution.notice_id) && resolutionActions.includes(record.resolution.action));
  return !!valid;
}

function bullets(items, empty) { return items.length ? items.map(item => `- ${item.replace(/\n/g, '\n  ')}`).join('\n') : empty; }
function markdown(record) {
  const front = YAML.stringify(record);
  const conditions = record.conditions.length ? record.conditions.map(c => [
    `### ${c.label}`, '',
    `- State: ${c.state}${c.state === 'active' && record.state !== 'active' ? ' (inert: decision is not active)' : ''}`,
    `- Condition version: ${c.version}`,
    `- Kind: ${c.kind === 'time' ? `time-based, review by ${c.review_by}` : 'evidence-based'}`,
    `- Trigger: ${c.trigger}`,
    `- Action: ${c.action}`,
    ...(c.kind === 'evidence' ? [`- Cue terms: ${c.cue_terms.join(', ') || 'none'}`, `- Linked sources: ${c.links.join(', ') || 'none'}`] : [])
  ].join('\n')).join('\n\n') : 'No revisit condition. This decision can never raise a revisit notice.';
  const resolution = record.resolution ? `\n\n## Revisit resolution\n\n- Action: ${record.resolution.action}\n- Notice: ${record.resolution.notice_id}\n- Evidence: ${record.resolution.evidence || 'review-by date'}\n- Reason: ${record.resolution.reason || 'none given'}` : '';
  return `---\n${front}---\n\n# ${record.title}\n\nDecision version ${record.version} · state ${record.state}${record.superseded_by ? ` · superseded by ${record.superseded_by}` : ''} · project ${record.project}\n\n## Choice\n\n${record.choice}\n\n## Reasons\n\n${bullets(record.reasons, 'None recorded.')}\n\n## Alternatives rejected\n\n${bullets(record.alternatives, 'None recorded.')}\n\n## Relied on\n\n${bullets(record.relied_on.map(ref => `${ref.title} (${ref.key}${ref.revision_id ? `, revision ${ref.revision_id}` : ''}, sha256 ${ref.digest})`), 'No recorded sources.')}\n\n## Revisit conditions\n\n${conditions}${resolution}\n`;
}
function parse(bytes) {
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  return YAML.parse(match[1]);
}

class Decisions {
  constructor(vault, { checkpoint = async () => {} } = {}) {
    this.vault = vault; this.checkpoint = checkpoint;
    this.directory = path.join(vault.root, 'Decisions');
  }
  ensureDirectory(directory) {
    try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = local.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Decision storage requires ordinary contained folders. Restore the vault folders and retry.');
  }
  guardFor(directory) {
    const { guard } = this.vault.publicationFolders(directory);
    return guard;
  }
  // One cross-process lock covers the ledger and the revisit records, so a scheduled
  // check and a desktop save never interleave their writes. Work in this process is
  // queued; another process holding the lock is waited for briefly, then reported.
  async lock(work) {
    const key = process.platform === 'win32' ? path.resolve(this.directory).toLowerCase() : path.resolve(this.directory);
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const turn = new Promise(resolve => { release = resolve; }), tail = previous.then(() => turn);
    queues.set(key, tail);
    await previous;
    try { return await this.lockAcrossProcesses(work); }
    finally { release(); if (queues.get(key) === tail) queues.delete(key); }
  }
  async lockAcrossProcesses(work) {
    this.ensureDirectory(this.directory);
    await this.vault.contained(this.directory);
    const deadline = Date.now() + lockWait;
    for (let delay = 25; ; delay = Math.min(delay * 2, 250)) {
      try {
        return await withBriefMutation(this.directory, async () => {
          this.recover();
          return work();
        });
      } catch (error) {
        if (!error.message.startsWith('Project Brief store is busy')) throw error;
        if (Date.now() + delay > deadline) throw busy();
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  decisionDirectories() {
    if (!local.existsSync(this.directory)) return [];
    return local.readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && uuid(entry.name)).map(entry => entry.name);
  }
  recover() {
    for (const id of this.decisionDirectories()) {
      const directory = path.join(this.directory, id), guard = this.guardFor(directory);
      for (const name of local.readdirSync(directory)) {
        if (!name.endsWith(firstPublicationSuffix)) continue;
        const destination = path.join(directory, name.slice(0, -firstPublicationSuffix.length));
        if (versionName.test(path.basename(destination))) recoverInitialPublication(destination, guard, stageName);
      }
    }
  }
  readVersions(id) {
    const directory = path.join(this.directory, id), guard = this.guardFor(directory);
    const numbers = local.readdirSync(directory).map(name => versionName.exec(name)).filter(Boolean).map(match => Number(match[1])).sort((a, b) => a - b);
    const versions = [], issues = [];
    numbers.forEach((number, index) => {
      if (number !== index + 1) { issues.push(`Decision ${id} is missing version ${index + 1}. Later versions are inert until it is restored.`); return; }
      const file = path.join(directory, `version-${number}.md`);
      try {
        const { bytes, proof } = readExactSync(file, guard);
        const record = parse(bytes);
        if (!validRecord(record, id, number)) throw Error('metadata is invalid');
        versions.push({ record, file, digest: proof.digest, content: bytes.toString('utf8') });
      } catch (error) { issues.push(`Decision ${id} version ${number} needs repair: ${error.message}. The file was preserved.`); }
    });
    // A damaged or missing version makes later versions untrustworthy as "current".
    const usable = [];
    for (const version of versions) { if (version.record.version !== usable.length + 1) break; usable.push(version); }
    return { versions: usable, issues, blocked: usable.length !== numbers.length };
  }
  // The whole ledger, read from the notes. Nothing else is authoritative.
  load() {
    const decisions = [], issues = [];
    for (const id of this.decisionDirectories()) {
      const { versions, issues: found, blocked } = this.readVersions(id);
      issues.push(...found);
      if (!versions.length) continue;
      decisions.push({ id, versions, latest: versions.at(-1).record, blocked });
    }
    decisions.sort((a, b) => a.versions[0].record.decided_at.localeCompare(b.versions[0].record.decided_at) || a.id.localeCompare(b.id));
    return { decisions, issues };
  }
  // Builds the next version from a draft. Used by the editor and by notice resolution.
  build(draft, current, now) {
    if (!draft || typeof draft !== 'object') throw Error('Decision draft is invalid.');
    const state = draft.state === undefined ? 'active' : draft.state;
    if (!decisionStates.includes(state)) throw Error('Decision state is invalid.');
    const supersededBy = state === 'superseded' ? draft.supersededBy : null;
    if (state === 'superseded' && (!uuid(supersededBy) || supersededBy === current?.decision_id)) throw Error('Choose the decision that supersedes this one.');
    const conditions = conditionsFor(draft.conditions || [], current, now)
      .map(condition => state === 'withdrawn' ? { ...condition, state: 'withdrawn' } : condition);
    const resolution = draft.resolution ? {
      notice_id: draft.resolution.noticeId, action: draft.resolution.action,
      evidence: typeof draft.resolution.evidence === 'string' ? draft.resolution.evidence : null,
      reason: text(draft.resolution.reason, 'Resolution reason', 1000, { required: draft.resolution.action === 'dismiss' })
    } : null;
    if (resolution && (!uuid(resolution.notice_id) || !resolutionActions.includes(resolution.action))) throw Error('Notice resolution is invalid.');
    const reliedOn = Array.isArray(draft.reliedOn) ? draft.reliedOn.map(normalizeReference) : [];
    if (reliedOn.length > 50) throw Error('A decision can rely on at most 50 sources.');
    return {
      artifact_type: 'decision', schema_version: 1,
      decision_id: current?.decision_id || randomUUID(), version: (current?.version || 0) + 1,
      project: text(draft.project ?? current?.project ?? 'MyTune', 'Project', 120),
      decided_at: current?.decided_at || now, saved_at: now, state, superseded_by: supersededBy,
      title: text(draft.title, 'Decision title', 200), choice: text(draft.choice, 'Choice made', 4000),
      reasons: list(draft.reasons, 'Reasons', 20, 2000), alternatives: list(draft.alternatives, 'Alternatives rejected', 20, 2000),
      relied_on: reliedOn, conditions, resolution
    };
  }
  draftFrom(record) {
    return {
      title: record.title, project: record.project, choice: record.choice, reasons: record.reasons, alternatives: record.alternatives,
      reliedOn: record.relied_on.map(ref => ({ key: ref.key, digest: ref.digest, title: ref.title, revisionId: ref.revision_id })),
      state: record.state, supersededBy: record.superseded_by,
      conditions: record.conditions.filter(c => c.state !== 'withdrawn').map(c => ({ id: c.id, label: c.label, kind: c.kind, trigger: c.trigger, action: c.action, cueTerms: c.cue_terms, links: c.links, reviewBy: c.review_by, state: c.state }))
    };
  }
  // Inside the lock: publishes exactly the previewed version or refuses.
  async publish(record, expectedVersion) {
    const id = record.decision_id, directory = path.join(this.directory, id);
    if (expectedVersion === 0) { if (local.existsSync(directory) && this.readVersions(id).versions.length) throw decisionChanged(); }
    else {
      const { versions, blocked } = this.readVersions(id);
      if (blocked || versions.length !== expectedVersion) throw decisionChanged();
    }
    if (record.version !== expectedVersion + 1) throw decisionChanged();
    this.ensureDirectory(directory);
    await this.vault.contained(directory);
    const guard = this.guardFor(directory);
    const content = markdown(record), destination = path.join(directory, `version-${record.version}.md`);
    const stage = path.join(directory, `.decision-${randomUUID()}.pending`);
    const proof = await writeStage(stage, content, guard);
    try {
      await this.checkpoint('decision-before-publish', { decision: id, version: record.version });
      await publishReplacement(stage, destination, guard, proof, null, { conflict: decisionChanged, stageName });
    } catch (error) {
      try { if (!initialPublicationPending(destination, guard)) removeStageIfPresentSync(stage, guard, proof); }
      catch { error.message += ' The staged decision was preserved for inspection.'; }
      throw error;
    }
    return { file: destination, digest: proof.digest, content };
  }
}

// Condition versions that may still produce candidates or notices (D43-I02).
function activeConditions(decision) {
  const latest = decision.latest;
  if (decision.blocked || latest.state !== 'active') return [];
  return latest.conditions.filter(condition => condition.state === 'active')
    .map(condition => ({ decision: latest, condition }));
}

module.exports = { Decisions, markdown, activeConditions, validRecord, hash, uuid, isoDate };
