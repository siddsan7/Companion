const fs = require('node:fs/promises');
const { revisionAdmission } = require('./source-authority');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash, randomUUID } = require('node:crypto');
const { Briefs } = require('./briefs');
const { withBriefMutation } = require('./briefs-lock');
const { IdeasRemoval } = require('./ideas-removal');
const { scanIdeas } = require('./idea-inventory');
const { generations, sameEvidence, sameGenerations } = require('./source-generations');
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function metadata(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return front && YAML.parse(front[1]);
}
class Ideas {
  constructor({ getVault, conversations, clock, open, checkpoint }) {
    Object.assign(this, { getVault, conversations, clock, open, checkpoint });
    this.previews = new Map(); this.roots = new Map(); this.references = new Map(); this.stores = new Map();
    this.removal = new IdeasRemoval(this);
  }
  guard(vault, expected, create = false) {
    const root = path.resolve(vault.vault);
    const reject = () => { throw Error('Saved idea storage requires ordinary contained folders. Restore the vault folders and retry.'); };
    const check = (file, identity) => {
      const stat = local.lstatSync(file, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || local.realpathSync(file) !== file || identity && !same(identity, stat)) reject();
      return stat;
    };
    const anchor = check(root, this.roots.get(root)); this.roots.set(root, anchor);
    let current = root;
    const identities = new Map([[root, anchor]]);
    for (const segment of path.relative(root, vault.root).split(path.sep)) {
      if (!segment || segment === '..') reject();
      current = path.join(current, segment); identities.set(current, check(current, expected?.get(current)));
    }
    for (const area of ['Ideas', '.ideas']) {
      const directory = path.join(vault.root, area);
      const observed = area === '.ideas' && this.stores.get(directory);
      if (observed && !local.existsSync(directory)) reject();
      if (create && area === '.ideas') { try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      if (area === '.ideas' && !create && !local.existsSync(directory)) continue;
      const stat = check(directory, expected?.get(directory));
      if (observed && !same(observed, stat)) reject();
      if (area === '.ideas') this.stores.set(directory, stat);
      identities.set(directory, stat);
    }
    for (const [file, identity] of expected || []) check(file, identity);
    return identities;
  }
  parents(vault, files) {
    const parents = this.guard(vault);
    for (const file of files) {
      const relative = path.relative(vault.vault, path.dirname(file));
      if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw Error('Evidence is outside the selected vault.');
      let directory = path.resolve(vault.vault);
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        directory = path.join(directory, segment);
        const stat = local.lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || local.realpathSync(directory) !== directory) throw Error('Evidence requires ordinary contained folders.');
        parents.set(directory, stat);
      }
    }
    return parents;
  }
  async readFile(vault, file, parents, links = 1) {
    this.guard(vault, parents);
    const handle = await fs.open(file, 'r');
    try {
      this.guard(vault, parents);
      const stat = await handle.stat({ bigint: true }), leaf = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || leaf.isSymbolicLink() || !same(stat, leaf) || stat.nlink !== BigInt(links)) throw Error('Saved idea file is not an ordinary owned file.');
      const text = decode(await handle.readFile()); this.guard(vault, parents);
      if (!same(stat, await fs.lstat(file, { bigint: true }))) throw Error('Saved idea changed while reading.');
      return { text, stat };
    } finally { await handle.close(); }
  }
  async list() {
    const vault = this.getVault(); if (!vault) return [];
    const parents = this.guard(vault), notes = [];
    const inventory = await scanIdeas(vault);
    this.guard(vault, parents);
    for (const [id, claims] of inventory.claims) {
      if (!claims.some(claim => claim.savedIdea && claim.stat.nlink === 1n)) continue;
      if (this.removal.fenced(vault, id)) continue;
      for (const { file, metadata: data, stat } of claims) {
        // A published stage pair stays pending until the exact peer is cleaned up.
        if (!data || stat.nlink !== 1n) continue;
        const unavailable = claims.length !== 1;
        notes.push({ id, title: data.title || `Saved idea ${id}`, file, unavailable, citationCount: !unavailable && Array.isArray(data.citations) ? data.citations.length : 0, supportMetadata: data, identityWarning: unavailable ? `Duplicate saved idea identity. Preserve and resolve these copies: ${claims.map(claim => inventory.relative(claim.file)).join(', ')}.` : null });
      }
    }
    let corpus, supportError;
    if (notes.length) try {
      // Context reads saved metadata directly; it never calls Ideas.list. One
      // corpus provides the same current eligibility used for outgoing context.
      const context = await this.conversations.getContext();
      if (context.vault !== vault) throw Error('Selected vault changed during support inspection.');
      corpus = await context.corpus();
    } catch (error) { supportError = error.message; }
    this.guard(vault, parents); inventory.check();
    if (this.getVault() !== vault) throw Error('Selected vault changed. Inspect saved ideas again.');
    return notes.filter(note => !this.removal.fenced(vault, note.id)).map(({ supportMetadata: data, identityWarning, ...note }) => {
      const warnings = [], dependencies = data.source_dependencies, ids = new Set();
      if (identityWarning) warnings.push(identityWarning);
      if (data.support_attribution_unavailable !== false) warnings.push('Source attribution is unknown or unavailable; retained writing is not verified support.');
      if (!Array.isArray(dependencies)) warnings.push('Recorded source dependency attribution is unavailable.');
      else for (const dep of dependencies) {
        if (!dep || typeof dep !== 'object' || Array.isArray(dep) || Object.keys(dep).some(key => !['capture_id', 'revision_id', 'content_sha256', 'source_generation'].includes(key)) || !uuid(dep.capture_id) || ids.has(dep.capture_id) || dep.source_generation !== undefined && !uuid(dep.source_generation) || (dep.revision_id !== undefined) === (dep.content_sha256 !== undefined) || dep.revision_id !== undefined && !uuid(dep.revision_id) || dep.content_sha256 !== undefined && (typeof dep.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dep.content_sha256))) {
          warnings.push('Recorded source dependency identity is unknown, ambiguous or damaged.'); continue;
        }
        ids.add(dep.capture_id);
        if (!corpus?.all.some(source => source.key === `capture:${dep.capture_id}`)) warnings.push(`Capture ${dep.capture_id}${dep.revision_id ? `; exact revision ${dep.revision_id}` : ''}: current supporting source is unavailable, removed, rejected or otherwise ineligible.`);
      }
      if (!data.project_brief || !uuid(data.project_brief.id) || !Number.isSafeInteger(data.project_brief.version) || data.project_brief.version < 1 || data.project_brief.version !== data.project_brief_version || typeof data.project_brief.digest !== 'string' || !/^[a-f0-9]{64}$/.test(data.project_brief.digest)) warnings.push('Exact project brief attribution is unknown or unavailable.');
      if (supportError) warnings.push(`Current support inspection unavailable: ${supportError}`);
      else if (!corpus?.all.some(source => source.key === `idea:${note.id}`)) {
        warnings.push(...(corpus?.issues || []).filter(issue => issue.startsWith(`Saved idea unavailable: ${inventory.relative(note.file)};`)));
        warnings.push('Recorded dependency or brief support is currently unavailable. Retained writing remains independent and was not rewritten.');
      }
      return { ...note, reviewSupport: warnings.length > 0, supportWarnings: [...new Set(warnings)] };
    });
  }
  async origin(input) {
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    const record = await this.conversations.read(input.conversationId);
    if (record.vault.root !== vault.root) throw Error('This conversation belongs to another vault.');
    const request = record.requests.find(item => item.id === input.requestId);
    if (!request || !request.reply) throw Error('Choose a retained reply with content.');
    return { vault, record, request };
  }
  async draft(input) {
    const { vault, record, request } = await this.origin(input), references = [], warnings = [];
    if (request.status === 'completed') for (const dep of request.package.dependencies) {
      if (!dep.captureId || !dep.revisionId || record.scope?.excludedSources.includes(dep.key)) continue;
      try {
        const resolved = await this.revision(vault, dep.captureId, dep.revisionId, true);
        for (const evidence of resolved.revision.evidence?.evidence || []) {
          const anchor = this.anchor(resolved, evidence);
          if (!this.inPackage(request, resolved, anchor)) continue;
          const referenceId = randomUUID();
          const label = `Cite evidence ${evidence.id} from ${resolved.capture.title}`;
          this.references.set(referenceId, { conversationId: record.id, requestId: request.id, anchor, label });
          references.push({ referenceId, label, excerpt: evidence.text });
        }
      } catch (error) { warnings.push(`Reference unavailable: ${dep.captureId}; ${error.message}`); }
    }
    return { ...input, references, warnings, explanation: request.reply, limitations: 'This is an interpretation, not a verified outcome. Supporting sentence citations have not been established.' };
  }
  async revision(vault, captureId, revisionId, offering = false) {
    if (!uuid(captureId) || !uuid(revisionId)) throw Error('Invalid cited revision identity.');
    const ledgerFile = path.join(vault.root, '.intake', 'ledger.json'), revisionFile = path.join(vault.root, 'Revisions', `${revisionId}.json`);
    const parents = this.parents(vault, [ledgerFile, revisionFile]);
    const ledger = JSON.parse((await this.readFile(vault, ledgerFile, parents)).text);
    if (ledger.schema !== 1 || !ledger.captures || !ledger.attempts || !Array.isArray(ledger.suppressed)) throw Error('Intake admission history is unavailable.');
    const entries = Object.entries(ledger.captures).filter(([, item]) => item.id === captureId);
    if (entries.length !== 1) throw Error('Cited capture admission is unavailable.');
    const [sourceHash, capture] = entries[0];
    const admitted = revisionAdmission(ledger, revisionId), attempts = admitted ? [admitted] : [];
    if (!capture.revisions.includes(revisionId) || !attempts.length || attempts.some(item => item.captureId !== captureId || item.sourceHash !== sourceHash || !/^[a-f0-9]{64}$/.test(item.snapshotHash) || item.snapshotHash !== attempts[0].snapshotHash)) throw Error('Exact cited revision was not admitted for this capture.');
    const { text } = await this.readFile(vault, revisionFile, parents), snapshotHash = hash(text);
    if (snapshotHash !== attempts[0].snapshotHash) throw Error('Exact cited revision is damaged. No newer revision was substituted.');
    const revision = JSON.parse(text);
    if (revision.schema !== 1 || revision.id !== revisionId || revision.captureId !== captureId || revision.sourceHash !== sourceHash || typeof revision.text !== 'string') throw Error('Exact cited revision identity is damaged.');
    const warnings = [];
    if (capture.removed || capture.rejected || capture.supportEligible === false || capture.conflict || capture.identityIssue || capture.reviewChoices?.length || ledger.identityIssues?.[captureId] || ledger.suppressed.includes(sourceHash) || ledger.blocks?.[sourceHash] || ledger.pending?.[sourceHash]) warnings.push('Current capture is removed, rejected or unresolved; this historical citation is not current supporting context.');
    if (revision.supportEligible === false || !['unreviewed', 'accept', 'edit'].includes(revision.humanReview)) warnings.push('The cited revision is ineligible as supporting evidence.');
    if (offering) {
      if (warnings.length) throw Error(warnings.join(' '));
      // Apply the capture identity authority without reading any other revision.
      const matches = (await vault.scan()).filter(note => note.id === captureId), choice = ledger.identityChoices?.[captureId];
      const files = matches.map(note => ({ file: path.relative(vault.vault, note.file), hash: hash(note.content) })).sort((a, b) => a.file.localeCompare(b.file));
      let note;
      if (matches.length === 1 && !choice?.copies.some(copy => copy.file === files[0].file)) note = matches[0];
      else if (choice && files.some(file => file.file === choice.file) && JSON.stringify(files.filter(file => file.file !== choice.file)) === JSON.stringify(choice.copies)) note = matches.find(note => path.relative(vault.vault, note.file) === choice.file);
      if (!note) throw Error('Resolve the canonical capture identity before citing evidence.');
      const current = await this.readFile(vault, note.file, this.parents(vault, [note.file]));
      if (hash(current.text) !== capture.currentHash) throw Error('Current capture was changed outside Companion.');
    }
    return { capture, revision, snapshotHash, warnings };
  }
  anchor(resolved, evidence) {
    if (typeof evidence.id !== 'string' || typeof evidence.text !== 'string' || !evidence.text.trim()) throw Error('Evidence text is unavailable.');
    return { kind: 'imported_evidence', capture_id: resolved.capture.id, revision_id: resolved.revision.id, snapshot_sha256: resolved.snapshotHash, evidence_id: evidence.id, evidence_kind: evidence.kind, start_seconds: evidence.start_seconds ?? null, end_seconds: evidence.end_seconds ?? null, excerpt: evidence.text, excerpt_sha256: hash(evidence.text) };
  }
  inPackage(request, resolved, anchor) {
    const text = request.package.text;
    return hash(text) === request.package.digest && text.includes(`Imported capture ${anchor.capture_id}; exact imported revision ${anchor.revision_id}; snapshot sha256 ${anchor.snapshot_sha256}`) && text.includes(resolved.revision.text.replace(/\r\n?/g, '\n')) && text.includes(anchor.excerpt.replace(/\r\n?/g, '\n'));
  }
  async selectedReferences(input, origin) {
    const ids = input.referenceIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw Error('Inspect and select valid evidence references.');
    const citations = [];
    for (const id of ids) {
      const selected = this.references.get(id);
      if (!selected || selected.conversationId !== origin.record.id || selected.requestId !== origin.request.id || origin.request.status !== 'completed') throw Error('The selected reference no longer belongs to this completed reply.');
      const anchor = selected.anchor;
      if (origin.record.scope?.excludedSources.includes(`capture:${anchor.capture_id}`)) throw Error('Selected supporting source was excluded.');
      const dep = origin.request.package.dependencies.find(dep => dep.captureId === anchor.capture_id && dep.revisionId === anchor.revision_id);
      if (!dep) throw Error('Selected evidence is absent from the original request.');
      const resolved = await this.revision(origin.vault, anchor.capture_id, anchor.revision_id, true);
      const evidence = resolved.revision.evidence?.evidence?.find(item => item.id === anchor.evidence_id);
      if (!evidence || JSON.stringify(this.anchor(resolved, evidence)) !== JSON.stringify(anchor) || !this.inPackage(origin.request, resolved, anchor)) throw Error('Selected exact evidence changed or is unavailable.');
      citations.push(structuredClone(anchor));
    }
    return citations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  async supportSnapshot({ vault, record, request }) {
    const context = await this.conversations.getContext(), corpus = await context.corpus();
    const ledgerFile = path.join(vault.root, '.intake', 'ledger.json');
    const ledger = JSON.parse((await this.readFile(vault, ledgerFile, this.parents(vault, [ledgerFile]))).text);
    const state = [], warnings = []; let unavailable = false;
    for (const dep of request.package.dependencies) {
      const source = corpus.all.find(item => item.key === dep.key), excluded = record.scope?.excludedSources.includes(dep.key) || false;
      const captureId = dep.captureId || (dep.key.startsWith('capture:') ? dep.key.slice(8) : null);
      const entries = captureId ? Object.entries(ledger.captures).filter(([, item]) => item.id === captureId) : [];
      const entry = entries.length === 1 ? entries[0] : null, capture = entry?.[1];
      const authorityKey = captureId || dep.key;
      const authority = { identityChoice: ledger.identityChoices?.[authorityKey] || null, identityIssue: ledger.identityIssues?.[authorityKey] || null, ...(capture ? { sourceHash: entry[0], file: capture.relative || capture.file, currentRevision: capture.currentRevision, currentHash: capture.currentHash, removed: !!capture.removed, rejected: !!capture.rejected, supportEligible: capture.supportEligible !== false, conflict: !!capture.conflict, pending: !!ledger.pending?.[entry[0]], blocked: !!ledger.blocks?.[entry[0]], suppressed: ledger.suppressed.includes(entry[0]) } : {}) };
      state.push({ key: dep.key, originalDigest: dep.digest, currentDigest: source?.digest || null, originalSourceGenerations: generations(dep.sourceGenerations), currentSourceGenerations: source ? generations(source.sourceGenerations) : null, excluded, authority, warnings: source?.warnings || [] });
      if (!source || excluded) {
        unavailable = true; warnings.push(`Supporting context ${dep.key} is currently unavailable or excluded. Retained writing is independent; no current support is claimed.`);
      } else if (!sameEvidence(source, dep)) {
        // An imported citation can retain exact admitted historical evidence even
        // after the current capture changes. Ordinary captures lack that snapshot.
        let historical = false;
        if (captureId && dep.revisionId && sameGenerations(source, dep)) {
          try {
            const retained = await this.revision(vault, captureId, dep.revisionId);
            historical = retained.warnings.length === 0;
          } catch {}
        }
        if (!historical) unavailable = true;
        warnings.push(`Supporting context ${dep.key} changed since the conversation. ${historical ? 'The exact eligible imported revision remains retained; it was not replaced by the current revision.' : 'The historical interpretation is retained with unavailable or unverified support.'}`);
      }
      for (const warning of source?.warnings || []) warnings.push(warning);
    }
    return { state, warnings, unavailable };
  }
  async preview(input, identity) {
    const { vault, record, request } = await this.origin(input);
    if (identity) this.removal.allow(vault, identity.id);
    const citations = await this.selectedReferences(input, { vault, record, request });
    for (const field of ['title', 'explanation', 'limitations']) if (typeof input[field] !== 'string' || !input[field].trim()) throw Error(`Enter the idea ${field} before previewing.`);
    if (/[\r\n]/.test(input.title)) throw Error('Use a title on one line.');
    const kind = input.kind ?? 'observation';
    if (!['observation', 'failed_analogy', 'experiment_proposal'].includes(kind)) throw Error('Choose a supported saved idea kind.');
    const experimentLabels = { hypothesis: 'Hypothesis', borrowed_mechanism: 'Borrowed mechanism', project_application: 'Project application', smallest_test: 'Smallest test', observable_result: 'Observable result' };
    const experiment = Object.fromEntries(Object.keys(experimentLabels).map(key => [key, input.experiment?.[key] ?? '']));
    if (kind === 'experiment_proposal') for (const [key, label] of Object.entries(experimentLabels)) {
      if (typeof experiment[key] !== 'string' || !experiment[key].trim()) throw Error(`Enter the experiment ${label} before previewing.`);
    }
    const brief = await new Briefs(vault).pinned(record.brief.version);
    if (brief.id !== record.brief.id || brief.digest !== record.brief.digest) throw Error('The exact conversation brief is unavailable.');
    const support = await this.supportSnapshot({ vault, record, request });
    // An unchanged proposal keeps the same immutable identity and creation instant
    // when the user cancels and reviews it again. Confirmation never regenerates it.
    const proposalKey = hash(JSON.stringify({ vault: vault.root, conversation: record.id, request: request.id, package: request.package, reply: request.reply, status: request.status, scope: record.scope, brief: record.brief, title: input.title, explanation: input.explanation, limitations: input.limitations, kind, experiment, citations, supportState: support.state }));
    const retained = !identity && [...this.previews.values()].find(preview => preview.proposalKey === proposalKey && !this.removal.fenced(vault, preview.id));
    if (retained) {
      this.removal.allow(vault, retained.id);
      return { operation: retained.operation, text: retained.text, destination: retained.destination, warnings: [...retained.warnings] };
    }
    const dependencies = request.package.dependencies.filter(dep => dep.key.startsWith('capture:')).map(dep => {
      const captureId = dep.captureId || dep.key.slice(8), generation = generations(dep.sourceGenerations).find(item => item.captureId === captureId)?.generation;
      return { capture_id: captureId, ...(dep.revisionId ? { revision_id: dep.revisionId } : { content_sha256: dep.digest }), ...(generation ? { source_generation: generation } : {}) };
    });
    const unsupported = support.unavailable || request.status !== 'completed' || request.package.dependencies.some(dep => !dep.key.startsWith('capture:') && !dep.key.startsWith('brief:'));
    const id = identity?.id || randomUUID(), operation = identity?.operation || randomUUID();
    this.removal.allow(vault, id);
    const fields = { artifact_type: 'saved_idea', schema_version: 1, companion_id: id, title: input.title.trim(), created_at: identity?.createdAt || this.clock().now, idea_kind: kind, ...(kind === 'experiment_proposal' ? { experiment } : {}), source_dependencies: dependencies, project_brief_version: record.brief.version, project_brief: record.brief, support_attribution_unavailable: unsupported, citations, origin: { conversation_id: record.id, request_id: request.id, package_sha256: request.package.digest, reply_sha256: hash(request.reply), status: request.status } };
    const disclosure = citations.length ? 'Supporting references were explicitly selected and checked against exact admitted revisions and the original full source in the retained package. The original package had no structured passage offsets. These references do not establish sentence-level support for the explanation. Claims are not independently verified.' : 'Supporting references: no sentence-level citations were selected or validated. Context dependencies record provenance and revocation only; they do not prove that the explanation is supported.';
    const experimentText = kind === 'experiment_proposal' ? `\n# Experiment Proposal\n\n${Object.entries(experimentLabels).map(([key, label]) => `## ${label}\n\n${experiment[key]}`).join('\n\n')}\n` : '';
    const citationText = citations.map(anchor => `Capture ${anchor.capture_id}; exact revision ${anchor.revision_id}; snapshot sha256 ${anchor.snapshot_sha256}; evidence ${anchor.evidence_id}; ${anchor.evidence_kind}; time ${anchor.start_seconds ?? 'unknown'}–${anchor.end_seconds ?? 'unknown'} seconds.\n\n${anchor.excerpt}\n\nExcerpt sha256 ${anchor.excerpt_sha256}.`).join('\n\n');
    const text = `---\n${YAML.stringify(fields)}---\n\n# ${fields.title}\n\n## Explanation\n\n${input.explanation}\n\n## Limitations\n\n${input.limitations}\n${experimentText}\n## Supporting references\n\n${disclosure}\n\n${support.warnings.join('\n')}\n\n${citationText}\n\nExact project brief: ${record.brief.id}, version ${record.brief.version}, sha256 ${record.brief.digest}.\n\n${dependencies.map(dep => `Capture ${dep.capture_id}; ${dep.revision_id ? `exact revision ${dep.revision_id}` : `content sha256 ${dep.content_sha256}`}; context dependency only.`).join('\n')}\n\nConversation output status: ${request.status}. Interpretation is not an executed experiment or a verified result.\n`;
    const slug = fields.title.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 55) || 'Idea';
    const destination = path.join(vault.root, 'Ideas', `${slug}--${id}.md`);
    this.guard(vault);
    const referenceBindings = (input.referenceIds || []).map(referenceId => ({ referenceId, ...structuredClone(this.references.get(referenceId)) }));
    const preview = { schema: 1, operation, id, vault: vault.root, destination, text, digest: hash(text), proposalKey, warnings: [disclosure, ...support.warnings], input: structuredClone(input), referenceBindings, supportState: support.state };
    if (identity && (identity.text !== text || identity.destination !== destination || identity.proposalKey !== proposalKey)) throw Error('The retained proposal or supporting context changed. Review a new preview before saving; retained writing was preserved.');
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(operation, preview);
    return { operation, text, destination, warnings: [...preview.warnings] };
  }
  async intent(operation, inspectRemoved = false) {
    if (!uuid(operation)) throw Error('Proposed idea identity is invalid.');
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    const parents = this.guard(vault), file = path.join(vault.root, '.ideas', `${operation}.intent.json`);
    const value = JSON.parse((await this.readFile(vault, file, parents)).text), fields = typeof value.text === 'string' && metadata(value.text);
    if (value.schema !== 1 || value.operation !== operation || !uuid(value.id) || value.vault !== vault.root || typeof value.destination !== 'string' || path.dirname(value.destination) !== path.join(vault.root, 'Ideas') || !path.basename(value.destination).endsWith(`--${value.id}.md`) || hash(value.text) !== value.digest || fields?.artifact_type !== 'saved_idea' || fields.schema_version !== 1 || fields.companion_id !== value.id || !value.input || value.input.conversationId !== fields.origin?.conversation_id || value.input.requestId !== fields.origin?.request_id || typeof fields.created_at !== 'string' || !Number.isFinite(Date.parse(fields.created_at))) throw Error('Retained idea journal is invalid. Preserve it for repair; nothing was published.');
    if (!inspectRemoved) this.removal.allow(vault, value.id);
    return { value, fields, vault, parents };
  }
  async pending() {
    const vault = this.getVault(); if (!vault) return [];
    const directory = path.join(vault.root, '.ideas'), parents = this.guard(vault);
    if (!parents.has(directory)) return [];
    const proposals = [];
    for (const name of await fs.readdir(directory)) {
      const match = name.match(/^([a-f0-9-]{36})\.intent\.json$/); if (!match) continue;
      const { value, fields } = await this.intent(match[1], true);
      if (this.removal.fenced(vault, value.id)) continue;
      let receipt;
      try { receipt = JSON.parse((await this.readFile(vault, path.join(directory, `${value.operation}.published.json`), parents)).text); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (receipt) this.checkReceipt(receipt, value);
      const hasPublication = await this.knownPublication(value, vault, parents, receipt);
      if (receipt && !hasPublication) continue;
      proposals.push({ id: value.id, operation: value.operation, title: fields.title, destination: value.destination, hasPublication, cleanup: !!receipt });
    }
    return proposals;
  }
  async resume({ operation }) {
    const { value, fields, vault, parents } = await this.intent(operation);
    let receipt;
    try { receipt = JSON.parse((await this.readFile(vault, path.join(vault.root, '.ideas', `${operation}.published.json`), parents)).text); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (receipt) this.checkReceipt(receipt, value);
    const alreadyPublished = await this.knownPublication(value, vault, parents, receipt);
    if (receipt && !alreadyPublished) throw Error('This operation already published a saved idea. It will not create another note.');
    if (alreadyPublished) {
      this.previews.set(operation, value);
      return { operation, text: value.text, destination: value.destination, input: value.input, references: [], warnings: ['The exact note is already published. Confirmation only acknowledges that publication and completes local staging cleanup; current supporting-context eligibility remains separate.'], blocked: false, cleanup: !!receipt, acknowledgement: !receipt };
    }
    const ids = value.input.referenceIds || [], bindings = value.referenceBindings || [];
    if (!Array.isArray(ids) || !Array.isArray(bindings) || ids.length !== bindings.length || ids.some(id => !uuid(id)) || bindings.some(binding => !ids.includes(binding.referenceId) || binding.conversationId !== value.input.conversationId || binding.requestId !== value.input.requestId)) throw Error('Retained citation identity is unavailable. Preserve the proposed writing and review new references.');
    for (const { referenceId, ...binding } of bindings) this.references.set(referenceId, binding);
    try {
      const preview = await this.preview(value.input, { ...value, createdAt: fields.created_at });
      return { ...preview, input: value.input, references: bindings.map(binding => ({ referenceId: binding.referenceId, label: binding.label, excerpt: binding.anchor.excerpt })), blocked: false };
    } catch (error) {
      return { operation, text: value.text, destination: value.destination, input: value.input, references: bindings.map(binding => ({ referenceId: binding.referenceId, label: binding.label, excerpt: binding.anchor.excerpt })), warnings: [error.message], blocked: true };
    }
  }
  checkReceipt(receipt, value) {
    if (receipt.schema !== 1 || receipt.operation !== value.operation || receipt.id !== value.id || receipt.digest !== value.digest || typeof receipt.dev !== 'string' || typeof receipt.ino !== 'string') throw Error('Saved idea receipt identity is damaged. Nothing was republished.');
  }
  async knownPublication(value, vault, parents, receipt) {
    const stage = path.join(vault.root, '.ideas', `${value.operation}.md.pending`);
    this.guard(vault, parents);
    let stat;
    try { stat = await fs.lstat(stage, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    this.guard(vault, parents);
    if (!stat.isFile() || stat.isSymbolicLink() || ![1n, 2n].includes(stat.nlink)) throw Error('Retained idea stage has unknown linked copies. Preserve it for repair.');
    if (stat.nlink === 1n) return false;
    const staged = await this.readFile(vault, stage, parents, 2), destination = await this.readFile(vault, value.destination, parents, 2);
    if (!same(stat, staged.stat) || !same(staged.stat, destination.stat) || staged.text !== value.text || destination.text !== value.text) throw Error('Retained publication is not the exact known stage and destination pair. Preserve all files for repair.');
    if (receipt && (destination.stat.dev.toString() !== receipt.dev || destination.stat.ino.toString() !== receipt.ino)) throw Error('Completed publication ownership changed. Nothing was republished or cleaned.');
    return true;
  }
  async acknowledgePublication(value, vault, parents, exclusive) {
    this.removal.allow(vault, value.id);
    const directory = path.join(vault.root, '.ideas'), stage = path.join(directory, `${value.operation}.md.pending`);
    const intent = path.join(directory, `${value.operation}.intent.json`), receipt = path.join(directory, `${value.operation}.published.json`);
    // This operation acknowledges bytes already published. It neither links a new
    // destination nor authorizes their use as current supporting context.
    if ((await this.readFile(vault, intent, parents)).text !== JSON.stringify(value, null, 2) || !await this.knownPublication(value, vault, parents)) throw Error('Published idea ownership changed. Existing writing was preserved.');
    const published = await this.readFile(vault, value.destination, parents, 2);
    const record = { schema: 1, operation: value.operation, id: value.id, digest: value.digest, dev: published.stat.dev.toString(), ino: published.stat.ino.toString() };
    await exclusive(receipt, JSON.stringify(record));
    await this.checkpoint('idea-after-receipt');
    this.removal.allow(vault, value.id);
    if ((await this.readFile(vault, intent, parents)).text !== JSON.stringify(value, null, 2) || !await this.knownPublication(value, vault, parents, record)) throw Error('Published idea ownership changed before cleanup. Existing writing was preserved.');
    this.guard(vault, parents);
    const staged = local.lstatSync(stage, { bigint: true }), destination = local.lstatSync(value.destination, { bigint: true });
    if (!staged.isFile() || staged.isSymbolicLink() || !destination.isFile() || destination.isSymbolicLink() || staged.nlink !== 2n || destination.nlink !== 2n || !same(staged, destination) || !same(destination, published.stat)) throw Error('Published idea peer identity changed. No stage was removed.');
    this.removal.allow(vault, value.id); local.unlinkSync(stage);
  }
  async confirm({ operation }) {
    const preview = this.previews.get(operation), vault = this.getVault();
    if (!preview || !vault || preview.vault !== vault.root) throw Error('Preview the saved idea again before confirmation.');
    const parents = this.guard(vault, undefined, true), directory = path.join(vault.root, '.ideas');
    return withBriefMutation(directory, async () => {
      this.guard(vault, parents);
      this.removal.allow(vault, preview.id);
      const intent = path.join(directory, `${operation}.intent.json`), stage = path.join(directory, `${operation}.md.pending`), receipt = path.join(directory, `${operation}.published.json`);
      const exclusive = async (file, text) => { this.guard(vault, parents); this.removal.allow(vault, preview.id); await fs.writeFile(file, text, { flag: 'wx', flush: true, encoding: 'utf8' }); this.guard(vault, parents); this.removal.allow(vault, preview.id); };
      try { await exclusive(intent, JSON.stringify(preview, null, 2)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; if ((await this.readFile(vault, intent, parents)).text !== JSON.stringify(preview, null, 2)) throw Error('Saved idea intent conflict. The proposal was preserved.'); }
      let prior;
      try { prior = JSON.parse((await this.readFile(vault, receipt, parents)).text); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (prior) {
        this.checkReceipt(prior, preview);
        let current;
        try {
          let retainedStage;
          try { retainedStage = await this.readFile(vault, stage, parents, 2); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          current = await this.readFile(vault, preview.destination, parents, retainedStage ? 2 : 1);
          if (retainedStage) {
            if (!same(retainedStage.stat, current.stat) || current.text !== preview.text || current.stat.ino.toString() !== prior.ino || current.stat.dev.toString() !== prior.dev) throw Error('Completed publication peer changed.');
            this.guard(vault, parents); this.removal.allow(vault, preview.id); await fs.unlink(stage);
          }
        }
        catch { throw Error('The saved idea is unavailable or changed. The completed operation will not create another note.'); }
        if (current.text !== preview.text || current.stat.ino.toString() !== prior.ino || current.stat.dev.toString() !== prior.dev) throw Error('The saved idea was edited or replaced. Existing content was preserved.');
        return { id: preview.id, destination: preview.destination };
      }
      if (await this.knownPublication(preview, vault, parents)) {
        await this.acknowledgePublication(preview, vault, parents, exclusive);
        return { id: preview.id, destination: preview.destination };
      }
      try { await exclusive(stage, preview.text); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const links = local.lstatSync(stage).nlink;
      if (![1, 2].includes(links)) throw Error('Saved idea stage has unexpected linked copies. Preserve it for inspection.');
      const staged = await this.readFile(vault, stage, parents, links);
      if (staged.text !== preview.text) throw Error('Saved idea stage conflict. The proposal was preserved.');
      await this.checkpoint('idea-before-publication');
      this.removal.allow(vault, preview.id);
      const currentPreview = await this.preview(preview.input, { ...preview, createdAt: metadata(preview.text).created_at });
      if (currentPreview.operation !== operation || currentPreview.text !== preview.text || currentPreview.destination !== preview.destination) throw Error('Idea context changed. Retained proposed content was preserved; review a fresh preview before saving.');
      const inventory = await scanIdeas(vault), claims = inventory.claims.get(preview.id) || [];
      const freshLinks = local.lstatSync(stage).nlink;
      if (![1, 2].includes(freshLinks)) throw Error('Saved idea stage has unknown linked copies. No destination was created.');
      const freshStage = await this.readFile(vault, stage, parents, freshLinks);
      if (!same(staged.stat, freshStage.stat) || freshStage.text !== preview.text) throw Error('Saved idea stage changed. The proposal and existing files were preserved.');
      this.guard(vault, parents); inventory.check();
      // Check exact peers after every asynchronous checkpoint, immediately before
      // exclusive publication. Two links are valid only for our known destination.
      const finalStage = local.lstatSync(stage, { bigint: true });
      let finalDestination;
      try { finalDestination = local.lstatSync(preview.destination, { bigint: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!finalStage.isFile() || finalStage.isSymbolicLink() || !same(freshStage.stat, finalStage) || finalStage.size !== freshStage.stat.size || finalStage.mtimeNs !== freshStage.stat.mtimeNs || finalStage.ctimeNs !== freshStage.stat.ctimeNs || finalStage.nlink !== freshStage.stat.nlink) throw Error('Saved idea stage identity changed. No destination was created.');
      this.removal.allow(vault, preview.id);
      if (claims.length && (claims.length !== 1 || claims[0].file !== preview.destination || !same(claims[0].stat, finalStage))) throw Error('The saved idea identity already has a vault copy. Existing files were preserved.');
      if (finalStage.nlink === 1n && !finalDestination) local.linkSync(stage, preview.destination);
      else if (finalStage.nlink !== 2n || !finalDestination?.isFile() || finalDestination.isSymbolicLink() || finalDestination.nlink !== 2n || !same(finalStage, finalDestination)) throw Error('Saved idea stage has an unknown peer or the destination exists. Existing files were preserved; no destination peer was created.');
      this.guard(vault, parents);
      await this.checkpoint('idea-after-publication');
      this.removal.allow(vault, preview.id);
      const published = await this.readFile(vault, preview.destination, parents, 2);
      if (!same(staged.stat, published.stat) || published.text !== preview.text) throw Error('Saved idea changed during publication. Preserve the proposal and inspect the note.');
      await this.acknowledgePublication(preview, vault, parents, exclusive);
      return { id: preview.id, destination: preview.destination };
    });
  }
  async locate(id) {
    const vault = this.getVault(); if (!vault) return null;
    const parents = this.guard(vault), inventory = await scanIdeas(vault);
    this.guard(vault, parents);
    if (this.getVault() !== vault) throw Error('Selected vault changed. Inspect saved ideas again.');
    const claims = inventory.claims.get(id);
    if (this.removal.fenced(vault, id) || claims?.length !== 1 || !claims[0].savedIdea || claims[0].stat.nlink !== 1n) return null;
    return { vault, parents, inventory, note: claims[0] };
  }
  async openNote(id) {
    if (!uuid(id)) throw Error('Saved idea identity is invalid.');
    const found = await this.locate(id);
    if (!found) throw Error('Saved idea is missing or has duplicate identities. Preserve the notes and resolve them before opening.');
    if (this.getVault() !== found.vault) throw Error('Selected vault changed. Inspect saved ideas again.');
    found.inventory.check(); this.removal.allow(found.vault, id);
    await this.open(`obsidian://open?path=${encodeURIComponent(found.note.file)}`);
  }
  async inspectEvidence({ id, index }) {
    if (!uuid(id) || !Number.isSafeInteger(index) || index < 0) throw Error('Choose a saved citation.');
    const found = await this.locate(id);
    if (!found) throw Error('Saved idea identity is missing or ambiguous.');
    const { vault, parents, inventory, note } = found, anchor = note.metadata.citations?.[index];
    if (anchor?.kind !== 'imported_evidence') throw Error('Saved citation attribution is unavailable.');
    let result;
    try {
      const resolved = await this.revision(vault, anchor.capture_id, anchor.revision_id);
      const evidence = resolved.revision.evidence?.evidence?.find(item => item.id === anchor.evidence_id);
      if (!evidence || JSON.stringify(this.anchor(resolved, evidence)) !== JSON.stringify(anchor)) throw Error('Exact cited evidence is damaged or changed.');
      result = { available: true, anchor, text: resolved.revision.text, warnings: resolved.warnings, humanReview: resolved.revision.humanReview, extraction: resolved.revision.extraction, processing: resolved.revision.processing || resolved.revision.run?.state || 'unknown', uncertainty: resolved.revision.uncertainty };
    } catch (error) { result = { available: false, anchor, warnings: [`Cited evidence unavailable: ${error.message} No newer revision was substituted.`] }; }
    this.guard(vault, parents); inventory.check(); this.removal.allow(vault, id);
    if (this.getVault() !== vault) throw Error('Selected vault changed. Inspect saved ideas again.');
    return result;
  }
}
function installIdeas({ ipcMain, ...options }) {
  const store = new Ideas(options);
  ipcMain.handle('idea-draft', (_, input) => store.draft(input));
  ipcMain.handle('idea-preview', (_, input) => store.preview(input));
  ipcMain.handle('idea-confirm', (_, input) => store.confirm(input));
  ipcMain.handle('idea-list', () => store.list());
  ipcMain.handle('idea-open', (_, id) => store.openNote(id));
  ipcMain.handle('idea-evidence', (_, input) => store.inspectEvidence(input));
  ipcMain.handle('idea-pending', () => store.pending());
  ipcMain.handle('idea-resume', (_, input) => store.resume(input));
  ipcMain.handle('idea-removal-preview', (_, input) => store.removal.preview(input));
  ipcMain.handle('idea-removal-cancel', (_, input) => store.removal.cancel(input));
  ipcMain.handle('idea-removal-confirm', (_, input) => store.removal.confirm(input));
  ipcMain.handle('idea-removal-pending', () => store.removal.pending());
  ipcMain.handle('idea-removal-resume', (_, input) => store.removal.resume(input));
  return store;
}
module.exports = { installIdeas };
