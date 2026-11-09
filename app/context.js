const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const { Intake } = require('./intake');
const { Briefs } = require('./briefs');
const { withBriefMutation } = require('./briefs-lock');
const { createHash, randomUUID } = require('node:crypto');
const digest = text => createHash('sha256').update(text).digest('hex');
const body = content => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
// Provisional #11 adapter: unsupported attribution is excluded, never guessed.
async function validateDependencies(dependencies, resolve) {
  if (!Array.isArray(dependencies)) throw Error('source dependency attribution is unavailable');
  const associated = [];
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency.capture_id !== 'string') throw Error('invalid source dependency');
    const resolved = await resolve(dependency);
    if (!resolved) throw Error('source dependency evidence is unavailable');
    associated.push(dependency.capture_id);
  }
  return associated;
}
function passages(text, terms) {
  const lines = text.split('\n'), found = []; let start = 0;
  for (let index = 0; index <= lines.length; index++) if (index === lines.length || !lines[index].trim()) {
    if (start < index) {
      const value = lines.slice(start, index).join('\n'), words = new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []), matched = terms.filter(term => words.has(term));
      if (matched.length) found.push({ start: start + 1, end: index, text: value, matched });
    }
    start = index + 1;
  }
  return found.sort((a, b) => b.matched.length - a.matched.length || a.start - b.start);
}
class Context {
  constructor(vault, { scopeFile, dependencyValidator = validateDependencies, verifiedInputBound = null, capacityBinding = null, approvals = new Map() } = {}) { this.vault = vault; this.scopeFile = scopeFile; this.dependencyValidator = dependencyValidator; this.verifiedInputBound = verifiedInputBound; this.capacityBinding = capacityBinding; this.approvals = approvals; }
  async scope() {
    try { const scope = JSON.parse(await fs.readFile(this.scopeFile, 'utf8')); if (scope.schema !== 1 || !Array.isArray(scope.files) || scope.files.some(file => typeof file !== 'string')) throw Error('Invalid explicit note scope. Preserve settings for repair.'); return scope.files; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async note(file) {
    if (!path.isAbsolute(file) || !/\.(md|txt)$/i.test(file)) throw Error('Choose a Markdown or text note in the selected vault.');
    await this.vault.contained(file);
    const relative = path.relative(this.vault.root, file);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw Error('Managed material must use its eligible context source, not explicit note inclusion.');
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Choose an ordinary unlinked vault note.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file));
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const metadata = match && YAML.parse(match[1]);
    if (metadata && typeof metadata === 'object' && (Object.hasOwn(metadata, 'companion_id') || ['capture', 'annotation', 'saved_idea', 'project_brief'].includes(metadata.artifact_type))) throw Error('Managed artifact metadata cannot bypass context eligibility through note inclusion.');
    return { key: `note:${digest(file)}`, title: path.basename(file), text, provenance: `Explicit vault note ${path.basename(file)}; sha256 ${digest(text)}; user selected; not independently verified`, digest: digest(text) };
  }
  async changeScope(update) {
    const directory = path.dirname(this.scopeFile); await fs.mkdir(directory, { recursive: true });
    try {
      return await withBriefMutation(directory, async () => {
        const files = update(await this.scope()), stage = path.join(directory, `notes-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(stage, JSON.stringify({ schema: 1, files }, null, 2), { flag: 'wx', flush: true });
          await this.vault.checkpoint('context-before-scope-publish');
          await fs.rename(stage, this.scopeFile);
        } finally { await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      });
    } catch (error) {
      if (error.message.startsWith('Project Brief store is busy')) throw Error('Explicit note scope is busy in another Companion window. Keep the selection and retry after that operation finishes.');
      throw error;
    }
  }
  async include(files) {
    if (!Array.isArray(files)) throw Error('Choose explicit vault notes.');
    for (const file of files) await this.note(file);
    await this.changeScope(current => [...new Set([...current, ...files])]);
  }
  async exclude(key) { await this.changeScope(current => current.filter(file => `note:${digest(file)}` !== key)); }
  async corpus() {
    const intake = new Intake(this.vault), ledger = await intake.info();
    const notes = await this.vault.list(), issues = [], included = [], all = [], eligible = new Map(), histories = new Map();
    for (const note of notes) {
      if (ledger.identityIssues?.[note.id]) { issues.push(`Evidence unavailable: ${note.title}; resolve capture identity.`); continue; }
      const entry = Object.entries(ledger.captures).find(([, capture]) => capture.id === note.id);
      if (!entry && ['thought', 'link'].includes(note.type)) {
        const metadata = YAML.parse(note.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);
        const origin = note.type === 'link' ? metadata.provenance === 'user-supplied excerpt; webpage not verified' ? 'user-supplied excerpt; webpage not verified' : 'user-supplied link; webpage not fetched or verified' : 'user capture';
        const source = { key: `capture:${note.id}`, captureId: note.id, title: note.title, text: body(note.content), provenance: `Capture ${note.id}; content sha256 ${digest(note.content)}; ${origin}`, digest: digest(note.content) };
        all.push(source); eligible.set(note.id, source); continue;
      }
      try {
        if (!entry) throw Error('not admitted by intake');
        const [sourceHash, capture] = entry;
        if (capture.rejected || capture.supportEligible === false || capture.reviewChoices?.length || capture.conflict || capture.identityIssue || capture.removed || ledger.suppressed.includes(sourceHash) || ledger.blocks[sourceHash] || ledger.pending[sourceHash]) throw Error(capture.rejected ? 'rejected support' : 'current source eligibility is unresolved');
        if (digest(note.content) !== capture.currentHash) throw Error('local changes conflict with the retained imported revision');
        // Guard every snapshot before the existing immutable-history validator reads it.
        for (const id of capture.revisions) {
          if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('invalid revision identity');
          const file = path.join(this.vault.root, 'Revisions', `${id}.json`);
          await this.vault.contained(file); const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('revision is not an ordinary unlinked file');
        }
        const inspected = await intake.inspect(note.id), revision = inspected.revisions.find(item => item.id === capture.currentRevision);
        if (!revision || revision.captureId !== capture.id || revision.sourceHash !== sourceHash || revision.supportEligible === false || revision.humanReview === 'reject' || !['unreviewed', 'accept', 'edit'].includes(revision.humanReview) || typeof revision.text !== 'string') throw Error('current revision is unavailable or rejected');
        const uncertainty = revision.uncertainty || {};
        const provenance = `Imported capture ${note.id}; exact imported revision ${revision.id}; snapshot sha256 ${Object.values(ledger.attempts).find(item => item.revision === revision.id)?.snapshotHash}; Processing: ${revision.processing || revision.run?.state || 'unknown'}; Extraction: ${revision.extraction || 'unknown'}; Human review: ${revision.humanReview}; Uncertainty: ${Array.isArray(uncertainty.uncertainEvidence) ? uncertainty.uncertainEvidence.length : 'unknown'} flagged extracts; sampling capped: ${uncertainty.truncated === true ? 'yes' : uncertainty.truncated === false ? 'no' : 'unknown'}. Claims are not independently verified.${revision.synthetic === true || revision.run?.input_kind === 'synthetic_fixture' ? ' Authored synthetic fixture; not real source evidence.' : ''}`;
        const source = { key: `capture:${note.id}`, captureId: note.id, revisionId: revision.id, title: note.title, text: revision.text, provenance, digest: digest(provenance + revision.text), linked: inspected.links.map(link => link.related?.id).filter(Boolean) };
        all.push(source); eligible.set(note.id, source); histories.set(note.id, inspected.revisions);
      } catch (error) { issues.push(`Evidence unavailable: ${note.title}; ${error.message}`); }
    }
    const dir = path.join(this.vault.root, 'Annotations'); await this.vault.contained(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const file = path.join(dir, entry.name); await this.vault.contained(file);
        const stat = await fs.lstat(file); if (stat.nlink !== 1) throw Error('linked annotation is unsupported');
        const content = await fs.readFile(file, 'utf8'), match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/), metadata = match && YAML.parse(match[1]);
        if (metadata?.artifact_type !== 'annotation' || metadata.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(metadata.companion_id) || !eligible.has(metadata.capture_id)) throw Error('annotation ownership or associated evidence unavailable');
        all.push({ key: `annotation:${metadata.companion_id}`, title: `Annotation ${metadata.companion_id}`, text: body(content).replace(/^Source: \[Capture\]\([^\r\n]*\)\r?\n?/m, ''), provenance: `Independent user annotation ${metadata.companion_id}; content sha256 ${digest(content)}; unversioned capture association ${metadata.capture_id}; original source revision unknown`, digest: digest(content + eligible.get(metadata.capture_id).digest), associated: metadata.capture_id });
      } catch (error) { issues.push(`Annotation unavailable: ${entry.name}; ${error.message}`); }
    }
    const briefDir = path.join(this.vault.root, 'Briefs'); await this.vault.contained(briefDir);
    const versions = new Set((await fs.readdir(briefDir)).map(name => name.match(/^approved-([1-9][0-9]*)(?:-|\.md$)/)?.[1]).filter(Boolean).map(Number));
    const approvedVersions = new Set();
    for (const version of [...versions].sort((a, b) => a - b)) {
      try {
        const pin = await new Briefs(this.vault).pinned(version);
        // Managed captures used as project documents must not re-enter as opaque quotations.
        for (const snapshot of pin.sources) {
          const match = snapshot.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/), metadata = match && YAML.parse(match[1]);
          if (metadata?.companion_id || metadata?.artifact_type && ['capture', 'annotation', 'saved_idea'].includes(metadata.artifact_type)) throw Error('managed project-document dependency requires an explicit supported reference');
        }
        const excerpts = pin.sections.map(section => `${section.title}\n${section.text}\n${section.references.map(ref => {
          const snapshot = pin.sources[ref.source];
          return `Project source ${ref.source + 1}; sha256 ${snapshot.sha256}; lines ${ref.start}-${ref.end}\n${snapshot.text.split(/\r?\n/).slice(ref.start - 1, ref.end).join('\n')}`;
        }).join('\n')}`).join('\n\n');
        all.push({ key: `brief:${version}`, briefVersion: version, title: `Approved brief version ${version}`, text: excerpts, provenance: `Approved brief version ${version}; exact approval sha256 ${pin.digest}; reviewed project context; user edits are not independent verification.${pin.issues.length ? ' Warning: brief input changed or unavailable; retained approved evidence.' : ''}`, digest: pin.digest, warnings: pin.issues.length ? [`Approved brief input changed or unavailable for version ${version}; retained evidence is used.`] : [] });
        approvedVersions.add(version);
      } catch (error) { issues.push(`Approved brief version ${version} unavailable: ${error.message}`); }
    }
    const ideaDir = path.join(this.vault.root, 'Ideas'); await this.vault.contained(ideaDir);
    for (const entry of await fs.readdir(ideaDir, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const file = path.join(ideaDir, entry.name); await this.vault.contained(file); const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('unsupported saved-idea file');
        const content = await fs.readFile(file, 'utf8'), match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/), metadata = match && YAML.parse(match[1]);
        if (metadata?.artifact_type !== 'saved_idea' || metadata.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(metadata.companion_id)) throw Error('unsupported saved-idea record');
        const associatedIds = await this.dependencyValidator(metadata.source_dependencies, async dependency => {
          const source = eligible.get(dependency.capture_id); if (!source) return false;
          if (dependency.revision_id !== undefined) {
            const revision = histories.get(dependency.capture_id)?.find(item => item.id === dependency.revision_id);
            return !!revision && revision.supportEligible !== false && ['unreviewed', 'accept', 'edit'].includes(revision.humanReview);
          }
          return !source.revisionId && /^[a-f0-9]{64}$/.test(dependency.content_sha256) && dependency.content_sha256 === source.digest;
        });
        const project = metadata.project_brief_version;
        if (project !== undefined && !approvedVersions.has(project)) throw Error('project brief dependency is unavailable');
        const dependencyText = metadata.source_dependencies.map(dep => `Capture ${dep.capture_id}; ${dep.revision_id ? `exact imported revision ${dep.revision_id}` : `content sha256 ${dep.content_sha256}`}`).join('; ');
        all.push({ key: `idea:${metadata.companion_id}`, title: metadata.title || `Saved idea ${metadata.companion_id}`, text: body(content), provenance: `Saved idea ${metadata.companion_id}; user interpretation, not independently verified; content sha256 ${digest(content)}; dependencies: ${dependencyText || 'explicitly independent user writing'}${project === undefined ? '' : `; approved project brief version ${project}`}`, digest: digest(content + associatedIds.map(id => eligible.get(id).digest).join('') + (project === undefined ? '' : all.find(item => item.key === `brief:${project}`).digest)), associatedIds, projectVersion: project });
      } catch (error) { issues.push(`Saved idea unavailable: ${entry.name}; ${error.message}`); }
    }
    for (const file of await this.scope()) {
      const key = `note:${digest(file)}`; included.push({ key, file });
      try { all.push(await this.note(file)); } catch (error) { issues.push(`Unavailable explicit note ${path.basename(file)}: ${error.message}`); }
    }
    const keys = all.map(source => source.key), duplicates = new Set(keys.filter((key, i) => keys.indexOf(key) !== i));
    for (const key of duplicates) issues.push(`Evidence unavailable: duplicate source identity ${key}.`);
    return { all: all.filter(source => !duplicates.has(source.key)).map(source => ({ ...source, text: source.text.replace(/\r\n?/g, '\n') })), issues, included };
  }
  async discover({ question }) {
    const state = await this.corpus(), terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
    const matches = state.all.map(source => ({ ...source, passages: passages(source.text, terms) })).filter(source => source.passages.length).sort((a,b) => b.passages[0].matched.length - a.passages[0].matched.length || a.key.localeCompare(b.key)).map(source => ({ ...source, reason: `Text match: ${source.passages[0].matched.join(', ')}` }));
    const direct = new Set(matches.map(source => source.captureId).filter(Boolean)), projects = new Set(matches.map(source => source.briefVersion).filter(Boolean));
    for (const source of state.all) {
      const associated = [source.associated, ...(source.associatedIds || []), ...(source.linked || [])].find(id => direct.has(id));
      if (associated && !matches.some(item => item.key === source.key)) matches.push({ ...source, reason: `Source association with ${associated}; relevance requires inspection` });
    }
    for (const source of state.all) if (!matches.some(item => item.key === source.key) && projects.has(source.projectVersion)) matches.push({ ...source, reason: `Project association with approved brief version ${source.projectVersion}; relevance requires inspection` });
    return { ...state, matches };
  }
  async approveShortening({ key, digest: expected, text }) {
    const source = (await this.corpus()).all.find(item => item.key === key);
    if (!source || source.digest !== expected) throw Error('Selected evidence changed or is unavailable. Inspect it again before shortening.');
    if (typeof text !== 'string' || !text.trim() || !source.text.includes(text) || [...text].length >= [...source.text].length) throw Error('Choose a shorter exact passage from the inspected source. Rewriting is not source evidence.');
    const approval = randomUUID();
    this.approvals.set(approval, { root: this.vault.root, key, digest: expected, text, label: 'Explicitly shortened passage' });
    return { approval, text };
  }
  async approvePassage({ key, digest: expected, start, end }) {
    const source = (await this.corpus()).all.find(item => item.key === key);
    if (!source || source.digest !== expected) throw Error('Selected evidence changed or is unavailable. Inspect its passages again.');
    const lines = source.text.split('\n');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw Error('Passage line range is unavailable.');
    const text = lines.slice(start - 1, end).join('\n'); if (!text.trim()) throw Error('Choose a nonempty passage.');
    const approval = randomUUID(), label = `Explicit passage lines ${start}-${end}`;
    this.approvals.set(approval, { root: this.vault.root, key, digest: expected, text, label });
    return { approval, text, label };
  }
  async preview({ question, selections, excludedSources = [] }) {
    await this.vault.checkpoint('context-before-preview-read');
    if (!Array.isArray(excludedSources) || excludedSources.some(key => typeof key !== 'string')) throw Error('Invalid explicit package exclusions.');
    const { all } = await this.corpus(), excluded = new Set(excludedSources), omissions = [];
    const dependencies = source => [...[source.associated, ...(source.associatedIds || [])].filter(Boolean).map(id => `capture:${id}`), ...(source.projectVersion === undefined ? [] : [`brief:${source.projectVersion}`])];
    for (const [token, approval] of this.approvals) {
      const source = all.find(item => item.key === approval.key);
      if (approval.root === this.vault.root && source && (excluded.has(source.key) || dependencies(source).some(key => excluded.has(key)))) this.approvals.delete(token);
    }
    const chosen = selections.map(selection => {
      const source = all.find(source => source.key === selection.key);
      if (!source || source.digest !== selection.digest) throw Error('Selected evidence changed or is unavailable. Find context and inspect a new selection.');
      const dependency = dependencies(source).find(key => excluded.has(key));
      if (excluded.has(source.key) || dependency) { omissions.push(`Excluded ${source.title}: ${dependency ? `depends on explicitly removed source ${dependency}` : 'explicitly removed from this package'}.`); return null; }
      if (selection.approval !== undefined) {
        const approved = this.approvals.get(selection.approval);
        if (!approved || approved.root !== this.vault.root || approved.key !== source.key || approved.digest !== source.digest) throw Error('Shortening approval is unavailable. Inspect and approve the exact passage again.');
        return { ...source, text: approved.text, provenance: `${source.provenance}; ${approved.label}` };
      }
      return source;
    }).filter(Boolean);
    const text = `Question:\n${question}\n\nSources:\n${chosen.map(source => `${source.provenance}\n${source.text}`).join('\n\n')}`;
    const serialized = text.replace(/\r\n?/g, '\n');
    const bound = this.verifiedInputBound;
    if (bound !== null && (!Number.isSafeInteger(bound.maxCodePoints) || bound.maxCodePoints < 1 || typeof bound.model !== 'string' || !bound.model.trim() || typeof bound.evidence !== 'string' || !bound.evidence.trim())) throw Error('Verified input bound is invalid. Preview is blocked until its main-process evidence is repaired.');
    const count = [...serialized].length, limit = Math.min(32000, bound?.maxCodePoints || 32000);
    return { text: serialized, count, limit, blocked: count > limit, digest: digest(serialized), sources: chosen, capacityBinding: this.capacityBinding, boundEvidence: bound ? `${bound.model}: ${bound.evidence}${bound.harnessAndOutputEvidence ? `; ${bound.harnessAndOutputEvidence}` : ''}` : 'No verified provider input bound; default application limit only. Harness and output headroom require separate verification.', warnings: [...omissions, ...chosen.flatMap(source => source.warnings || [])] };
  }
}
function installContext({ ipcMain, getVault, dialog, testRoot, dataRoot, getEvidence, getVerifiedInputBound = async () => null }) {
  let chain = Promise.resolve(); const approvals = new Map();
  const serial = work => { const next = chain.then(work); chain = next.catch(() => {}); return next; };
  const store = async () => {
    const vault = getVault(); if (!vault) throw Error('Choose a vault first.');
    const evidence = getEvidence ? await getEvidence() : null;
    let verifiedInputBound = evidence ? evidence.capacity : await getVerifiedInputBound();
    // Controlled OS/provider-boundary evidence only; never accepted from renderer input.
    if (testRoot && !getEvidence) try { verifiedInputBound = JSON.parse(await fs.readFile(path.join(testRoot, 'context-bound.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return new Context(vault, { scopeFile: path.join(dataRoot, `context-settings-${digest(vault.root)}`, 'notes.json'), verifiedInputBound, capacityBinding: evidence?.binding || null, approvals });
  };
  ipcMain.handle('context-find', async (_, input) => (await store()).discover(input));
  ipcMain.handle('context-passage', async (_, input) => (await store()).approvePassage(input));
  ipcMain.handle('context-shorten', async (_, input) => (await store()).approveShortening(input));
  ipcMain.handle('context-preview', async (_, input) => (await store()).preview(input));
  ipcMain.handle('context-include', () => serial(async () => {
    const files = testRoot ? JSON.parse(await fs.readFile(path.join(testRoot, 'context-selection.json'), 'utf8')) : (await dialog.showOpenDialog({ title: 'Explicitly include vault notes', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Vault notes', extensions: ['md', 'txt'] }] })).filePaths;
    await (await store()).include(files); return true;
  }));
  ipcMain.handle('context-exclude', (_, key) => serial(async () => (await store()).exclude(key)));
  return { store };
}
module.exports = { Context, installContext, validateDependencies };
