const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const { createHash } = require('node:crypto');
const { Transcripts } = require('./transcripts');
const { generations } = require('./source-generations');
const { conversation } = require('./archive-format');
const { uuid } = require('./source-authority');
const { isAnnotationIntent } = require('./annotation-authority');
const { checkIdeaEnvelope } = require('./idea-envelope');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fail = () => { throw Error('Independent writing storage changed or has unknown aliases or linked copies. All writing was preserved. Restore ordinary folders and preview deletion again.'); };
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const scalars = value => Object.values(value).every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item));
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const pin = value => fields(value, ['id', 'version', 'digest']) && uuid(value.id) && Number.isInteger(value.version) && typeof value.digest === 'string';
const anchorFields = ['kind', 'capture_id', 'revision_id', 'snapshot_sha256', 'evidence_id', 'evidence_kind', 'start_seconds', 'end_seconds', 'excerpt', 'excerpt_sha256'];
const metadata = text => { const front = typeof text === 'string' && text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/); try { return front && YAML.parse(front[1]); } catch { return null; } };

// No recovery, corpus, listing API, provider, or provenance locator is used here.
async function reader(root, guard = async () => {}) {
  const parents = new Map(), observations = new Map();
  const directory = async file => {
    const relative = path.relative(root, file);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) fail();
    let current = root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const stat = await fs.lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current || parents.has(current) && !same(parents.get(current), stat)) fail();
      parents.set(current, stat);
    }
    await guard();
  };
  const check = async () => { for (const [file, expected] of parents) { const stat = await fs.lstat(file, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, expected)) fail(); } await guard(); };
  const read = async file => {
    await directory(path.dirname(file));
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) fail();
    const handle = await fs.open(file, 'r');
    try {
      await check();
      if (!same(before, await handle.stat({ bigint: true }))) fail();
      const bytes = await handle.readFile(); await check();
      const after = await fs.lstat(file, { bigint: true });
      if (!same(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.nlink !== after.nlink || BigInt(bytes.length) !== after.size) fail();
      const value = { file: path.relative(root, file).split(path.sep).join('/'), sha256: hash(bytes), dev: String(after.dev), ino: String(after.ino), bytes: String(after.size), links: String(after.nlink) };
      observations.set(file, value);
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = null; }
      return { text, bytes, stat: after, value };
    } finally { await handle.close(); }
  };
  const list = async (file, select) => {
    try { await directory(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const names = (await fs.readdir(file, { withFileTypes: true })).filter(select).sort((a, b) => a.name.localeCompare(b.name)); await check();
    observations.set(file, { file: path.relative(root, file).split(path.sep).join('/'), directory: names.map(item => item.name), dev: String(parents.get(file).dev), ino: String(parents.get(file).ino) });
    return names;
  };
  return { read, list, check, observations };
}

// This exception recognizes only an exact, still-owned independent publication.
// It confers no removal authority and is rechecked during every deletion recovery.
async function pureWritingPending(vault, file) {
  const area = path.basename(path.dirname(file)), operation = path.basename(file).match(/^([a-f0-9-]{36})\.md\.pending$/)?.[1];
  if (!uuid(operation) || !['.ideas', '.transcripts'].includes(area) || path.dirname(file) !== path.join(vault.root, area)) return false;
  const io = await reader(vault.vault);
  const journal = await io.read(path.join(path.dirname(file), operation + '.intent.json'));
  const value = JSON.parse(journal.text);
  const transcript = area === '.transcripts' ? new Transcripts({}) : null;
  if (journal.stat.nlink !== 1n || !journal.bytes.equals(Buffer.from(JSON.stringify(value, null, 2)))) fail();
  if (area === '.ideas') {
    checkIdeaEnvelope(value, vault, fail);
    const front = metadata(value.text);
    // The existing Ideas.intent ownership contract, checked on these guarded raw bytes.
    if (value.schema !== 1 || value.operation !== operation || !uuid(value.id) || value.vault !== vault.root || typeof value.destination !== 'string' || path.dirname(value.destination) !== path.join(vault.root, 'Ideas') || !path.basename(value.destination).endsWith(`--${value.id}.md`) || typeof value.text !== 'string' || hash(Buffer.from(value.text)) !== value.digest || front?.artifact_type !== 'saved_idea' || front.schema_version !== 1 || front.companion_id !== value.id || value.input.conversationId !== front.origin?.conversation_id || value.input.requestId !== front.origin?.request_id || typeof front.created_at !== 'string' || !Number.isFinite(Date.parse(front.created_at))) return false;
  } else { transcript.validateIntent(value, operation, vault); transcript.guard(vault, value.destination); }
  const front = metadata(value.text);
  if (!front || front.schema_version !== 1 || front.companion_id !== value.id || front.artifact_type !== (area === '.ideas' ? 'saved_idea' : 'conversation_transcript')) return false;
  if (area === '.ideas' && !fields(front, ['artifact_type', 'schema_version', 'companion_id', 'title', 'created_at', 'idea_kind', 'experiment', 'source_dependencies', 'project_brief_version', 'project_brief', 'support_attribution_unavailable', 'citations', 'origin'])) return false;
  if (area === '.transcripts' && !fields(front, ['artifact_type', 'schema_version', 'companion_id', 'created_at', 'conversation_id', 'conversation_sha256', 'project_brief', 'requests', 'warnings'])) return false;
  if (!pin(front.project_brief)) return false;
  if (area === '.ideas') {
    if (!fields(front.origin, ['conversation_id', 'request_id', 'package_sha256', 'reply_sha256', 'status']) || !scalars(front.origin) || !Array.isArray(front.source_dependencies) || !Array.isArray(front.citations)) return false;
    if (front.experiment !== undefined && (!fields(front.experiment, ['hypothesis', 'borrowed_mechanism', 'project_application', 'smallest_test', 'observable_result']) || !scalars(front.experiment))) return false;
    if (front.source_dependencies.some(dep => !fields(dep, ['capture_id', 'revision_id', 'content_sha256', 'source_generation']) || !scalars(dep)) || front.citations.some(anchor => !fields(anchor, anchorFields) || !scalars(anchor))) return false;
  } else {
    if (!Array.isArray(front.requests) || !strings(front.warnings)) return false;
    for (const request of front.requests) {
      if (!fields(request, ['request_id', 'status', 'package_sha256', 'source_dependencies', 'historical_refs', 'historical_request_ids']) || !Array.isArray(request.source_dependencies) || !Array.isArray(request.historical_refs) || !strings(request.historical_request_ids)) return false;
      for (const dep of request.source_dependencies) { if (!fields(dep, ['key', 'digest', 'captureId', 'revisionId', 'sourceGenerations'])) return false; generations(dep.sourceGenerations); }
      if (request.historical_refs.some(ref => !fields(ref, ['conversationId', 'requestId', 'digest']) || !scalars(ref))) return false;
    }
  }
  const stage = await io.read(file);
  if (!stage.bytes.equals(Buffer.from(value.text)) || stage.value.sha256 !== value.digest) return false;
  let saved;
  if (stage.stat.nlink === 2n) {
    const output = await io.read(value.destination);
    if (output.stat.nlink !== 2n || !same(stage.stat, output.stat) || !output.bytes.equals(stage.bytes)) fail();
    if (transcript && !value.stageProof) {
      // Older writers recorded the original pair in the receipt only.
      const receipt = await io.read(path.join(path.dirname(file), operation + '.published.json'));
      saved = transcript.validateReceipt(value, JSON.parse(receipt.text));
      if (receipt.stat.nlink !== 1n || !receipt.bytes.equals(Buffer.from(JSON.stringify(saved, null, 2)))) fail();
    }
  } else if (stage.stat.nlink !== 1n) fail();
  transcript?.checkStage(value, stage.stat, saved);
  await io.check(); return true;
}

async function inventory(vault, conversations, captureId) {
  const io = await reader(vault.vault), rows = [], artifacts = [], records = [], keys = new Set([`capture:${captureId}`]);
  const add = (kind, file, text, data, extra = {}) => artifacts.push({ kind, file, text: text === null ? 'Writing has invalid UTF-8. Dependency attribution is unknown; preserve this file for review.' : text, data, ...extra });
  const markdown = async directory => {
    for (const entry of await io.list(directory, entry => !entry.name.startsWith('.') && entry.name.toLowerCase() !== 'managed-home' && (entry.isSymbolicLink() || entry.isDirectory() || /\.md$/.test(entry.name)))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail();
      if (entry.isDirectory()) await markdown(file);
      else {
        const value = await io.read(file), data = metadata(value.text);
        if (['annotation', 'saved_idea', 'conversation_transcript'].includes(data?.artifact_type)) add(data.artifact_type, value.value.file, value.text, data);
        else if ([path.join(vault.root, 'Annotations'), path.join(vault.root, 'Ideas')].includes(directory)) add('unknown writing', value.value.file, value.text, data);
      }
    }
  };
  await markdown(vault.vault);
  for (const area of ['.ideas', '.transcripts']) {
    const directory = path.join(vault.root, area);
    for (const entry of await io.list(directory, entry => /\.(?:intent\.json|md\.pending|published\.json)$/.test(entry.name) || area === '.transcripts' && entry.name.endsWith('.link.json') || area === '.ideas' && /\.(?:prepared\.json|attempt\.json|links-[1-9][0-9]*\.(?:json|pending\.json|stage))$/.test(entry.name))) {
      const file = path.join(directory, entry.name), value = await io.read(file);
      if (entry.name.endsWith('.md.pending')) add(area === '.ideas' ? 'pending idea stage' : 'pending transcript stage', value.value.file, value.text, metadata(value.text));
      else if (area === '.ideas' && entry.name.endsWith('.stage')) add('retained idea link repair stage', value.value.file, value.text, metadata(value.text));
      else if (entry.name.endsWith('.intent.json')) {
        let intent; try { intent = JSON.parse(value.text); } catch {}
        add(area === '.ideas' ? 'retained idea intent' : 'retained transcript intent', value.value.file, typeof intent?.text === 'string' ? intent.text : value.text, typeof intent?.text === 'string' ? metadata(intent.text) : null, { retained: intent });
      }
    }
  }
  const intake = path.join(vault.root, '.intake');
  for (const entry of await io.list(intake, entry => isAnnotationIntent(entry.name) || /^(?:annotation-[a-f0-9-]{36}\.stage|(?:link|repair)-(?:intent|[a-f0-9-]{36})\.json|link-[a-f0-9-]{36}\.(?:before\.md|stage|held-.*\.md))$/.test(entry.name))) {
    const value = await io.read(path.join(intake, entry.name)); let retained;
    if (entry.name.endsWith('.json')) { try { retained = JSON.parse(value.text); } catch {} }
    let recognized = false;
    if (retained) {
      for (const key of ['annotation', 'before', 'content']) if (typeof retained[key] === 'string') {
        const data = metadata(retained[key]);
        if (data?.artifact_type === 'annotation') { add('retained annotation ' + key, value.value.file, retained[key], data); recognized = true; }
      }
    }
    if (!recognized) add('retained annotation writing', value.value.file, value.text, metadata(value.text));
  }
  const dependency = dep => {
    if (!dep || typeof dep !== 'object') return 'unknown';
    try { generations(dep.sourceGenerations); } catch { return 'unknown'; }
    if (['captureId', 'capture_id', 'revisionId', 'revision_id', 'source_generation'].some(key => dep[key] !== undefined && !uuid(dep[key]))) return 'unknown';
    if (dep.captureId === captureId || dep.capture_id === captureId || dep.key === `capture:${captureId}` || keys.has(dep.key)) return 'affected';
    if (typeof dep.key !== 'string' && !uuid(dep.capture_id)) return 'unknown';
    return 'unaffected';
  };
  const combine = states => states.includes('affected') ? 'affected' : states.includes('unknown') ? 'unknown' : 'unaffected';
  const artifactState = item => {
    const data = item.data;
    if (!data || data.schema_version !== 1 || !uuid(data.companion_id)) return 'unknown';
    if (data.artifact_type === 'annotation') return uuid(data.capture_id) && (data.source_generation === undefined || uuid(data.source_generation)) ? data.capture_id === captureId ? 'affected' : 'unaffected' : 'unknown';
    if (data.artifact_type === 'saved_idea') return combine([...(data.support_attribution_unavailable ? ['unknown'] : []), ...(Array.isArray(data.source_dependencies) ? data.source_dependencies.map(dependency) : ['unknown']), ...(Array.isArray(data.citations) ? data.citations.map(dependency) : ['unknown'])]);
    if (data.artifact_type === 'conversation_transcript') return combine(Array.isArray(data.requests) ? data.requests.flatMap(request => Array.isArray(request.source_dependencies) ? request.source_dependencies.map(dependency) : ['unknown']) : ['unknown']);
    return 'unknown';
  };
  for (const item of artifacts) if (artifactState(item) === 'affected') keys.add(`${item.data.artifact_type === 'annotation' ? 'annotation' : 'idea'}:${item.data.companion_id}`);
  if (conversations) {
    let directory;
    try { directory = conversations.safeDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (directory) {
      const history = await reader(conversations.dataRoot, () => conversations.safeDirectory(false, directory));
      for (const entry of await history.list(conversations.directory, entry => /^(?:archive-)?[a-f0-9-]{36}\.(?:json|pending)$/.test(entry.name))) {
        const value = await history.read(path.join(conversations.directory, entry.name));
        let record; try { record = conversation(JSON.parse(value.text)); } catch {}
        if (!record) rows.push({ kind: 'conversation writing', file: 'Local history/' + entry.name, attribution: 'unknown', text: 'Dependency attribution is unknown. Preserve and inspect this local history file.' });
        else if (record.vault.root === vault.root) records.push({ record, file: 'Local history/' + entry.name, storage: 'durable' });
      }
      knownPeers(history.observations.values());
      for (const observation of history.observations.values()) io.observations.set('history:' + observation.file, { ...observation, file: 'Local history/' + observation.file });
    }
    for (const [id, overlay] of [...conversations.unsaved].sort(([a], [b]) => a.localeCompare(b))) {
      const { record, proof, directory } = structuredClone(overlay);
      const authority = { record, proof, directory: { dev: String(directory.dev), ino: String(directory.ino) } };
      io.observations.set('unsaved:' + id, { file: 'Unsaved conversation/' + id, sha256: hash(JSON.stringify(authority)) });
      if (record.vault?.root === vault.root) records.push({ record, file: 'Unsaved conversation/' + id, storage: 'unsaved; may not survive restart' });
    }
  }
  const requests = new Map();
  for (const item of records) for (const request of item.record.requests || []) {
    const key = `${item.record.id}:${request.id}`, state = combine([...(Array.isArray(request.package?.dependencies) ? request.package.dependencies.map(dependency) : ['unknown']), ...(Array.isArray(request.package?.historyIds) && (request.package.historyRefs === undefined || Array.isArray(request.package.historyRefs)) ? [] : ['unknown'])]);
    const entry = { ...item, request, state, key }; if (!requests.has(key)) requests.set(key, []); requests.get(key).push(entry);
  }
  for (let pass = 0; pass <= requests.size; pass++) {
    let changed = false;
    for (const variants of requests.values()) for (const entry of variants) {
      const pkg = entry.request.package, refs = [...(Array.isArray(pkg?.historyIds) ? pkg.historyIds.map(id => `${entry.record.id}:${id}`) : []), ...(Array.isArray(pkg?.historyRefs) ? pkg.historyRefs.map(ref => `${ref.conversationId}:${ref.requestId}`) : [])];
      const state = combine([entry.state, ...refs.map(ref => requests.has(ref) ? combine(requests.get(ref).map(item => item.state)) : 'unknown')]);
      if (state !== entry.state) { entry.state = state; changed = true; }
    }
    if (!changed) break;
  }
  for (const variants of requests.values()) for (const entry of variants) if (entry.state !== 'unaffected') rows.push({ kind: 'conversation request', file: entry.file, id: entry.record.id, requestId: entry.request.id, attribution: entry.state, text: `${entry.state === 'affected' ? 'Supporting evidence becomes unavailable.' : 'Dependency attribution is unknown.'} ${entry.request.package?.historyIds?.length || entry.request.package?.historyRefs?.length ? 'Includes derived historical dialogue.' : ''}\nConversation ${entry.record.id}; request ${entry.request.id}; ${entry.request.status}; ${entry.storage}.\n${entry.request.question || ''}\n${entry.request.reply || ''}`, storage: entry.storage });
  for (const item of artifacts) {
    const state = artifactState(item);
    if (state !== 'unaffected') rows.push({ kind: item.kind, file: item.file, id: item.data?.companion_id || null, attribution: state, text: item.text });
  }
  const writingFiles = new Set(artifacts.map(item => item.file));
  knownPeers([...io.observations.values()].filter(item => writingFiles.has(item.file)), [...io.observations.values()]);
  await io.check();
  return { rows: rows.sort((a, b) => a.file.localeCompare(b.file) || (a.requestId || '').localeCompare(b.requestId || '')), observations: [...io.observations.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}
function knownPeers(selected, all) {
  const files = [...selected]; all ||= files;
  for (const item of files) if (!item.directory) {
    const peers = all.filter(peer => !peer.directory && peer.dev === item.dev && peer.ino === item.ino);
    if (peers.length !== Number(item.links) || peers.some(peer => peer.sha256 !== item.sha256 || peer.links !== item.links)) fail();
  }
}
module.exports = { inventory, pureWritingPending };
