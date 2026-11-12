const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { Intake } = require('./intake');
const { sourceInspection } = require('./source-mutation');
const { Briefs } = require('./briefs');
const { readNoteScope, changeNoteScope } = require('./note-scope');
const { scanIdeas } = require('./idea-inventory');
const { createHash, randomUUID } = require('node:crypto');
const { revisionAdmission } = require('./source-authority');
const { comparable } = require('./legacy-capture-ownership');
const { ordinaryDirectories, readExactSync, verifyAbsentSync, verifyStageSync } = require('./staged-publication');
const { generationFields, sameEvidence, sameGenerations, unionGenerations, generationProvenance, scopeKey } = require('./source-generations');
const { serializeSources } = require('./source-excerpts');
const digest = text => createHash('sha256').update(text).digest('hex');
const body = content => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
function importedProvenance(id, revision, snapshotHash) {
  const uncertainty = revision.uncertainty || {};
  return `Imported capture ${id}; exact imported revision ${revision.id}; snapshot sha256 ${snapshotHash}; Processing: ${revision.processing || revision.run?.state || 'unknown'}; Extraction: ${revision.extraction || 'unknown'}; Human review: ${revision.humanReview}; Uncertainty: ${Array.isArray(uncertainty.uncertainEvidence) ? uncertainty.uncertainEvidence.length : 'unknown'} flagged extracts; sampling capped: ${uncertainty.truncated === true ? 'yes' : uncertainty.truncated === false ? 'no' : 'unknown'}. Claims are not independently verified.${revision.synthetic === true || revision.run?.input_kind === 'synthetic_fixture' ? ' Authored synthetic fixture; not real source evidence.' : ''}`;
}
function importedConflictEvidence(id, revision, snapshotHash, localHash) {
  const provenance = `${importedProvenance(id, revision, snapshotHash)} Explicitly selected retained revision; unresolved local conflict. Local changes were not included.`;
  return { provenance, digest: digest(provenance + revision.text + localHash) };
}
// Direct Context callers still honor durable removal. The desktop supplies the
// Ideas store's stronger guard, including its observed directory identity.
function rawIdeaEligibility(vault, id) {
  const directory = path.join(vault.root, '.ideas');
  try {
    const stat = local.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || local.realpathSync(directory) !== directory) throw Error('Saved idea authority requires an ordinary contained .ideas folder.');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!id) return;
  for (const suffix of ['removed.json', 'removed.json.pending']) {
    try { local.lstatSync(path.join(directory, `${id}.${suffix}`)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Error('Saved idea selected for removal is unavailable as context.');
  }
}
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
  constructor(vault, { scopeFile, dependencyValidator = validateDependencies, verifiedInputBound = null, capacityBinding = null, approvals = new Map(), ideaEligibility = rawIdeaEligibility, assertSelection = () => {} } = {}) {
    Object.assign(this, { vault, scopeFile, dependencyValidator, verifiedInputBound, capacityBinding, approvals, ideaEligibility, assertSelection });
  }
  async scope() {
    return (await readNoteScope(this.scopeFile, { assertSelection: this.assertSelection }))?.value.files || [];
  }
  async noteReservation() {
    const intake = new Intake(this.vault);
    const reserved = this.vault.reservedRestorationPaths(await intake.load());
    const { directories, missing } = intake.storage.expected.parents;
    const missingLedgerGuard = missing
      ? ordinaryDirectories(directories.map(directory => directory.file), 'Intake folders changed during note selection.', directories).guard
      : null;
    return file => {
      if (missingLedgerGuard) verifyAbsentSync(intake.dir, missingLedgerGuard);
      else intake.storage.guardSync();
      reserved.guard();
      const relative = comparable(path.relative(this.vault.vault, file).split(path.sep).join('/'));
      if (reserved.paths.has(relative)) throw Error('This note path is reserved for source restoration. Explicit context is unavailable.');
    };
  }
  async readExplicitNote(file, requireAvailable) {
    if (!path.isAbsolute(file) || !/\.(md|txt)$/i.test(file)) throw Error('Choose a Markdown or text note in the selected vault.');
    await this.vault.contained(file);
    const relative = path.relative(this.vault.root, file);
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw Error('Managed material must use its eligible context source, not explicit note inclusion.');
    requireAvailable ||= await this.noteReservation();
    const { guard: guardParents } = this.vault.publicationFolders(path.dirname(file));
    const guard = () => { requireAvailable(file); guardParents(); };
    guard();
    const stat = local.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Choose an ordinary unlinked vault note.');
    const { bytes, proof } = readExactSync(file, guard);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const metadata = match && YAML.parse(match[1]);
    if (metadata && typeof metadata === 'object' && (Object.hasOwn(metadata, 'companion_id') || ['capture', 'annotation', 'saved_idea', 'project_brief', 'conversation_transcript'].includes(metadata.artifact_type))) throw Error('Managed artifact metadata cannot bypass context eligibility through note inclusion.');
    const note = { key: `note:${digest(file)}`, title: path.basename(file), text, provenance: `Explicit vault note ${path.basename(file)}; sha256 ${digest(text)}; user selected; not independently verified`, digest: digest(text) };
    return { note, verify: () => verifyStageSync(file, guard, proof) };
  }
  async note(file) {
    return (await this.readExplicitNote(file)).note;
  }
  async changeScope(update, revalidate = async () => () => {}) {
    let verify = () => {};
    try {
      return await changeNoteScope(this.scopeFile, {
        update,
        assertSelection: this.assertSelection,
        verifyRelated: () => verify(),
        beforePublish: async () => {
          await this.vault.checkpoint('context-before-scope-publish');
          this.assertSelection();
          verify = await revalidate();
        }
      });
    } catch (error) {
      if (error.message.startsWith('Project Brief store is busy')) throw Error('Explicit note scope is busy in another Companion window. Keep the selection and retry after that operation finishes.');
      throw error;
    }
  }
  async include(files) {
    if (!Array.isArray(files)) throw Error('Choose explicit vault notes.');
    const requireAvailable = await this.noteReservation();
    const validate = async () => {
      this.assertSelection();
      const notes = [];
      for (const file of files) notes.push(await this.readExplicitNote(file, requireAvailable));
      return () => { for (const { verify } of notes) verify(); };
    };
    await validate();
    await this.changeScope(current => [...new Set([...current, ...files])], validate);
  }
  async exclude(key) { await this.changeScope(current => current.filter(file => `note:${digest(file)}` !== key)); }
  async corpus({ captureRelationshipIds } = {}) {
    const sources = await sourceInspection(this.vault.root, () => this.sourceCorpusOwned(captureRelationshipIds));
    return this.corpusFromSources(sources);
  }
  conflictChoices(note, capture, sourceHash, ledger, intake, observed, sourceGenerations) {
    const block = ledger.blocks[sourceHash], localHash = digest(note.content);
    if (note.type !== 'reel_import' || capture.rejected || capture.supportEligible === false || capture.reviewChoices?.length ||
        capture.removed || capture.identityIssue || ledger.suppressed.includes(sourceHash) || ledger.pending[sourceHash] ||
        ledger.acceptedCleanup?.sourceHash === sourceHash || comparable(path.resolve(note.file)) !== comparable(path.resolve(intake.destination(capture))) ||
        (block ? block.outputHold !== undefined || !capture.conflict || block.reason !== capture.conflict : !!capture.conflict || localHash === capture.currentHash)) return [];
    const choices = [];
    const exact = file => {
      const parent = this.vault.publicationFolders(path.dirname(file)).guard;
      const guard = () => { intake.storage.guardSync(observed); parent(); };
      const { bytes, proof } = readExactSync(file, guard);
      return { bytes, hash: proof.digest, verify: () => verifyStageSync(file, guard, proof) };
    };
    const add = (source, verify) => {
      Object.assign(source, { captureId: capture.id, ...generationFields(sourceGenerations) });
      source.provenance += generationProvenance(source);
      choices.push({ source, file: note.file, verify });
    };
    let local;
    try {
      local = exact(note.file);
      if (local.hash !== localHash) return [];
      const text = body(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(local.bytes));
      if (text && localHash !== capture.currentHash) add({ key: `conflict-local:${capture.id}`, conflictChoice: 'local', title: `Local writing (conflict): ${note.title}`, text,
        provenance: `Conflicted capture ${capture.id}; exact local content sha256 ${localHash}; user-selected unverified local writing, not producer evidence.`, digest: localHash }, local.verify);
    } catch { return []; }
    const revisionId = capture.currentRevision, admission = revisionAdmission(ledger, revisionId);
    if (!/^[a-f0-9-]{36}$/.test(revisionId) || admission?.captureId !== capture.id || admission.sourceHash !== sourceHash) return choices;
    try {
      const { bytes, hash, verify } = exact(path.join(this.vault.root, 'Revisions', `${revisionId}.json`));
      const revision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (hash !== admission.snapshotHash || revision.id !== revisionId || revision.captureId !== capture.id || revision.sourceHash !== sourceHash ||
          revision.supportEligible === false || !['unreviewed', 'accept', 'edit'].includes(revision.humanReview) || typeof revision.text !== 'string') return choices;
      add({ key: `capture:${capture.id}`, conflictChoice: 'imported', revisionId, title: `Imported revision (conflict): ${note.title}`, text: revision.text,
        ...importedConflictEvidence(capture.id, revision, hash, localHash) }, () => { local.verify(); verify(); });
    } catch { /* A missing or changed snapshot never becomes a selection. */ }
    return choices;
  }
  async sourceCorpusOwned(captureRelationshipIds) {
    const intake = new Intake(this.vault), ledger = await intake.info();
    const observed = intake.storage.expected;
    const notes = await this.vault.list(), issues = [], all = [], manualChoices = [], eligible = new Map(), histories = new Map();
    for (const note of notes) {
      const authority = ledger.sourceAuthority?.[note.id];
      if (authority && authority.phase !== 'active') { issues.push(`Evidence unavailable: ${note.title}; deliberately deleted source.`); continue; }
      const sourceGenerations = authority ? [{ captureId: note.id, generation: authority.generation }] : [];
      if (ledger.identityIssues?.[note.id]) { issues.push(`Evidence unavailable: ${note.title}; resolve capture identity.`); continue; }
      const entry = Object.entries(ledger.captures).find(([, capture]) => capture.id === note.id);
      if (!entry && ['thought', 'link'].includes(note.type)) {
        const metadata = YAML.parse(note.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)[1]);
        const origin = note.type === 'link' ? metadata.provenance === 'user-supplied excerpt; webpage not verified' ? 'user-supplied excerpt; webpage not verified' : 'user-supplied link; webpage not fetched or verified' : 'user capture';
        const source = { key: `capture:${note.id}`, captureId: note.id, title: note.title, text: body(note.content), provenance: `Capture ${note.id}; content sha256 ${digest(note.content)}; ${origin}`, digest: digest(note.content) };
        Object.assign(source, generationFields(sourceGenerations)); source.provenance += generationProvenance(source);
        all.push(source); eligible.set(note.id, source); continue;
      }
      try {
        if (!entry) throw Error('not admitted by intake');
        const [sourceHash, capture] = entry;
        if (capture.conflict || digest(note.content) !== capture.currentHash) manualChoices.push(...this.conflictChoices(note, capture, sourceHash, ledger, intake, observed, sourceGenerations));
        if (capture.rejected || capture.supportEligible === false || capture.reviewChoices?.length || capture.conflict || capture.identityIssue || capture.removed || ledger.suppressed.includes(sourceHash) || ledger.blocks[sourceHash] || ledger.pending[sourceHash]) throw Error(capture.rejected ? 'rejected support' : 'current source eligibility is unresolved');
        if (digest(note.content) !== capture.currentHash) throw Error('local changes conflict with the retained imported revision');
        // Guard every snapshot before the existing immutable-history validator reads it.
        for (const id of capture.revisions) {
          if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('invalid revision identity');
          const file = path.join(this.vault.root, 'Revisions', `${id}.json`);
          await this.vault.contained(file); const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('revision is not an ordinary unlinked file');
        }
        const inspected = await intake.inspect(note.id, { annotations: false }), revision = inspected.revisions.find(item => item.id === capture.currentRevision);
        if (!revision || revision.captureId !== capture.id || revision.sourceHash !== sourceHash || revision.supportEligible === false || revision.humanReview === 'reject' || !['unreviewed', 'accept', 'edit'].includes(revision.humanReview) || typeof revision.text !== 'string') throw Error('current revision is unavailable or rejected');
        const provenance = importedProvenance(note.id, revision, revisionAdmission(ledger, revision.id)?.snapshotHash);
        const source = { key: `capture:${note.id}`, captureId: note.id, revisionId: revision.id, title: note.title, text: revision.text, provenance, digest: digest(provenance + revision.text), linked: inspected.links.map(link => link.related?.id).filter(Boolean) };
        Object.assign(source, generationFields(sourceGenerations)); source.provenance += generationProvenance(source);
        all.push(source); eligible.set(note.id, source); histories.set(note.id, inspected.revisions);
      } catch (error) { issues.push(`Evidence unavailable: ${note.title}; ${error.message}`); }
    }
    if (!intake.storage.matches(await intake.storage.view(), observed)) throw Error('Intake ledger changed during context discovery. Retry against the current authority.');
    const capturePaths = captureRelationshipIds && new Map(notes.filter(note => captureRelationshipIds.has(note.id))
      .map(note => [note.id, { file: note.file, digest: digest(note.content) }]));
    return { intake, ledger, observed, issues, all, manualChoices, eligible, histories, capturePaths };
  }
  async corpusFromSources({ intake, ledger, observed, issues, all, manualChoices = [], eligible, histories, capturePaths }) {
    const included = [];
    const annotationGroups = new Map();
    for (const annotation of await intake.annotations()) {
      if (!annotationGroups.has(annotation.id)) annotationGroups.set(annotation.id, []);
      annotationGroups.get(annotation.id).push(annotation);
    }
    for (const [id, copies] of annotationGroups) {
      try {
        const key = `annotation:${id}`;
        if (ledger.identityIssues?.[key]) throw Error('resolve duplicate annotation identity');
        let annotation = copies[0];
        const choice = ledger.identityChoices?.[key];
        if (copies.length === 1 && choice?.copies.some(copy => copy.file === path.relative(this.vault.vault, annotation.file))) throw Error('recorded excluded annotation requires explicit identity selection');
        if (copies.length > 1) {
          const files = copies.map(note => ({ file: path.relative(this.vault.vault, note.file), hash: digest(note.content) })).sort((a, b) => a.file.localeCompare(b.file));
          if (!choice || !files.some(file => file.file === choice.file) || JSON.stringify(files.filter(file => file.file !== choice.file)) !== JSON.stringify(choice.copies)) throw Error('annotation copies changed; resolve duplicate identity');
          annotation = copies.find(note => path.relative(this.vault.vault, note.file) === choice.file);
        }
        const { content, captureId } = annotation;
        if (!eligible.has(captureId)) throw Error('associated evidence unavailable');
        const metadata = YAML.parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
        const recordedGenerations = metadata.source_generation === undefined ? [] : [{ captureId, generation: metadata.source_generation }];
        if (!sameGenerations({ sourceGenerations: recordedGenerations }, eligible.get(captureId))) throw Error('original source generation is unavailable; independent writing remains');
        // Only the immediate generated body header belongs to Companion.
        // Fix the first metadata boundary before checking it; later links are user writing.
        const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
        const text = content.slice(frontmatter[0].length).replace(/^\r?\n# Annotation\r?\n\r?\nSource: \[Capture\]\([^\r\n]*\)(?:\r?\n|$)/, '').trim();
        all.push({ key, title: `Annotation ${id}`, text, provenance: `Independent user annotation ${id}; content sha256 ${digest(content)}; unversioned capture association ${captureId}; original source revision unknown`, digest: digest(content + eligible.get(captureId).digest), associated: captureId, ...generationFields(recordedGenerations) });
        all.at(-1).provenance += generationProvenance(all.at(-1));
      } catch (error) { issues.push(`Annotation unavailable: ${id}; ${error.message}`); }
    }
    const approvedVersions = new Set();
    for (const { version, pin, error } of await new Briefs(this.vault).pins()) {
      try {
        if (error) throw error;
        // Managed captures used as project documents must not re-enter as opaque quotations.
        for (const snapshot of pin.sources) {
          const match = snapshot.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/), metadata = match && YAML.parse(match[1]);
          if (metadata?.companion_id || metadata?.artifact_type && ['capture', 'annotation', 'saved_idea', 'conversation_transcript'].includes(metadata.artifact_type)) throw Error('managed project-document dependency requires an explicit supported reference');
        }
        const excerpts = pin.sections.map(section => `${section.title}\n${section.text}\n${section.references.map(ref => {
          const snapshot = pin.sources[ref.source];
          return `Project source ${ref.source + 1}; sha256 ${snapshot.sha256}; lines ${ref.start}-${ref.end}\n${snapshot.text.split(/\r?\n/).slice(ref.start - 1, ref.end).join('\n')}`;
        }).join('\n')}`).join('\n\n');
        all.push({ key: `brief:${version}`, briefVersion: version, title: `Approved brief version ${version}`, text: excerpts, provenance: `Approved brief version ${version}; exact approval sha256 ${pin.digest}; reviewed project context; user edits are not independent verification.${pin.issues.length ? ' Warning: brief input changed or unavailable; retained approved evidence.' : ''}`, digest: pin.digest, warnings: pin.issues.length ? [`Approved brief input changed or unavailable for version ${version}; retained evidence is used.`] : [] });
        approvedVersions.add(version);
      } catch (error) { issues.push(`Approved brief version ${version} unavailable: ${error.message}`); }
    }
    this.ideaEligibility(this.vault);
    let ideas;
    const captureIds = new Set([...manualChoices.map(({ source }) => source.captureId), ...(capturePaths?.keys() || [])]);
    try { ideas = await scanIdeas(this.vault, { captureIds }); }
    catch (error) { issues.push(error.message); }
    for (const [id, claims] of ideas?.claims || []) {
      const claim = claims.find(item => item.relevant);
      if (!claim) continue;
      try {
        if (claims.length !== 1) throw Error(`duplicate identity ${id}; preserve and resolve these copies: ${claims.map(item => ideas.relative(item.file)).join(', ')}`);
        if (!claim.savedIdea || claim.stat.nlink !== 1n) throw Error('unsupported saved-idea record or linked file');
        const { content, metadata } = claim;
        this.ideaEligibility(this.vault, id);
        if (metadata.support_attribution_unavailable === true) throw Error('additional source dependency attribution is unavailable');
        const associatedIds = await this.dependencyValidator(metadata.source_dependencies, async dependency => {
          const source = eligible.get(dependency.capture_id); if (!source) return false;
          const recordedGenerations = dependency.source_generation === undefined ? [] : [{ captureId: dependency.capture_id, generation: dependency.source_generation }];
          if (!sameGenerations({ sourceGenerations: recordedGenerations }, source)) return false;
          if (dependency.revision_id !== undefined) {
            const revision = histories.get(dependency.capture_id)?.find(item => item.id === dependency.revision_id);
            return !!revision && revision.supportEligible !== false && ['unreviewed', 'accept', 'edit'].includes(revision.humanReview);
          }
          return !source.revisionId && /^[a-f0-9]{64}$/.test(dependency.content_sha256) && dependency.content_sha256 === source.digest;
        });
        const project = metadata.project_brief_version;
        if (project !== undefined && !approvedVersions.has(project)) throw Error('project brief dependency is unavailable');
        // Legacy provisional records have only a numeric version. New writer records
        // additionally bind the exact approval; neither form loses its dependency.
        if (metadata.project_brief !== undefined) {
          const pin = project !== undefined && await new Briefs(this.vault).pinned(project);
          if (!pin || metadata.project_brief.id !== pin.id || metadata.project_brief.version !== pin.version || metadata.project_brief.digest !== pin.digest) throw Error('exact project brief dependency is unavailable');
        }
        const dependencyText = metadata.source_dependencies.map(dep => `Capture ${dep.capture_id}; ${dep.revision_id ? `exact imported revision ${dep.revision_id}` : `content sha256 ${dep.content_sha256}`}`).join('; ');
        all.push({ key: `idea:${metadata.companion_id}`, title: metadata.title || `Saved idea ${metadata.companion_id}`, text: body(content), provenance: `Saved idea ${metadata.companion_id}; user interpretation, not independently verified; content sha256 ${digest(content)}; dependencies: ${dependencyText || 'explicitly independent user writing'}${project === undefined ? '' : `; approved project brief version ${project}`}`, digest: digest(content + associatedIds.map(id => eligible.get(id).digest).join('') + (project === undefined ? '' : all.find(item => item.key === `brief:${project}`).digest)), associatedIds, projectVersion: project, ...generationFields(unionGenerations(associatedIds.map(id => eligible.get(id)))) });
        all.at(-1).provenance += generationProvenance(all.at(-1));
      } catch (error) { issues.push(`Saved idea unavailable: ${ideas.relative(claim.file)}; ${error.message}`); }
    }
    for (const file of await this.scope()) {
      const key = `note:${digest(file)}`; included.push({ key, file });
      try { all.push(await this.note(file)); } catch (error) { issues.push(`Unavailable explicit note ${path.basename(file)}: ${error.message}`); }
    }
    if (!intake.storage.matches(await intake.storage.view(), observed)) throw Error('Intake ledger changed during context discovery. Retry against the current authority.');
    this.ideaEligibility(this.vault);
    try { ideas?.check(); }
    catch (error) { issues.push(error.message); ideas = null; }
    const available = all.filter(source => {
      if (!source.key.startsWith('idea:')) return true;
      if (!ideas) return false;
      try { this.ideaEligibility(this.vault, source.key.slice(5)); return true; }
      catch (error) { issues.push(`Saved idea unavailable: ${source.title}; ${error.message}`); return false; }
    });
    const keys = available.map(source => source.key), duplicates = new Set(keys.filter((key, i) => keys.indexOf(key) !== i));
    for (const key of duplicates) issues.push(`Evidence unavailable: duplicate source identity ${key}.`);
    const manual = [], normalized = source => ({ ...source, text: source.text.replace(/\r\n?/g, '\n') });
    for (const { source, file, verify } of manualChoices) {
      try {
        const claims = ideas?.captureClaims.get(source.captureId);
        if (claims?.length !== 1 || comparable(claims[0]) !== comparable(file)) throw Error('Capture identity changed.');
        verify(); manual.push(normalized(source));
      }
      catch { issues.push(`Unavailable manual choice ${source.title}; its exact file changed.`); }
    }
    intake.storage.guardSync(observed);
    const result = { all: available.filter(source => !duplicates.has(source.key)).map(normalized), manual, issues, included };
    if (capturePaths) {
      result.captureRelationships = new Map();
      for (const [id, note] of capturePaths) {
        const claims = ideas?.captureClaims.get(id);
        if (claims?.includes(note.file)) result.captureRelationships.set(id, { ...note, claims: [...claims].sort() });
      }
    }
    return result;
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
    return { ...state, all: [...state.all, ...state.manual], matches };
  }
  async approveShortening({ key, digest: expected, sourceGenerations, text }) {
    const { all, manual } = await this.corpus(), source = [...all, ...manual].find(item => item.key === key);
    if (!sameEvidence(source, { key, digest: expected, sourceGenerations })) throw Error('Selected evidence changed or is unavailable. Inspect it again before shortening.');
    if (typeof text !== 'string' || !text.trim() || !source.text.includes(text) || [...text].length >= [...source.text].length) throw Error('Choose a shorter exact passage from the inspected source. Rewriting is not source evidence.');
    const approval = randomUUID();
    this.approvals.set(approval, { root: this.vault.root, key, digest: expected, text, label: 'Explicitly shortened passage', ...generationFields(sourceGenerations) });
    return { approval, text };
  }
  async approvePassage({ key, digest: expected, sourceGenerations, start, end }) {
    const { all, manual } = await this.corpus(), source = [...all, ...manual].find(item => item.key === key);
    if (!sameEvidence(source, { key, digest: expected, sourceGenerations })) throw Error('Selected evidence changed or is unavailable. Inspect its passages again.');
    const lines = source.text.split('\n');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw Error('Passage line range is unavailable.');
    const text = lines.slice(start - 1, end).join('\n'); if (!text.trim()) throw Error('Choose a nonempty passage.');
    const approval = randomUUID(), label = `Explicit passage lines ${start}-${end}`;
    this.approvals.set(approval, { root: this.vault.root, key, digest: expected, text, label, ...generationFields(sourceGenerations) });
    return { approval, text, label };
  }
  async preview({ question, selections, excludedSources = [] }) {
    await this.vault.checkpoint('context-before-preview-read');
    if (!Array.isArray(excludedSources) || excludedSources.some(key => typeof key !== 'string')) throw Error('Invalid explicit package exclusions.');
    const { all: eligible, manual } = await this.corpus(), all = [...eligible, ...manual], excluded = new Set(excludedSources.map(scopeKey)), omissions = [];
    const dependencies = source => [...[source.associated, ...(source.associatedIds || []), source.conflictChoice && source.captureId].filter(Boolean).map(id => `capture:${id}`), ...(source.projectVersion === undefined ? [] : [`brief:${source.projectVersion}`])];
    for (const [token, approval] of this.approvals) {
      const source = all.find(item => item.key === approval.key);
      if (approval.root === this.vault.root && source && (excluded.has(source.key) || dependencies(source).some(key => excluded.has(key)))) this.approvals.delete(token);
    }
    const chosen = selections.map(selection => {
      const source = all.find(source => source.key === selection.key);
      if (!sameEvidence(source, selection)) throw Error('Selected evidence changed or is unavailable. Find context and inspect a new selection.');
      const dependency = dependencies(source).find(key => excluded.has(key));
      if (excluded.has(source.key) || dependency) { omissions.push(`Excluded ${source.title}: ${dependency ? `depends on explicitly removed source ${dependency}` : 'explicitly removed from this package'}.`); return null; }
      if (selection.approval !== undefined) {
        const approved = this.approvals.get(selection.approval);
        if (!approved || approved.root !== this.vault.root || !sameEvidence(approved, source)) throw Error('Shortening approval is unavailable. Inspect and approve the exact passage again.');
        return { ...source, text: approved.text, provenance: `${source.provenance}; ${approved.label}` };
      }
      return source;
    }).filter(Boolean);
    const conflicting = chosen.filter(source => source.conflictChoice).map(source => source.captureId);
    if (new Set(conflicting).size !== conflicting.length) throw Error('Choose one exact local or imported version of each conflicted capture.');
    const { text: serialized, sourceExcerpts } = serializeSources(question, chosen);
    const bound = this.verifiedInputBound;
    if (bound !== null && (!Number.isSafeInteger(bound.maxCodePoints) || bound.maxCodePoints < 1 || typeof bound.model !== 'string' || !bound.model.trim() || typeof bound.evidence !== 'string' || !bound.evidence.trim())) throw Error('Verified input bound is invalid. Preview is blocked until its main-process evidence is repaired.');
    const count = [...serialized].length, limit = Math.min(32000, bound?.maxCodePoints || 32000);
    return { text: serialized, count, limit, blocked: count > limit, digest: digest(serialized), sources: chosen, sourceExcerpts, capacityBinding: this.capacityBinding, boundEvidence: bound ? `${bound.model}: ${bound.evidence}${bound.harnessAndOutputEvidence ? `; ${bound.harnessAndOutputEvidence}` : ''}` : 'No verified provider input bound; default application limit only. Harness and output headroom require separate verification.', warnings: [...omissions, ...chosen.flatMap(source => source.warnings || [])] };
  }
}
function installContext({ ipcMain, getVault, dialog, testRoot, dataRoot, getEvidence, getVerifiedInputBound = async () => null, ideaEligibility = rawIdeaEligibility }) {
  let chain = Promise.resolve(); const approvals = new Map();
  const serial = work => { const next = chain.then(work); chain = next.catch(() => {}); return next; };
  const selectedVault = () => { const selected = getVault(); if (!selected) throw Error('Choose a vault first.'); return selected; };
  const store = async (vault = selectedVault()) => {
    const assertSelection = () => { if (getVault() !== vault) throw Error('Vault selection changed. Select the reviewed vault and try again.'); };
    assertSelection();
    const evidence = getEvidence ? await getEvidence() : null;
    let verifiedInputBound = evidence ? evidence.capacity : await getVerifiedInputBound();
    // Controlled OS/provider-boundary evidence only; never accepted from renderer input.
    if (testRoot && !getEvidence) try { verifiedInputBound = JSON.parse(await fs.readFile(path.join(testRoot, 'context-bound.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assertSelection();
    return new Context(vault, { scopeFile: path.join(dataRoot, `context-settings-${digest(vault.root)}`, 'notes.json'), verifiedInputBound, capacityBinding: evidence?.binding || null, approvals, ideaEligibility, assertSelection });
  };
  ipcMain.handle('context-find', async (_, input) => (await store()).discover(input));
  ipcMain.handle('context-passage', async (_, input) => (await store()).approvePassage(input));
  ipcMain.handle('context-shorten', async (_, input) => (await store()).approveShortening(input));
  ipcMain.handle('context-preview', async (_, input) => (await store()).preview(input));
  ipcMain.handle('context-include', () => {
    const vault = selectedVault();
    return serial(async () => {
      const context = await store(vault);
      const files = testRoot ? JSON.parse(await fs.readFile(path.join(testRoot, 'context-selection.json'), 'utf8')) : (await dialog.showOpenDialog({ title: 'Explicitly include vault notes', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Vault notes', extensions: ['md', 'txt'] }] })).filePaths;
      await context.include(files);
      return true;
    });
  });
  ipcMain.handle('context-exclude', (_, key) => {
    const vault = selectedVault();
    return serial(async () => (await store(vault)).exclude(key));
  });
  return { store, clearApprovals: () => approvals.clear() };
}
module.exports = { Context, installContext, validateDependencies, importedConflictEvidence };
