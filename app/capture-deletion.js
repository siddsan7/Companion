const fs = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const { randomUUID } = require('node:crypto');
const { Intake, noteText } = require('./intake');
const { hash, readDraft } = require('./intake-producer');
const { readReview } = require('./intake-review');
const { sourceMutation } = require('./source-mutation');
const { validateAuthority, revisionAdmission, uuid } = require('./source-authority');
const { parse } = require('./vault');
const { requiredDirectories, sourceParents, pendingParents, globalRecovery, held, isManualHold, manualLeaf } = require('./source-recovery');
const sourceInventory = require('./source-inventory');
const sourceTitle = require('./source-title');
const manualTitle = require('./manual-title');
const pendingTitle = require('./pending-title');
const deletionDependents = require('./deletion-dependents');
const mixedDeletion = require('./mixed-deletion');
const relative = (vault, file) => path.relative(vault.vault, file).split(path.sep).join('/');
const changed = () => Object.assign(Error('Capture deletion files changed or contain unreviewed writing. Preserve them and preview the scope again.'), { code: 'SOURCE_FILE_CHANGED' });

class CaptureDeletion {
  constructor({ getVault, conversations, clearApprovals, clock }) { Object.assign(this, { getVault, conversations, clearApprovals, clock }); this.previews = new Map(); this.restorations = new Map(); this.retries = new Map(); this.scopeReviews = new Map(); }
  async directory(vault, file) {
    const stat = await fs.lstat(file, { bigint: true }); await vault.contained(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
    return { file: relative(vault, file), dev: String(stat.dev), ino: String(stat.ino) };
  }
  async target(vault, file, kind, allowPeers = false) {
    await vault.contained(file);
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !allowPeers && stat.nlink !== 1n) throw changed();
    const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) throw changed();
    return { file: relative(vault, file), sha256: hash(bytes), dev: String(stat.dev), ino: String(stat.ino), bytes: String(bytes.length), kind };
  }
  async inventory(id, retained) {
    if (!uuid(id)) throw Error('Choose a capture to delete.');
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    const intake = new Intake(vault), ledger = await intake.load(); validateAuthority(ledger);
    if (ledger.sourceAuthority?.[id] && ledger.sourceAuthority[id].phase !== 'active') throw Error('This capture already has a deletion operation.');
    await globalRecovery(intake, ledger);
    if (ledger.sourceAuthority?.[id]) await sourceParents(intake, ledger.sourceAuthority[id]);
    const entry = Object.entries(ledger.captures).find(([, capture]) => capture.id === id);
    const notes = (await vault.scan()).filter(note => note.id === id);
    if (!entry && (notes.length !== 1 || !['thought', 'link'].includes(notes[0].type))) throw changed();
    const manual = !entry ? { captureId: id, type: notes[0].type, capturedAt: notes[0].capturedAt, currentHash: hash(notes[0].content), file: path.basename(notes[0].file), relative: relative(vault, notes[0].file) } : undefined;
    const [sourceHash, capture] = entry || [null, { id, title: notes[0].title, currentHash: manual.currentHash, revisions: [] }];
    if (notes.length !== 1 || manual && hash(notes[0].content) !== capture.currentHash) throw changed();
    const mixed = !manual ? await mixedDeletion.inventory(intake, ledger, capture, sourceHash, notes[0], retained, this.clock?.().now || new Date().toISOString()) : null;
    let targets = mixed ? mixed.targets : [await this.target(vault, notes[0].file, 'capture', !manual)]; const revisions = new Map();
    for (const revisionId of mixed ? [] : capture.revisions) {
      if (!uuid(revisionId)) throw changed();
      const file = path.join(vault.root, 'Revisions', revisionId + '.json'), target = await this.target(vault, file, 'snapshot', true);
      const admission = revisionAdmission(ledger, revisionId);
      if (!admission || admission.snapshotHash !== target.sha256) throw changed();
      const revision = JSON.parse(await fs.readFile(file, 'utf8'));
      if (revision.id !== revisionId || revision.captureId !== id || revision.sourceHash !== sourceHash) throw changed();
      targets.push(target); revisions.set(revisionId, revision);
    }
    let imported, manualTitles;
    if (!manual) {
      imported = mixed || await sourceInventory.inventory(intake, ledger, capture, sourceHash, revisions, targets);
      if (!mixed && hash(notes[0].content) !== capture.currentHash && !imported.titleRecovery) throw changed();
      targets = imported.targets;
    } else {
      manualTitles = await manualTitle.inventory(intake, ledger, manual, targets); targets = manualTitles.targets;
    }
    for (const name of manual ? (await fs.readdir(intake.dir)).sort() : []) {
      if (name === 'ledger.json') continue;
      const file = path.join(intake.dir, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw changed();
      const text = await fs.readFile(file, 'utf8');
      if (!text.includes(id) && !(sourceHash && text.includes(sourceHash))) continue;
      const note = parse(text);
      if (!note || note.id !== id || !new RegExp(`^${id}-[a-f0-9-]{36}\\.before(?:-[a-f0-9-]{36})?\\.md$`).test(name)) throw changed();
      const metadata = YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]), revision = revisions.get(metadata.source_revision);
      if (!revision || noteText({ ...capture, title: note.title, capturedAt: note.capturedAt, currentRevision: revision.id }, revision) !== text) throw changed();
      targets.push(await this.target(vault, file, 'source-backup'));
    }
    const directories = new Map();
    for (const name of requiredDirectories(intake, targets, mixed?.preservedWriting)) { const value = await this.directory(vault, path.join(vault.vault, name)); directories.set(name, value); }
    await inspectAdjacentTitlePrefix(vault, targets);
    const annotations = (await vault.scan({ annotations: true })).filter(note => note.captureId === id).map(note => ({ id: note.id, file: relative(vault, note.file), text: note.content }));
    await inspectManualPeers(vault, { captureId: id }, new Set([...(imported?.titleProofs || manualTitles?.titleProofs || []).map(proof => proof.before), ...pendingTitle.sidecars(imported?.titleRecovery)]));
    const dependents = await deletionDependents.inventory(vault, this.conversations, id);
    if (!intake.storage.matches(await intake.storage.view())) throw changed();
    return { id, root: await fs.realpath(vault.vault), ledgerIdentity: intake.storage.expected.identity, sourceHash, capture, ...(manual ? { manual, ...(manualTitles.inventoryVersion === 1 ? { inventoryVersion: 1, originGenerations: manualTitles.originGenerations, titleProofs: manualTitles.titleProofs } : {}) } : { inventoryVersion: 2, originGenerations: ledger.sourceAuthority?.[id] ? [{ captureId: id, generation: ledger.sourceAuthority[id].generation }] : [], recovery: imported.recovery, recoveryPointers: imported.recoveryPointers, observations: imported.observations, purgedProducerAttempts: ledger.sourceAuthority?.[id]?.purgedProducerAttempts || [], ...(imported.titleProofs.length ? { titleProofs: imported.titleProofs } : {}), ...(imported.titleRecovery ? { titleRecovery: imported.titleRecovery } : {}), ...(mixed ? { mixedRecovery: mixed.mixedRecovery, preservedWriting: mixed.preservedWriting, retainedWriting: mixed.retainedWriting } : {}) }), targets: targets.sort((a, b) => a.file.localeCompare(b.file)), directories: [...directories.values()].sort((a, b) => a.file.localeCompare(b.file)), annotations, dependents };
  }
  async preview(id) {
    const inventory = await this.inventory(id), token = randomUUID(); this.previews.set(token, inventory);
    return { token, title: inventory.capture.title, revisions: inventory.capture.revisions.length, targets: inventory.targets.map(target => target.file), annotations: inventory.annotations, dependents: inventory.dependents.rows, ...(inventory.retainedWriting ? { retainedWriting: inventory.retainedWriting } : {}) };
  }
  cancel(token) { this.previews.delete(token); }
  async suppressed() {
    const vault = this.getVault(); if (!vault) return [];
    const ledger = await new Intake(vault).load();
    const result = [];
    for (const [id, authority] of Object.entries(ledger.sourceAuthority || {})) if (authority.phase === 'deleted') {
      const directories = await sourceParents(new Intake(vault), authority, true);
      result.push({ id, operationId: authority.operationId, manual: !!authority.manual, title: ledger.captures[authority.sourceHash]?.title || id, needsScopeReview: directories.length !== authority.directories.length });
    }
    return result;
  }
  async restorationInput(input) {
    const vault = this.getVault();
    if (!vault || !uuid(input?.id)) throw Error('Choose a deliberately deleted source.');
    const intake = new Intake(vault), ledger = await intake.load(), authority = ledger.sourceAuthority?.[input.id];
    if (authority?.phase !== 'deleted' || !authority.manual && !ledger.suppressed.includes(authority.sourceHash)) throw Error('Choose a deliberately deleted source.');
    await guardRestorationParents(intake, authority);
    if (authority.manual) {
      const selected = await readManualSelection(input.file, authority.manual);
      if ((await vault.scan()).some(note => note.id === input.id)) throw changed();
      return { input: { id: input.id, file: input.file }, vault: vault.root, authority, selected, capture: { id: input.id, title: parse(selected.content).title }, draft: { text: selected.content, identity: input.id, fingerprint: selected.sha256, humanReview: 'user capture' } };
    }
    if (typeof input.folder !== 'string' || !path.isAbsolute(input.folder) || !['draft', 'review'].includes(input.kind)) throw Error('Choose one complete producer artifact folder and its kind.');
    const folder = await fs.lstat(input.folder, { bigint: true });
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw Error('Choose an ordinary producer artifact folder.');
    const draft = await (input.kind === 'review' ? readReview(input.folder) : readDraft(input.folder));
    sourceInventory.purgedAttempt(ledger, draft);
    const accepted = ledger.attempts[draft.identity];
    if (draft.sourceHash !== authority.sourceHash || accepted && (accepted.fingerprint !== draft.fingerprint || accepted.captureId !== input.id || accepted.sourceHash !== authority.sourceHash)) throw Error('The selected artifact does not match this source or its immutable producer identity.');
    const capture = ledger.captures[authority.sourceHash];
    if (!capture || capture.id !== input.id || !capture.removed || await fs.access(intake.destination(capture)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw changed();
    return { input: { id: input.id, folder: input.folder, kind: input.kind }, vault: vault.root, directory: { realpath: await fs.realpath(input.folder), dev: String(folder.dev), ino: String(folder.ino) }, authority, capture, draft };
  }
  async previewRestoration(input) {
    const selected = await this.restorationInput(input), token = randomUUID(); this.restorations.set(token, selected);
    return { token, id: input.id, title: selected.capture.title, identity: selected.draft.identity, fingerprint: selected.draft.fingerprint, text: selected.draft.text, review: selected.draft.humanReview };
  }
  async confirmRestoration(token) {
    const selected = this.restorations.get(token); if (!selected) throw Error('Preview the selected source restoration again.');
    const vault = this.getVault();
    return this.conversations.lock(() => sourceMutation(vault.root, async () => {
      const fresh = await this.restorationInput(selected.input);
      if (JSON.stringify(fresh) !== JSON.stringify(selected)) throw Error('Selected restoration material changed. Preview it again.');
      const intake = new Intake(vault), ledger = await intake.load(), operationId = randomUUID(), generation = randomUUID(), revisionId = randomUUID(), now = this.clock().now;
      if (selected.authority.manual) {
        const value = { schema: 1, id: selected.input.id, operationId, generation, content: selected.selected.content };
        await guardRestorationParents(intake, selected.authority);
        const journal = await publishManualJournal(intake, selected.authority, value);
        await guardRestorationParents(intake, selected.authority);
        const { history, ...prior } = selected.authority;
        ledger.sourceAuthority[selected.input.id] = { ...selected.authority, phase: 'restoring', operationId, generation, history: [...(history || []), prior], restoration: { ...journal, revision: null } };
        try { await intake.save(ledger); }
        catch (error) { if (!await cleanupManualJournal(intake, selected.authority, journal)) error.message += ' The new journal was preserved because its cleanup ownership could not be verified.'; throw error; }
        this.restorations.delete(token); this.clearApprovals();
        await vault.checkpoint('capture-restoration-authorized');
        await finishRestoration(intake, ledger, selected.input.id); return true;
      }
      const revision = { schema: 1, id: revisionId, captureId: selected.input.id, importedAt: now, ...selected.draft };
      const capture = { id: selected.capture.id, file: selected.capture.file, ...(selected.capture.relative ? { relative: selected.capture.relative } : {}), capturedAt: selected.capture.capturedAt, title: selected.capture.title, currentRevision: revisionId, currentHash: '', reviewed: !!revision.review, rejected: revision.humanReview === 'reject', supportEligible: revision.supportEligible !== false, revisions: [revisionId], updatedAt: now };
      const content = noteText(capture, revision); capture.currentHash = hash(content);
      const tx = { schema: 1, restore: true, restoreOperation: operationId, sourceGeneration: generation, key: `${ledger.sources[0]?.id || randomUUID()}:restoration-${operationId}`, sourceHash: selected.authority.sourceHash, capture, revision, content, previousHash: null, previous: null, backup: `${capture.id}-${revisionId}.before.md` };
      intake.validateTransaction(tx);
      const journal = `restoration-${operationId}.json`, bytes = JSON.stringify(tx);
      await guardRestorationParents(intake, selected.authority);
      await intake.publishJournal(path.join(intake.dir, journal), tx);
      await guardRestorationParents(intake, selected.authority);
      const { history, ...prior } = selected.authority;
      ledger.sourceAuthority[capture.id] = { ...selected.authority, phase: 'restoring', operationId, generation, history: [...(history || []), prior], restoration: { journal, revision: revisionId, sha256: hash(bytes) } };
      await intake.save(ledger); this.restorations.delete(token); this.clearApprovals();
      await vault.checkpoint('capture-restoration-authorized');
      await finishRestoration(intake, ledger, capture.id); return true;
    }));
  }
  async pending() {
    const vault = this.getVault(); if (!vault) return [];
    const intake = new Intake(vault), ledger = await intake.load(), result = [];
    const missing = new Set();
    for (const [id, authority] of Object.entries(ledger.sourceAuthority || {})) if (['deleting', 'restoring'].includes(authority.phase)) {
      if ((await sourceParents(intake, authority, true)).length !== authority.directories.length) missing.add(id);
    }
    await globalRecovery(intake, ledger);
    for (const [id, authority] of Object.entries(ledger.sourceAuthority || {})) if (['deleting', 'restoring'].includes(authority.phase)) {
      let reason = 'Confirmed scope is ready to resume.';
      if (missing.size) reason = missing.has(id) ? 'Recovery folders need a fresh explicit review before this operation can continue.' : 'Another pending operation needs a fresh recovery-folder review first.';
      else if (authority.phase === 'deleting') { try { await inspectDeletion(intake, ledger, id); } catch (error) { reason = error.message; } }
      else if (authority.manual) {
        try {
          await verifyRetiredSlots(intake, ledger, id);
          if (authority.restoration.retirement) await inspectManualRetirement(intake, ledger, id);
          if (authority.restoration.published) await verifyManualPublication(intake, ledger, id, [manualFiles(intake, authority).stage]);
          await scanManualRecovery(intake, ledger, id); reason = 'Only this exact authorized manual restoration can be resumed.';
        } catch (error) { if (!isManualHold(error, id, authority)) throw error; reason = error.message; }
      } else reason = 'Only this exact selected producer restoration can be resumed.';
      const targets = authority.phase === 'restoring' && authority.manual ? Object.values(manualFiles(intake, authority)).map(file => relative(vault, file)) : authority.targets.map(target => target.file);
      if (authority.phase === 'deleting' && authority.mixedRecovery) targets.push(...authority.preservedWriting.flatMap(plan => [plan.file, plan.stage]));
      if (authority.restoration?.retirement) targets.push(...authority.restoration.retirement.slots.map(slot => slot.file));
      for (const receipt of authority.phase === 'restoring' ? authority.retiredRestorations || [] : []) for (const name of retirementFiles(intake, receipt)) {
        if (await fs.lstat(path.join(vault.vault, name)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) targets.push(name);
      }
      result.push({ id, operationId: authority.operationId, phase: authority.phase, manual: !!authority.manual, targets, reason, needsScopeReview: missing.has(id), blockedByScope: missing.size > 0 });
    }
    return result;
  }
  async scopeInput(input) {
    const vault = this.getVault(); if (!vault || !uuid(input?.id) || !uuid(input?.operationId)) throw Error('Review the recovery operation again.');
    const intake = new Intake(vault), ledger = await intake.load(), authority = ledger.sourceAuthority?.[input.id];
    if (!authority || authority.operationId !== input.operationId || !['deleting', 'restoring', 'deleted'].includes(authority.phase)) throw Error('Recovery operation changed. Review it again.');
    for (const value of Object.values(ledger.sourceAuthority || {})) if (['deleting', 'restoring'].includes(value.phase)) await sourceParents(intake, value, true);
    await globalRecovery(intake, ledger);
    const directories = await sourceParents(intake, authority, true);
    if (directories.length === authority.directories.length) throw Error('The recovery folders already have complete identity bindings.');
    return { input: { id: input.id, operationId: input.operationId }, root: vault.root, authority, directories };
  }
  async previewScope(input) {
    const selected = await this.scopeInput(input), token = randomUUID(); this.scopeReviews.set(token, selected);
    return { token, directories: selected.directories.map(item => item.file) };
  }
  async confirmScope(token) {
    const selected = this.scopeReviews.get(token); if (!selected) throw Error('Review the recovery folders again.');
    const vault = this.getVault(); if (!vault || vault.root !== selected.root) throw Error('Selected vault changed. Review the recovery folders again.');
    return this.conversations.lock(() => sourceMutation(vault.root, async () => {
      const fresh = await this.scopeInput(selected.input); if (JSON.stringify(fresh) !== JSON.stringify(selected)) throw Error('Recovery folders or authority changed. Review them again.');
      const intake = new Intake(vault), ledger = await intake.load();
      if (JSON.stringify(ledger.sourceAuthority?.[selected.input.id]) !== JSON.stringify(selected.authority)) throw Error('Recovery authority changed. Review the folders again.');
      ledger.sourceAuthority[selected.input.id].directories = selected.directories;
      await intake.save(ledger); this.scopeReviews.delete(token); this.clearApprovals(); return true;
    }));
  }
  async retryInput(input) {
    const vault = this.getVault(); if (!vault || !uuid(input?.id) || !uuid(input?.operationId)) throw Error('Review the held manual restoration again.');
    const intake = new Intake(vault), ledger = await intake.load(), authority = ledger.sourceAuthority?.[input.id];
    if (!authority?.manual || authority.phase !== 'restoring' || authority.operationId !== input.operationId || authority.restoration.published !== true || authority.restoration.retirement) throw Error('Choose a published held manual restoration. Its existing operation remains verify-only.');
    await pendingParents(intake, ledger); await verifyRetiredSlots(intake, ledger, input.id);
    const selected = await readManualSelection(input.file, authority.manual), access = manualAccess(intake, ledger, input.id), files = manualFiles(intake, authority), inspector = new CaptureDeletion({ getVault: () => vault });
    if (await fs.lstat(files.destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw access.fail('The restoration destination exists. Preserve its writing and use exact Resume; a new retry cannot overwrite it.');
    const slots = [];
    for (const [file, kind, ownership] of [[files.stage, 'manual-restoration-stage', 'receipt'], [files.journal, 'restoration-journal', 'reviewed-operation-journal']]) {
      const info = await access.owned(file, [], 'Reviewed old restoration copy');
      if (!info) { slots.push({ file: relative(vault, file), kind, expected: null }); continue; }
      const target = await access.run(file, () => inspector.target(vault, file, 'source-backup'));
      if (kind === 'manual-restoration-stage' && (target.sha256 !== authority.manual.currentHash || ['dev', 'ino', 'bytes'].some(key => target[key] !== authority.restoration.publication[key]))) throw access.fail('An unknown replacement stage was preserved. This retry does not authorize its removal.');
      if (kind === 'restoration-journal') {
        const bytes = await access.read(file); if (hash(bytes) !== authority.restoration.sha256) throw access.fail('The old restoration journal changed. It was preserved.');
        const value = await access.run(file, () => JSON.parse(bytes.toString('utf8')));
        if (Object.keys(value).sort().join(',') !== 'content,generation,id,operationId,schema' || value.schema !== 1 || value.id !== input.id || value.operationId !== authority.operationId || value.generation !== authority.generation || hash(value.content || '') !== authority.manual.currentHash) throw access.fail('The old restoration journal does not prove this source operation.');
      }
      slots.push({ file: target.file, kind, expected: { sha256: target.sha256, dev: target.dev, ino: target.ino, bytes: target.bytes, ownership } });
    }
    const retirement = { captureId: input.id, operationId: authority.operationId, generation: authority.generation, publication: authority.restoration.publication, sourceSha256: authority.manual.currentHash, journalSha256: authority.restoration.sha256, slots: slots.sort((a, b) => a.file.localeCompare(b.file)) };
    retirementFiles(intake, retirement);
    return { input: { id: input.id, operationId: input.operationId, file: input.file }, root: vault.root, authority, selected, retirement };
  }
  async previewRetry(input) {
    const selected = await this.retryInput(input), token = randomUUID(); this.retries.set(token, selected);
    return { token, text: selected.selected.content, targets: selected.retirement.slots.map(slot => ({ file: slot.file, absent: slot.expected === null })) };
  }
  async confirmRetry(token) {
    const selected = this.retries.get(token); if (!selected) throw Error('Preview the new restoration and its old-copy retirement again.');
    const vault = this.getVault(); if (!vault || vault.root !== selected.root) throw Error('Selected vault changed. Preview the new restoration again.');
    return this.conversations.lock(() => sourceMutation(vault.root, async () => {
      if (JSON.stringify(await this.retryInput(selected.input)) !== JSON.stringify(selected)) throw Error('Reviewed source or retirement scope changed. Preview it again.');
      const intake = new Intake(vault), ledger = await intake.load(), operationId = randomUUID(), generation = randomUUID(), id = selected.input.id;
      if (JSON.stringify(ledger.sourceAuthority?.[id]) !== JSON.stringify(selected.authority)) throw Error('Held source authority changed. Review the new operation again.');
      await pendingParents(intake, ledger);
      const journal = await publishManualJournal(intake, selected.authority, { schema: 1, id, operationId, generation, content: selected.selected.content });
      ledger.sourceAuthority[id] = { ...selected.authority, operationId, generation, restoration: { ...journal, revision: null, retirement: selected.retirement } };
      try { await intake.save(ledger); }
      catch (error) { if (!await cleanupManualJournal(intake, selected.authority, journal)) error.message += ' The new journal was preserved because its cleanup ownership could not be verified.'; throw error; }
      this.retries.delete(token); this.clearApprovals(); await vault.checkpoint('capture-restoration-retirement-authorized');
      await finishRestoration(intake, ledger, id); return true;
    }));
  }
  async resume(input) {
    if (!uuid(input?.id) || !uuid(input?.operationId)) throw Error('Review the confirmed deletion operation again.');
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    return this.conversations.lock(() => sourceMutation(vault.root, async () => {
      const intake = new Intake(vault), ledger = await intake.load(), authority = ledger.sourceAuthority?.[input.id];
      if (!authority || authority.operationId !== input.operationId || !['deleting', 'restoring'].includes(authority.phase)) throw Error('The confirmed source operation changed. Review recovery again.');
      await pendingParents(intake, ledger);
      if (authority.phase === 'deleting') await finishDeletion(intake, ledger, input.id); else await finishRestoration(intake, ledger, input.id);
      return true;
    }));
  }
  async confirm(token) {
    const selected = this.previews.get(token); if (!selected) throw Error('Preview capture deletion again.');
    const vault = this.getVault();
    return this.conversations.lock(() => sourceMutation(vault.root, async () => {
      const fresh = await this.inventory(selected.id, selected);
      if (JSON.stringify(fresh) !== JSON.stringify(selected)) throw changed();
      const acquired = [];
      try {
        for (const target of fresh.targets.filter(target => target.kind === 'capture')) { const file = path.join(vault.vault, target.file); await vault.acquire(file); acquired.push(file); }
        if (JSON.stringify(await this.inventory(selected.id, selected)) !== JSON.stringify(selected)) throw changed();
        const intake = new Intake(vault), ledger = await intake.load();
        if (JSON.stringify(intake.storage.expected.identity) !== JSON.stringify(fresh.ledgerIdentity)) throw changed();
        ledger.sourceAuthority ||= {};
        const operationId = fresh.preservedWriting?.[0]?.publicationOperationId || randomUUID(), purged = new Map((fresh.purgedProducerAttempts || []).map(item => [item.identity, item]));
        for (const item of fresh.observations || []) {
          const prior = purged.get(item.identity);
          if (prior && (prior.fingerprint !== item.fingerprint || prior.sourceHash !== item.sourceHash || prior.captureId !== item.captureId)) throw changed();
          if (!prior) purged.set(item.identity, { ...item, operationId });
        }
        ledger.sourceAuthority[selected.id] = { generation: randomUUID(), phase: 'deleting', operationId, sourceHash: fresh.sourceHash, root: fresh.root, targets: fresh.targets, directories: fresh.directories, ...(fresh.manual ? { manual: fresh.manual, ...(fresh.inventoryVersion === 1 ? { inventoryVersion: 1, originGenerations: fresh.originGenerations, titleProofs: fresh.titleProofs } : {}) } : { inventoryVersion: 2, originGenerations: fresh.originGenerations, recovery: fresh.recovery, recoveryPointers: fresh.recoveryPointers, purgedProducerAttempts: [...purged.values()].sort((a, b) => a.identity.localeCompare(b.identity)), ...(fresh.titleProofs ? { titleProofs: fresh.titleProofs } : {}), ...(fresh.titleRecovery ? { titleRecovery: fresh.titleRecovery } : {}), ...(fresh.mixedRecovery ? { mixedRecovery: fresh.mixedRecovery, preservedWriting: fresh.preservedWriting } : {}) }), ...(ledger.sourceAuthority[selected.id]?.history ? { history: ledger.sourceAuthority[selected.id].history } : {}), ...(ledger.sourceAuthority[selected.id]?.retiredRestorations ? { retiredRestorations: ledger.sourceAuthority[selected.id].retiredRestorations } : {}) };
        if (!fresh.manual) { ledger.suppressed = [...new Set([...ledger.suppressed, fresh.sourceHash])]; ledger.captures[fresh.sourceHash].removed = true; }
        await intake.save(ledger); this.clearApprovals(); this.previews.delete(token);
        await vault.checkpoint('capture-deletion-authorized');
        await finishDeletion(intake, ledger, selected.id);
      } finally { for (const file of acquired.reverse()) await vault.release(file); }
      return true;
    }));
  }
}
async function inspectAdjacentTitlePrefix(vault, targets) {
  const captures = targets.filter(target => target.kind === 'capture');
  if (captures.length !== 1) throw changed();
  // Discovery covers the full namespace even after the current file is gone.
  // Only literal manifested backup paths retain their existing ownership proof.
  const current = path.join(vault.vault, captures[0].file), parent = path.dirname(current);
  await vault.contained(parent);
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
  const prefix = (path.basename(current) + '.before-title-').toLowerCase();
  const known = new Set(targets.filter(target => target.kind === 'source-title-backup').map(target => target.file));
  for (const name of await fs.readdir(parent)) {
    if (name.toLowerCase().startsWith(prefix) && !known.has(relative(vault, path.join(parent, name)))) throw changed();
  }
}
async function inspectManualPeers(vault, manual, provenTitles = new Set()) {
  // Adjacent recovery records are deliberately held until their separate
  // source/writing inventory is reviewed. They cannot hide behind completion.
  const visit = async directory => {
    await vault.contained(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.intake', '.git', '.obsidian', '.codex', 'managed-home'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(file);
      else if (entry.isFile() && /(?:\.md\.pending|\.md\.title-transaction\.json|\.md\.before-title-[a-f0-9-]+\.bak)$/.test(entry.name)) {
        const text = await fs.readFile(file, 'utf8');
        if (text.includes(manual.captureId) && !provenTitles.has(relative(vault, file)) && !await deletionDependents.pureWritingPending(vault, file)) throw changed();
      }
    }
  };
  await visit(vault.vault);
}
async function readManualSelection(file, manual) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.md') || file.split(/[\\/]/).some(part => ['.codex', 'managed-home'].includes(part.toLowerCase()))) throw Error('Choose an ordinary explicitly selected manual capture Markdown backup.');
  const directories = [];
  for (let directory = path.dirname(file);;) {
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
    directories.push({ file: directory, dev: String(stat.dev), ino: String(stat.ino) });
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw changed();
  const bytes = await fs.readFile(file), after = await fs.lstat(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.nlink !== 1n || bytes.length !== Number(after.size)) throw changed();
  for (const item of directories) {
    const stat = await fs.lstat(item.file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== item.dev || String(stat.ino) !== item.ino) throw changed();
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes), note = parse(content);
  if (!note || note.id !== manual.captureId || note.type !== manual.type || note.capturedAt !== manual.capturedAt || hash(bytes) !== manual.currentHash) throw Error('The selected backup does not match the deleted manual capture identity, instant and exact content.');
  return { content, sha256: hash(bytes), dev: String(before.dev), ino: String(before.ino), directories };
}
async function inspectDeletion(intake, ledger, id) {
  validateAuthority(ledger);
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  if (authority.phase !== 'deleting') return [];
  if (await fs.realpath(vault.vault) !== authority.root) throw changed();
  const deletion = new CaptureDeletion({ getVault: () => vault });
  await sourceParents(intake, authority);
  await inspectAdjacentTitlePrefix(vault, authority.targets);
  const capture = ledger.captures[authority.sourceHash];
  if (!authority.manual && (!capture || capture.id !== id || !capture.removed || !ledger.suppressed.includes(authority.sourceHash))) throw changed();
  if (authority.mixedRecovery) return mixedDeletion.inspect(intake, ledger, id);
  if (manualTitle.explicit(authority)) manualTitle.validate(authority, id);
  else sourceTitle.inspectProofs(intake, ledger, authority);
  await pendingTitle.inspect(intake, ledger, authority);
  await inspectManualPeers(vault, { captureId: id }, new Set([...(authority.titleProofs || []).map(proof => proof.before), ...pendingTitle.sidecars(authority.titleRecovery)]));
  const knownPaths = new Set(authority.targets.map(target => target.file));
  for (const note of (await vault.scan()).filter(note => note.id === id)) if (!knownPaths.has(relative(vault, note.file))) throw changed();
  for (const folder of [intake.dir, path.join(vault.root, 'Revisions')]) for (const name of await fs.readdir(folder)) {
    if (folder === intake.dir && name === 'ledger.json') continue;
    const file = path.join(folder, name), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw changed();
    const text = await fs.readFile(file, 'utf8');
    if ((text.includes(id) || authority.sourceHash && text.includes(authority.sourceHash)) && !knownPaths.has(relative(vault, file))) throw changed();
  }
  // Validate the entire remaining manifest before the first unlink, and each file again at unlink.
  if (manualTitle.explicit(authority)) return manualTitle.inspect(intake, authority);
  if (authority.inventoryVersion === 2) {
    sourceInventory.inspectPointers(ledger, authority);
    return sourceInventory.inspectTargets(intake, authority);
  }
  const remaining = [];
  for (const target of authority.targets) {
    const file = path.join(vault.vault, target.file);
    try {
      if (JSON.stringify(await deletion.target(vault, file, target.kind)) !== JSON.stringify(target)) throw changed();
      const text = await fs.readFile(file, 'utf8');
      if (authority.manual) {
        const note = parse(text), manual = authority.manual;
        if (target.kind !== 'capture' || target.file !== manual.relative || target.sha256 !== manual.currentHash || !note || note.id !== id || note.type !== manual.type || note.capturedAt !== manual.capturedAt) throw changed();
      } else if (target.kind === 'snapshot') {
        const revision = JSON.parse(text), known = revisionAdmission(ledger, revision.id);
        if (!uuid(revision.id) || revision.captureId !== id || revision.sourceHash !== authority.sourceHash || !capture.revisions.includes(revision.id) || !known || known.captureId !== id || known.sourceHash !== authority.sourceHash || known.snapshotHash !== target.sha256 || file !== path.join(vault.root, 'Revisions', revision.id + '.json')) throw changed();
      } else {
        const note = parse(text), metadata = YAML.parse(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '');
        if (!note || note.id !== id || note.type !== 'reel_import' || metadata.source_hash !== authority.sourceHash || !capture.revisions.includes(metadata.source_revision)) throw changed();
        if (target.kind === 'capture' && target.sha256 !== capture.currentHash || target.kind === 'source-backup' && (path.dirname(file) !== intake.dir || !new RegExp(`^${id}-[a-f0-9-]{36}\\.before(?:-[a-f0-9-]{36})?\\.md$`).test(path.basename(file)))) throw changed();
      }
      remaining.push(target);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return remaining;
}
async function finishDeletion(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  if (authority.mixedRecovery) await mixedDeletion.publish(intake, ledger, id);
  const remaining = await inspectDeletion(intake, ledger, id);
  const deletion = new CaptureDeletion({ getVault: () => vault });
  const extendedInventory = authority.inventoryVersion === 2 || manualTitle.explicit(authority);
  for (const target of remaining) {
    const file = path.join(vault.vault, target.file);
    await inspectDeletion(intake, ledger, id);
    await intake.storage.guard();
    if (extendedInventory) {
      await sourceParents(intake, authority);
      if (manualTitle.explicit(authority)) {
        if (!(await manualTitle.inspect(intake, authority)).some(item => item.file === target.file)) throw changed();
      } else await sourceInventory.inspectTarget(intake, authority, target);
    } else if (JSON.stringify(await deletion.target(vault, file, target.kind)) !== JSON.stringify(target)) throw changed();
    if (authority.mixedRecovery) await mixedDeletion.inspect(intake, ledger, id, true);
    await fs.unlink(file); await vault.checkpoint('capture-deletion-unlinked');
  }
  if ((await inspectDeletion(intake, ledger, id)).length) throw changed();
  await intake.storage.guard();
  if (extendedInventory) {
    if (authority.mixedRecovery) await mixedDeletion.inspect(intake, ledger, id, true);
    if (authority.inventoryVersion === 2) sourceInventory.retirePointers(ledger, authority);
  }
  authority.phase = 'deleted'; await intake.save(ledger);
}
function installCaptureDeletion({ ipcMain, ...options }) {
  const store = new CaptureDeletion(options);
  ipcMain.handle('capture-delete-preview', (_, input) => store.preview(input?.id));
  ipcMain.handle('capture-delete-cancel', (_, input) => store.cancel(input?.token));
  ipcMain.handle('capture-delete-confirm', (_, input) => store.confirm(input?.token));
  ipcMain.handle('capture-delete-pending', () => store.pending());
  ipcMain.handle('capture-delete-resume', (_, input) => store.resume(input));
  ipcMain.handle('capture-delete-suppressed', () => store.suppressed());
  ipcMain.handle('capture-delete-restoration-preview', (_, input) => store.previewRestoration(input));
  ipcMain.handle('capture-delete-restoration-confirm', (_, input) => store.confirmRestoration(input?.token));
  ipcMain.handle('capture-delete-retry-preview', (_, input) => store.previewRetry(input));
  ipcMain.handle('capture-delete-retry-cancel', (_, input) => store.retries.delete(input?.token));
  ipcMain.handle('capture-delete-retry-confirm', (_, input) => store.confirmRetry(input?.token));
  ipcMain.handle('capture-delete-scope-preview', (_, input) => store.previewScope(input));
  ipcMain.handle('capture-delete-scope-cancel', (_, input) => store.scopeReviews.delete(input?.token));
  ipcMain.handle('capture-delete-scope-confirm', (_, input) => store.confirmScope(input?.token));
}
async function finishRestoration(intake, ledger, id) {
  validateAuthority(ledger);
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  if (authority?.phase !== 'restoring') return;
  await guardRestorationParents(intake, authority);
  if (authority.manual) return finishManualRestoration(intake, ledger, id);
  if (!ledger.suppressed.includes(authority.sourceHash)) throw Error('Restoration authority changed. Suppression remains.');
  const journal = path.join(intake.dir, authority.restoration.journal), transaction = path.join(intake.dir, 'transaction.json');
  if (!authority.restoration.published && ledger.admissions?.[authority.restoration.revision]) {
    // A durable admission proves this exact publication already happened. Only
    // verify and acknowledge it; replay must never recreate its missing output.
    const admission = revisionAdmission(ledger, authority.restoration.revision), capture = ledger.captures[authority.sourceHash];
    const snapshot = path.join(vault.root, 'Revisions', authority.restoration.revision + '.json'), destination = intake.destination(capture);
    const stage = path.join(intake.dir, authority.restoration.revision + '.stage'), snapshotStage = path.join(intake.dir, authority.restoration.revision + '.snapshot.stage');
    if (!admission || admission.captureId !== id || admission.sourceHash !== authority.sourceHash || admission.sourceGeneration !== authority.generation || capture.currentRevision !== authority.restoration.revision) throw Error('Restoration admission changed. Suppression remains.');
    const current = await intake.ownedFile(destination, stage, 'Restoration capture'), retained = await intake.ownedFile(snapshot, snapshotStage, 'Restoration snapshot');
    if (!current || !retained) throw Error('Restoration publication is missing. Its durable admission cannot recreate it; suppression remains.');
    const snapshotBytes = await fs.readFile(snapshot, 'utf8'), revision = JSON.parse(snapshotBytes), content = await fs.readFile(destination, 'utf8');
    if (hash(snapshotBytes) !== admission.snapshotHash || revision.id !== capture.currentRevision || revision.captureId !== id || revision.sourceHash !== authority.sourceHash || hash(content) !== capture.currentHash || content !== noteText(capture, revision)) throw Error('Restoration publication changed. Its durable admission cannot replace it; suppression remains.');
    const cleanup = [];
    for (const [file, peer, expected] of [[stage, destination, hash(content)], [snapshotStage, snapshot, admission.snapshotHash], [transaction, journal, authority.restoration.sha256]]) {
      const info = await intake.ownedFile(file, peer, 'Restoration publication acknowledgement');
      if (!info) continue;
      if (hash(await fs.readFile(file)) !== expected) throw Error('Restoration acknowledgement bytes changed. All files remain.');
      cleanup.push({ file, peer, expected, dev: info.dev, ino: info.ino });
    }
    for (const item of cleanup) {
      await guardRestorationParents(intake, authority);
      const info = await intake.ownedFile(item.file, item.peer, 'Restoration publication acknowledgement');
      if (!info || info.dev !== item.dev || info.ino !== item.ino || hash(await fs.readFile(item.file)) !== item.expected) throw Error('Restoration acknowledgement identity changed.');
      await fs.unlink(item.file);
    }
    await guardRestorationParents(intake, authority);
    authority.restoration.published = true; await intake.save(ledger);
  }
  if (!authority.restoration.published) {
    await intake.ownedFile(journal, transaction, 'Selected restoration journal');
    const bytes = await fs.readFile(journal, 'utf8'); if (hash(bytes) !== authority.restoration.sha256) throw Error('Selected restoration journal changed. Suppression remains.');
    const tx = JSON.parse(bytes); intake.validateTransaction(tx);
    if (tx.restoreOperation !== authority.operationId || tx.sourceGeneration !== authority.generation || tx.revision.id !== authority.restoration.revision || tx.capture.id !== id || tx.sourceHash !== authority.sourceHash) throw Error('Selected restoration identity changed.');
    await intake.ownedFile(transaction, journal, 'Active restoration journal');
    try { await fs.link(journal, transaction); } catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(transaction, 'utf8') !== bytes) throw Error('Another source journal needs explicit recovery.'); }
    await intake.finish(tx, ledger);
    await guardRestorationParents(intake, authority);
    authority.restoration.published = true; await intake.save(ledger);
  }
  await verifyRestorationPublication(intake, ledger, id);
  const remaining = await intake.ownedFile(journal, [], 'Selected restoration journal');
  if (remaining) { if (hash(await fs.readFile(journal)) !== authority.restoration.sha256) throw Error('Selected restoration journal changed.'); await fs.unlink(journal); }
  await vault.checkpoint('capture-restoration-published');
  // This explicit asynchronous boundary can admit an external edit or parent
  // replacement. Activation uses fresh ownership and literal bytes afterwards.
  await verifyRestorationPublication(intake, ledger, id);
  authority.phase = 'active'; delete authority.restoration;
  ledger.suppressed = ledger.suppressed.filter(item => item !== authority.sourceHash);
  await intake.save(ledger);
}
function manualFiles(intake, authority) {
  return { journal: path.join(intake.dir, authority.restoration.journal), stage: path.join(intake.dir, `manual-${authority.operationId}.stage`), destination: path.join(intake.vault.vault, authority.manual.relative) };
}
function retirementFiles(intake, receipt) {
  const expected = [path.join(intake.dir, `manual-${receipt.operationId}.stage`), path.join(intake.dir, `restoration-${receipt.operationId}.json`)].map(file => relative(intake.vault, file)).sort();
  if (JSON.stringify(receipt.slots.map(slot => slot.file)) !== JSON.stringify(expected)) throw Error('Restoration retirement does not name this intake folder. All files were preserved.');
  return expected;
}
async function scanManualRecovery(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id], current = manualFiles(intake, authority), known = new Set([current.stage, current.journal]);
  const receipts = [...(authority.retiredRestorations || []), ...(authority.restoration.retirement ? [authority.restoration.retirement] : [])], operations = [authority.operationId, ...receipts.map(receipt => receipt.operationId)];
  for (const receipt of receipts) for (const name of retirementFiles(intake, receipt)) known.add(path.join(intake.vault.vault, name));
  for (const entry of await fs.readdir(intake.dir, { withFileTypes: true })) {
    const file = path.join(intake.dir, entry.name);
    if (known.has(file)) continue;
    if (operations.some(operation => entry.name.startsWith(`manual-${operation}.`) || entry.name.startsWith(`restoration-${operation}.`))) throw held(id, authority, 'An additional manual-operation recovery copy needs explicit review. All files were preserved.');
    const match = entry.name.match(/^(manual|restoration)-([a-f0-9-]{36})\.(stage|json)$/);
    if (!match || !uuid(match[2]) || (match[1] === 'manual') !== (match[3] === 'stage')) continue;
    const other = Object.entries(ledger.sourceAuthority || {}).find(([, value]) => value.operationId === match[2]), peers = [];
    if (other?.[1].manual && match[1] === 'manual') peers.push(path.join(intake.vault.vault, other[1].manual.relative));
    if (other?.[1].phase === 'restoring' && !other[1].manual && other[1].restoration.journal === entry.name) peers.push(path.join(intake.dir, 'transaction.json'));
    const info = await intake.ownedFile(file, peers, 'Additional restoration recovery file');
    if (!info) continue;
    const text = await fs.readFile(file, 'utf8');
    if (match[1] === 'manual') {
      const note = parse(text);
      if (!note || !uuid(note.id) || !['thought', 'link'].includes(note.type)) throw Error('Unattributed manual restoration data needs repair.');
      if (note.id === id) throw held(id, authority, 'An additional manual source stage needs explicit review. All files were preserved.');
      if (info.nlink > 1n && (other?.[0] !== note.id || hash(text) !== other[1].manual.currentHash)) throw Error('Unattributed linked manual restoration data needs repair.');
    } else {
      const value = JSON.parse(text), captureId = value.id || value.capture?.id;
      if (captureId === id) throw held(id, authority, 'An additional selected-source restoration journal needs explicit review. All files were preserved.');
      if (value.content && value.operationId === match[2]) {
        const note = parse(value.content);
        if (Object.keys(value).sort().join(',') !== 'content,generation,id,operationId,schema' || value.schema !== 1 || !uuid(value.id) || !uuid(value.generation) || !note || note.id !== value.id || !['thought', 'link'].includes(note.type)) throw Error('Unattributed restoration journal needs repair.');
      } else {
        intake.validateTransaction(value);
        if (value.restoreOperation !== match[2] || info.nlink > 1n && (other?.[0] !== value.capture.id || hash(text) !== other[1].restoration.sha256)) throw Error('Unattributed imported restoration journal needs repair.');
      }
    }
  }
}
async function verifyRetiredSlots(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id];
  await pendingParents(intake, ledger);
  for (const receipt of authority.retiredRestorations || []) for (const name of retirementFiles(intake, receipt)) {
    const file = path.join(intake.vault.vault, name);
    if (await fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw held(id, authority, 'A file appeared in a retired restoration slot. It was preserved; review the new scope.');
  }
  await scanManualRecovery(intake, ledger, id);
}
async function inspectRetirementSlot(intake, ledger, id, slot) {
  const access = manualAccess(intake, ledger, id), inspector = new CaptureDeletion({ getVault: () => intake.vault }), file = path.join(intake.vault.vault, slot.file);
  const exists = await fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (!exists) return null;
  if (!slot.expected) throw access.fail(`A file appeared in a previously absent restoration slot: ${slot.file}. It was preserved.`);
  const actual = await access.run(file, () => inspector.target(intake.vault, file, 'source-backup'));
  if (['sha256', 'dev', 'ino', 'bytes'].some(key => actual[key] !== slot.expected[key])) throw access.fail(`A reviewed retirement file changed: ${slot.file}. It was preserved.`);
  return file;
}
async function inspectManualRetirement(intake, ledger, id) {
  const receipt = ledger.sourceAuthority[id].restoration.retirement, remaining = [];
  retirementFiles(intake, receipt); await pendingParents(intake, ledger); await scanManualRecovery(intake, ledger, id);
  for (const slot of receipt.slots) { const file = await inspectRetirementSlot(intake, ledger, id, slot); if (file) remaining.push(file); }
  return remaining;
}
async function retireManualOperation(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id], receipt = authority.restoration.retirement, access = manualAccess(intake, ledger, id);
  await inspectManualRetirement(intake, ledger, id);
  for (const slot of receipt.slots) {
    await pendingParents(intake, ledger); const file = await inspectRetirementSlot(intake, ledger, id, slot);
    if (file) { await access.run(file, () => fs.unlink(file)); await intake.vault.checkpoint('capture-restoration-retirement-unlinked'); }
  }
  if ((await inspectManualRetirement(intake, ledger, id)).length) throw access.fail('Restoration retirement is incomplete.');
  authority.retiredRestorations = [...(authority.retiredRestorations || []), receipt]; delete authority.restoration.retirement;
  await intake.save(ledger); await intake.vault.checkpoint('capture-restoration-retired');
}
async function publishManualJournal(intake, authority, value) {
  await sourceParents(intake, authority);
  const bytes = Buffer.from(JSON.stringify(value), 'utf8'), stage = path.join(intake.dir, `journal-${randomUUID()}.stage`), file = path.join(intake.dir, `restoration-${value.operationId}.json`);
  let original;
  try {
    const handle = await fs.open(stage, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); original = await handle.stat({ bigint: true }); }
    finally { await handle.close(); }
    const verify = async (target, peer) => {
      await sourceParents(intake, authority);
      const info = await intake.ownedFile(target, peer ? [peer] : [], 'Created manual restoration journal');
      if (!info || info.dev !== original.dev || info.ino !== original.ino || info.size !== original.size || hash(await fs.readFile(target)) !== hash(bytes)) throw Error('Created manual journal identity changed. All replacements were preserved.');
      const fresh = await intake.ownedFile(target, peer ? [peer] : [], 'Created manual restoration journal');
      if (!fresh || fresh.dev !== original.dev || fresh.ino !== original.ino || fresh.size !== original.size || fresh.nlink !== info.nlink) throw Error('Created manual journal identity changed. All replacements were preserved.');
      return fresh;
    };
    await verify(stage); await fs.link(stage, file); await verify(file, stage); await verify(stage, file); await fs.unlink(stage);
    const info = await verify(file);
    return { journal: path.basename(file), sha256: hash(bytes), journalIdentity: { dev: String(info.dev), ino: String(info.ino), bytes: String(info.size) } };
  } catch (error) {
    // Only the inode created by this call can be cleaned after a failed publish.
    for (const target of [stage, file]) if (original) {
      try {
        const peer = target === stage ? file : stage;
        await sourceParents(intake, authority); const info = await intake.ownedFile(target, [peer], 'Created manual journal cleanup');
        if (!info || info.dev !== original.dev || info.ino !== original.ino || info.size !== original.size || hash(await fs.readFile(target)) !== hash(bytes)) continue;
        await sourceParents(intake, authority); const fresh = await intake.ownedFile(target, [peer], 'Created manual journal cleanup');
        if (fresh && fresh.dev === original.dev && fresh.ino === original.ino && fresh.size === original.size && fresh.nlink === info.nlink) await fs.unlink(target);
      } catch {}
    }
    throw error;
  }
}
async function cleanupManualJournal(intake, authority, journal) {
  const file = path.join(intake.dir, journal.journal);
  try {
    await sourceParents(intake, authority);
    const info = await intake.ownedFile(file, [], 'Uncommitted created manual journal');
    if (!info) return true;
    if (['dev', 'ino', 'size'].some(key => String(info[key]) !== journal.journalIdentity[key === 'size' ? 'bytes' : key]) || hash(await fs.readFile(file)) !== journal.sha256) return false;
    await sourceParents(intake, authority);
    const fresh = await intake.ownedFile(file, [], 'Uncommitted created manual journal');
    if (!fresh || fresh.dev !== info.dev || fresh.ino !== info.ino || fresh.size !== info.size || fresh.nlink !== 1n) return false;
    await fs.unlink(file); return true;
  } catch { return false; }
}
function manualAccess(intake, ledger, id) {
  const run = (file, work) => manualLeaf(intake, ledger, id, file, work);
  return { run, read: file => run(file, () => fs.readFile(file)), owned: (file, peers, label) => run(file, () => intake.ownedFile(file, peers, label)), fail: message => held(id, ledger.sourceAuthority[id], message) };
}
async function verifyManualPublication(intake, ledger, id, peers = []) {
  const authority = ledger.sourceAuthority[id], access = manualAccess(intake, ledger, id), { destination } = manualFiles(intake, authority);
  await guardRestorationParents(intake, authority);
  const info = await access.owned(destination, peers, 'Manual restoration capture');
  if (!info || hash(await access.read(destination)) !== authority.manual.currentHash) throw access.fail('Manual restoration publication is missing or changed. Old source authority remains unavailable.');
  const receipt = authority.restoration.publication;
  if (receipt && (String(info.dev) !== receipt.dev || String(info.ino) !== receipt.ino || String(info.size) !== receipt.bytes)) throw access.fail('Manual restoration publication identity changed. The current file was preserved.');
  return info;
}
async function finishManualRestoration(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id], vault = intake.vault, restoration = authority.restoration, access = manualAccess(intake, ledger, id);
  const { journal, stage, destination } = manualFiles(intake, authority), verify = peers => verifyManualPublication(intake, ledger, id, peers);
  if (restoration.retirement) await retireManualOperation(intake, ledger, id);
  await verifyRetiredSlots(intake, ledger, id);
  if (!restoration.published) {
    const journalInfo = await access.owned(journal, [], 'Selected manual restoration journal');
    if (!journalInfo) throw access.fail('Selected manual restoration journal is missing.');
    if (restoration.journalIdentity && ['dev', 'ino', 'size'].some(key => String(journalInfo[key]) !== restoration.journalIdentity[key === 'size' ? 'bytes' : key])) throw access.fail('Selected manual restoration journal identity changed.');
    const bytes = await access.read(journal); if (hash(bytes) !== restoration.sha256) throw access.fail('Selected manual restoration journal changed.');
    const value = await access.run(journal, () => JSON.parse(bytes.toString('utf8'))), note = parse(value.content || '');
    if (Object.keys(value).sort().join(',') !== 'content,generation,id,operationId,schema' || value.schema !== 1 || value.id !== id || value.operationId !== authority.operationId || value.generation !== authority.generation || !note || note.id !== id || note.type !== authority.manual.type || note.capturedAt !== authority.manual.capturedAt || hash(value.content) !== authority.manual.currentHash) throw access.fail('Selected manual restoration journal identity or content changed.');
    const existingStage = await access.owned(stage, destination, 'Manual restoration stage');
    if (existingStage && hash(await access.read(stage)) !== authority.manual.currentHash) throw access.fail('Manual restoration stage changed.');
    if (!existingStage) await access.run(stage, () => fs.writeFile(stage, value.content, { flag: 'wx', flush: true }));
    await guardRestorationParents(intake, authority);
    await verifyRetiredSlots(intake, ledger, id);
    try { await fs.link(stage, destination); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const output = await access.owned(destination, stage, 'Manual restoration existing output'), peer = await access.owned(stage, destination, 'Manual restoration existing stage');
      if (!output || !peer || output.nlink !== 2n || output.dev !== peer.dev || output.ino !== peer.ino) throw access.fail('Another file occupies the manual restoration destination. It was preserved.');
    }
    const info = await verify([stage]);
    // This durable receipt marks completed publication. Recovery afterwards
    // verifies existing output and never recreates an externally removed file.
    restoration.published = true; restoration.publication = { dev: String(info.dev), ino: String(info.ino), bytes: String(info.size) };
    await intake.save(ledger); await vault.checkpoint('capture-restoration-admitted');
  }
  await verify([stage]);
  for (const [file, peers, expected] of [[stage, [destination], authority.manual.currentHash], [journal, [], restoration.sha256]]) {
    await guardRestorationParents(intake, authority);
    const info = await access.owned(file, peers, 'Manual restoration cleanup');
    if (info) {
      if (file === stage && (info.nlink !== 2n || String(info.dev) !== restoration.publication.dev || String(info.ino) !== restoration.publication.ino || String(info.size) !== restoration.publication.bytes)) throw access.fail('Manual restoration stage identity changed. The replacement was preserved for explicit review.');
      if (file === journal && restoration.journalIdentity && ['dev', 'ino', 'size'].some(key => String(info[key]) !== restoration.journalIdentity[key === 'size' ? 'bytes' : key])) throw access.fail('Manual restoration journal identity changed.');
      if (hash(await access.read(file)) !== expected) throw access.fail('Manual restoration cleanup bytes changed.');
      const fresh = await access.owned(file, peers, 'Manual restoration cleanup');
      if (!fresh || fresh.dev !== info.dev || fresh.ino !== info.ino || fresh.size !== info.size || fresh.nlink !== info.nlink) throw access.fail('Manual restoration cleanup identity changed.');
      await access.run(file, () => fs.unlink(file));
    }
  }
  await verify(); await vault.checkpoint('capture-restoration-published'); await verify();
  await verifyRetiredSlots(intake, ledger, id);
  authority.phase = 'active'; delete authority.restoration; await intake.save(ledger);
}
async function guardRestorationParents(intake, authority) {
  return sourceParents(intake, authority);
}
async function verifyRestorationPublication(intake, ledger, id) {
  const authority = ledger.sourceAuthority[id], vault = intake.vault;
  await guardRestorationParents(intake, authority);
  const capture = ledger.captures[authority.sourceHash], admission = revisionAdmission(ledger, authority.restoration.revision);
  const snapshot = path.join(vault.root, 'Revisions', authority.restoration.revision + '.json');
  if (!capture || !admission || admission.sourceGeneration !== authority.generation || admission.captureId !== id || admission.sourceHash !== authority.sourceHash || capture.currentRevision !== authority.restoration.revision) throw Error('Restoration admission changed. Suppression remains.');
  if (!await intake.ownedFile(snapshot, [], 'Restoration revision') || !await intake.ownedFile(intake.destination(capture), [], 'Restoration capture')) throw Error('Restoration publication is missing. Suppression remains.');
  const snapshotBytes = await fs.readFile(snapshot, 'utf8'), revision = JSON.parse(snapshotBytes), content = await fs.readFile(intake.destination(capture), 'utf8');
  if (hash(snapshotBytes) !== admission.snapshotHash || capture.currentRevision !== revision.id || revision.captureId !== id || revision.sourceHash !== authority.sourceHash || hash(content) !== capture.currentHash || content !== noteText(capture, revision)) throw Error('Restoration publication changed. Suppression remains.');
  await guardRestorationParents(intake, authority);
}
module.exports = { CaptureDeletion, finishDeletion, finishRestoration, guardRestorationParents, installCaptureDeletion, inspectManualPeers };
