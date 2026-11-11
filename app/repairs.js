const fs = require('node:fs/promises');
const native = require('node:fs');
const { assertAnnotationPublication, annotationRemoved, validateAnnotationRemovals } = require('./annotation-authority');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { parseAnnotation } = require('./vault');
const { revisionAdmission, activeAdmission, validateAuthority } = require('./source-authority');
const { readExactSync, validProof, verifyAbsentSync, verifyStageSync, writeStage } = require('./staged-publication');

async function annotationAuthority(intake) {
  // A caller can still hold the ledger it loaded before an awaited publication.
  // Check that baseline without adopting a replacement as its new CAS target.
  const view = await intake.storage.view();
  if (!intake.storage.matches(view)) throw Error('Intake ledger changed during this operation. Refresh before retrying; the changed authority was preserved.');
  const ledger = view.text === null ? {} : JSON.parse(view.text);
  validateAuthority(ledger); validateAnnotationRemovals(ledger); return ledger;
}

const urlPath = relative => relative.split(path.sep).map(encodeURIComponent).join('/');
const reservedIdentityReason = 'A preserved file at a held restoration path claims this identity. Review the preserved file and refresh before editing or choosing a copy.';
function admittedOutputHold(intake, ledger, sourceHash) {
  const block = ledger.blocks[sourceHash];
  if (!intake.isCommittedOutputHold(block)) return false;
  const admission = revisionAdmission(ledger, block.incomingRevision);
  return !!admission && admission.sourceHash === sourceHash && admission.captureId === ledger.captures[sourceHash]?.id;
}
function sourceLink(content, relative) {
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return content;
  // End metadata at its first delimiter before examining the independent body.
  const body = content.slice(frontmatter[0].length);
  return frontmatter[0] + body.replace(/^(\r?\n# Annotation\r?\n\r?\n)Source: \[Capture\]\([^\r\n]*\)(?=\r?\n|$)/, (_, header) => header + 'Source: [Capture](' + urlPath(relative) + ')');
}
function install(Intake, { hash, read, noteText, acceptedOutcome }) {
  async function writeOwnedIntentStage(file, intent, guard) {
    guard();
    const handle = await fs.open(file, 'wx');
    try {
      const { dev, ino } = await handle.stat({ bigint: true });
      const identity = { dev: String(dev), ino: String(ino) };
      const bytes = JSON.stringify({ ...intent, intentIdentity: identity });
      guard();
      await handle.writeFile(bytes);
      await handle.sync();
      guard();
      return { identity, proof: { ...identity, digest: hash(bytes) } };
    } finally { await handle.close(); }
  }
  Intake.prototype.syncMoves = async function () {
    const annotations = await this.annotations(), ledger = await this.load();
    const { notes, owned, repairable, excluded, heldRestorations, reserved } = await this.vault.captureInventory({ ledger, guardLedger: () => this.storage.guard() });
    ledger.identityIssues = {}; ledger.identityChoices ||= {}; this.vault.identityPaths = new Map();
    const groups = new Map(); for (const note of notes) { if (!groups.has(note.id)) groups.set(note.id, []); groups.get(note.id).push(note); }
    const importedIds = new Set(Object.values(ledger.captures).map(capture => capture.id));
    for (const id of reserved.captures) if (importedIds.has(id) || groups.has(id)) {
      ledger.identityIssues[id] = { kind: 'restoration-collision', id, reason: reservedIdentityReason };
      this.vault.identityPaths.set(id, null);
    }
    for (const [id, matches] of groups) {
      if (reserved.captures.has(id)) continue;
      if (!importedIds.has(id) && !matches.some(note => repairable.has(note))) continue;
      const choice = ledger.identityChoices[id];
      if (matches.length === 1 && !excluded.has(matches[0])) continue;
      const files = matches.map(note => ({ file: path.relative(this.vault.vault, note.file), hash: hash(note.content) })).sort((a, b) => a.file.localeCompare(b.file));
      const copies = choice && files.filter(item => item.file !== choice.file);
      if (choice && files.some(item => item.file === choice.file) && JSON.stringify(copies) === JSON.stringify(choice.copies)) this.vault.identityPaths.set(id, path.join(this.vault.vault, choice.file));
      else { ledger.identityIssues[id] = { kind: 'duplicate', id, reason: 'Duplicate identity. Both files are preserved; choose the managed file explicitly. Other copies remain excluded while their bytes are unchanged.', files, token: hash(JSON.stringify(files)) }; this.vault.identityPaths.set(id, null); }
    }
    const annotationGroups = new Map(), annotationPaths = new Set();
    for (const annotation of annotations) { if (!annotationGroups.has(annotation.id)) annotationGroups.set(annotation.id, []); annotationGroups.get(annotation.id).push(annotation); }
    for (const id of reserved.annotations) {
      ledger.identityIssues['annotation:' + id] = { kind: 'restoration-collision', id, reason: reservedIdentityReason };
    }
    for (const [annotationId, matches] of annotationGroups) {
      if (reserved.annotations.has(annotationId)) continue;
      // Annotation choices never confer authority over a capture with the same UUID.
      const id = 'annotation:' + annotationId;
      const choice = ledger.identityChoices[id];
      if (matches.length === 1 && !choice?.copies.some(copy => copy.file === path.relative(this.vault.vault, matches[0].file))) { annotationPaths.add(matches[0].file); continue; }
      const files = matches.map(note => ({ file: path.relative(this.vault.vault, note.file), hash: hash(note.content) })).sort((a, b) => a.file.localeCompare(b.file));
      const copies = choice && files.filter(item => item.file !== choice.file);
      if (choice && files.some(item => item.file === choice.file) && JSON.stringify(copies) === JSON.stringify(choice.copies)) annotationPaths.add(path.join(this.vault.vault, choice.file));
      else ledger.identityIssues[id] = { kind: 'duplicate', id, reason: 'Duplicate identity in annotations. Both files are preserved; choose the linked file explicitly. Relationship updates are paused for these copies. Other copies remain excluded while their bytes are unchanged.', files, token: hash(JSON.stringify(files)) };
    }
    for (const [sourceHash, capture] of Object.entries(ledger.captures)) {
      // An output hold may deliberately retain a hardlinked capture stage.
      if (capture.removed || this.isPublicationOutputHold(ledger.blocks[sourceHash]) || heldRestorations.has(capture.id)) continue;
      if (ledger.identityIssues[capture.id]) { capture.identityIssue = ledger.identityIssues[capture.id].reason; continue; }
      if (capture.id === this.pendingTitleCapture) continue;
      delete capture.identityIssue;
      const matches = notes.filter(note => owned.has(note) && note.id === capture.id && (!this.vault.identityPaths.has(capture.id) || note.file === this.vault.identityPaths.get(capture.id)));
      if (!matches.length) {
        capture.identityIssue = 'Missing managed note. Updates are paused until explicit restore or confirmed removal from active intake.';
        ledger.identityIssues[capture.id] = { kind: 'missing', id: capture.id, sourceHash: Object.keys(ledger.captures).find(key => ledger.captures[key] === capture), reason: capture.identityIssue, token: hash(JSON.stringify([capture.id, capture.currentRevision, capture.currentHash, capture.relative || capture.file])) };
        continue;
      }
      if (matches.length !== 1) continue;
      const note = matches[0];
      capture.relative = path.relative(this.vault.vault, note.file);
      reserved.verify();
      await this.detachRestoredBackup(note, sourceHash, capture, ledger);
      await this.ownedFile(note.file, [], 'Moved capture');
      for (const annotation of annotations.filter(item => item.captureId === capture.id)) {
        if (!annotationPaths.has(annotation.file) || ledger.linkHolds?.[annotation.id]) continue;
        const relative = path.relative(path.dirname(annotation.file), note.file), content = sourceLink(annotation.content, relative);
        if (content === annotation.content) continue;
        const id = randomUUID();
        reserved.verify();
        await this.publishJournal(path.join(this.dir, 'link-intent.json'), { schema: 1, id, file: path.relative(this.vault.vault, annotation.file), before: annotation.content, content, relative });
        await this.vault.checkpoint('link-intent-published');
        await this.finishLink(ledger);
      }
    }
    await this.save(ledger, reserved.verify);
  };
  Intake.prototype.restoreMissing = async function ({ id, token }, now) {
    return this.locked(async () => {
      await this.syncMoves(); const ledger = await this.load(), issue = ledger.identityIssues[id];
      if (issue?.kind !== 'missing' || issue.token !== token) throw Error('Missing-note state changed. Refresh before restoring.');
      const previous = ledger.captures[issue.sourceHash], bytes = await read(path.join(this.vault.root, 'Revisions', previous.currentRevision + '.json'));
      const known = revisionAdmission(ledger, previous.currentRevision);
      if (bytes === null || !known || hash(bytes) !== known.snapshotHash) throw Error('The last managed revision is unavailable or changed. Restore a vault backup; no note was recreated.');
      const revision = JSON.parse(bytes), capture = { ...previous, restoredAt: now }; delete capture.identityIssue;
      const content = noteText(capture, revision); capture.currentHash = hash(content);
      const resolution = randomUUID(), tx = { schema: 1, restore: true, resolution, key: ledger.sources[0].id + ':restore-' + id, sourceHash: issue.sourceHash, capture, revision, content, previousHash: null, previous: null, backup: id + '-' + revision.id + '.before-' + resolution + '.md', ...(ledger.sourceAuthority?.[id]?.phase === 'active' ? { sourceGeneration: ledger.sourceAuthority[id].generation } : {}) };
      if (await read(this.destination(capture)) !== null) throw Error('The destination now exists. Refresh before restoring; its content was preserved.');
      await this.publishJournal(path.join(this.dir, 'transaction.json'), tx);
      try { await this.finish(tx, ledger); } catch (error) {
        if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message);
        else if (error.intakeDeferred) await this.defer(tx, ledger, error.message);
        else throw error;
        throw Error('Restore paused after a destination change. All files were preserved.');
      }
    });
  };
  Intake.prototype.removeMissing = async function ({ id, token }, now) {
    return this.locked(async () => {
      await this.syncMoves(); const ledger = await this.load(), issue = ledger.identityIssues[id];
      if (issue?.kind !== 'missing' || issue.token !== token) throw Error('Missing-note state changed. Refresh before confirming removal.');
      const capture = ledger.captures[issue.sourceHash]; capture.removed = true; capture.removedAt = now; delete capture.identityIssue;
      ledger.suppressed = [...new Set([...ledger.suppressed, issue.sourceHash])]; delete ledger.identityIssues[id];
      for (const outcome of Object.values(ledger.outcomes)) if (outcome.sourceHash === issue.sourceHash) { outcome.status = 'suppressed'; outcome.reason = 'Removed from active intake by confirmation. Revision history, annotations and recovery files are retained; automatic re-import is suppressed.'; }
      await this.save(ledger);
    });
  };
  Intake.prototype.chooseIdentity = async function ({ id, file, token }) {
    return this.locked(async () => {
      await this.syncMoves(); const ledger = await this.load(), issue = ledger.identityIssues[id];
      if (issue?.kind !== 'duplicate' || issue.token !== token || !issue.files.some(item => item.file === file)) throw Error('Identity copies changed. Refresh and inspect all copies before choosing.');
      const selected = this.destination({ relative: file }); await this.ownedFile(selected, [], 'Selected identity file');
      if (!id.startsWith('annotation:') && !Object.values(ledger.captures).some(capture => capture.id === id)) {
        const { repairable } = await this.vault.captureInventory({ ledger, id, guardLedger: () => this.storage.guard() });
        if (![...repairable].some(candidate => candidate.file === selected)) throw Error('Choose a capture that belongs to the selected managed parent. Other copies were preserved.');
      }
      ledger.identityChoices[id] = { file, copies: issue.files.filter(item => item.file !== file) };
      await this.save(ledger); await this.syncMoves();
    });
  };
  Intake.prototype.finishLink = async function (ledger) {
    const journal = path.join(this.dir, 'link-intent.json'), baseline = this.storage.expected;
    const ordinary = this.vault.publicationFolders(this.dir).guard;
    const journalInfo = native.lstatSync(journal, { bigint: true, throwIfNoEntry: false });
    if (!journalInfo) return;
    const journalLinks = Number(journalInfo.nlink);
    if (journalLinks !== 1 && journalLinks !== 2) throw Error('The relationship intent has unknown aliases. All files were preserved.');
    const journalRecord = readExactSync(journal, ordinary, journalLinks);
    let bytes = journalRecord.bytes.toString('utf8'), journalProof = journalRecord.proof;
    const intent = JSON.parse(bytes), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if (intent.schema !== 1 || !uuid.test(intent.id) || typeof intent.before !== 'string' || typeof intent.content !== 'string' || typeof intent.relative !== 'string' || intent.content !== sourceLink(intent.before, intent.relative) || !parseAnnotation(intent.before) || bytes !== JSON.stringify(intent)) throw Error('Invalid relationship repair journal. Files were preserved.');
    if (Object.hasOwn(intent, 'stageProof') && (!validProof(intent.stageProof) || Object.keys(intent.stageProof).length !== 3 ||
        intent.stageProof.digest !== hash(intent.content))) throw Error('Invalid relationship stage proof. Files were preserved.');
    const annotationId = parseAnnotation(intent.before).id;
    if (annotationRemoved(await annotationAuthority(this), annotationId)) return { held: true, removed: true };
    const file = this.destination({ relative: intent.file }), backup = path.join(this.dir, 'link-' + intent.id + '.before.md'), stage = path.join(this.dir, 'link-' + intent.id + '.stage');
    const archive = path.join(this.dir, `link-${intent.id}.json`), parent = this.vault.publicationFolders(path.dirname(file)).guard;
    const guard = () => { ordinary(); parent(); };
    const verifyIntent = () => {
      this.storage.guardSync(baseline);
      verifyStageSync(journal, guard, journalProof, journalLinks);
      if (journalLinks === 2) verifyStageSync(archive, guard, journalProof, 2);
      else verifyAbsentSync(archive, guard);
    };
    await this.vault.contained(path.dirname(file));
    const currentInfo = await this.ownedFile(file, [backup, stage], 'Annotation relationship');
    const backupInfo = await this.ownedFile(backup, file, 'Annotation relationship backup');
    const changed = message => Object.assign(Error(message), { annotationLinkConflict: true });
    const exact = (name, content, links = 1, info) => {
      const digest = hash(content), expected = info && { dev: String(info.dev), ino: String(info.ino), digest };
      const { proof } = readExactSync(name, guard, links, expected);
      if (proof.digest !== digest) throw changed('Annotation relationship files changed. All versions were preserved.');
      return proof;
    };
    const recordStage = async proof => {
      if (journalLinks !== 1) throw changed('The relationship intent is already held. All files were preserved.');
      const replacement = path.join(this.dir, `link-intent-${randomUUID()}.tmp`);
      const updated = JSON.stringify({ ...intent, stageProof: proof });
      const replacementProof = await writeStage(replacement, updated, guard);
      try {
        verifyIntent();
        verifyStageSync(stage, guard, proof);
        verifyAbsentSync(file, guard);
        verifyStageSync(replacement, guard, replacementProof);
        native.renameSync(replacement, journal);
        verifyStageSync(journal, guard, replacementProof);
        journalProof = replacementProof;
        bytes = updated;
        intent.stageProof = proof;
      } finally {
        try {
          readExactSync(replacement, guard, 1, replacementProof);
          native.unlinkSync(replacement);
        } catch (error) {
          if (error.code !== 'ENOENT') this.vault.warnings.push('A relationship intent stage remains for guarded inspection.');
        }
      }
    };
    try {
      let current = await read(file), before = await read(backup), backupProof, outputProof;
      if (current !== intent.content) {
        if (before === null) {
          if (current !== intent.before) throw changed('Annotation changed during move repair. Its writing was preserved.');
          backupProof = exact(file, intent.before, 1, currentInfo);
          assertAnnotationPublication(await annotationAuthority(this), annotationId);
          verifyIntent();
          verifyStageSync(file, guard, backupProof);
          verifyAbsentSync(backup, guard, () => changed('An independent annotation relationship backup appeared. Both files were preserved.'));
          try { native.linkSync(file, backup); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            throw changed('An independent annotation relationship backup appeared. Both files were preserved.');
          }
          verifyStageSync(file, guard, backupProof, 2);
          verifyStageSync(backup, guard, backupProof, 2);
          native.unlinkSync(file);
          verifyAbsentSync(file, guard);
          verifyStageSync(backup, guard, backupProof);
          before = intent.before;
          current = null;
        } else if (before === intent.before && current === intent.before && backupInfo?.nlink === 2n) {
          backupProof = exact(backup, intent.before, 2, backupInfo);
          verifyIntent();
          verifyStageSync(file, guard, backupProof, 2);
          verifyStageSync(backup, guard, backupProof, 2);
          native.unlinkSync(file);
          verifyAbsentSync(file, guard);
          verifyStageSync(backup, guard, backupProof);
          current = null;
        }
        if (before !== intent.before) {
          if (current === null && before !== null) {
            const retained = exact(backup, before, 1, backupInfo);
            verifyIntent();
            verifyStageSync(backup, guard, retained);
            verifyAbsentSync(file, guard, () => changed('Annotation destination was recreated during relationship repair. Both files were preserved.'));
            try { native.linkSync(backup, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
          throw changed('Annotation changed during relationship repair. Both versions were preserved.');
        }
        if (current !== null) throw changed('Annotation destination was recreated during relationship repair. Both files were preserved.');
        backupProof ||= exact(backup, intent.before, 1, backupInfo);
        assertAnnotationPublication(await annotationAuthority(this), annotationId);
        outputProof = intent.stageProof;
        if (!outputProof) {
          try { outputProof = await writeStage(stage, intent.content, guard); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            throw changed('An independent relationship stage appeared. All files were preserved.');
          }
          await recordStage(outputProof);
        }
        assertAnnotationPublication(await annotationAuthority(this), annotationId);
        verifyIntent();
        verifyStageSync(backup, guard, backupProof);
        verifyStageSync(stage, guard, outputProof);
        verifyAbsentSync(file, guard, () => changed('Annotation destination was recreated during relationship publication. Both files were preserved.'));
        try { native.linkSync(stage, file); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          throw changed('Annotation destination was recreated during relationship publication. Both files were preserved.');
        }
      }
      const hasStage = !!native.lstatSync(stage, { throwIfNoEntry: false });
      const links = hasStage ? 2 : 1;
      backupProof ||= exact(backup, intent.before, 1, backupInfo);
      outputProof ||= intent.stageProof;
      if (!outputProof) throw changed('The published relationship has no recorded stage identity. All files were preserved.');
      assertAnnotationPublication(await annotationAuthority(this), annotationId);
      verifyIntent();
      verifyStageSync(backup, guard, backupProof);
      verifyStageSync(file, guard, outputProof, links);
      if (hasStage) {
        verifyStageSync(stage, guard, outputProof, 2);
        native.unlinkSync(stage);
      }
      verifyAbsentSync(stage, guard);
      verifyStageSync(file, guard, outputProof);
      verifyIntent();
      native.unlinkSync(journal);
    } catch (error) {
      if (!error.annotationLinkConflict) throw error;
      const currentAuthority = await annotationAuthority(this);
      await this.holdLink(intent, bytes, error.message, ledger || currentAuthority, journalProof);
    }
  };
  Intake.prototype.holdLink = async function (intent, bytes, reason, ledger, journalProof) {
    const journal = path.join(this.dir, 'link-intent.json'), archive = path.join(this.dir, 'link-' + intent.id + '.json');
    const file = this.destination({ relative: intent.file }), annotation = parseAnnotation(intent.before);
    const ordinary = this.vault.publicationFolders(this.dir).guard, parent = this.vault.publicationFolders(path.dirname(file)).guard;
    const guard = () => { ordinary(); parent(); };
    const verifyArchive = () => {
      verifyStageSync(journal, guard, journalProof, 2);
      verifyStageSync(archive, guard, journalProof, 2);
    };
    this.storage.guardSync();
    if (!native.lstatSync(archive, { throwIfNoEntry: false })) {
      verifyStageSync(journal, guard, journalProof);
      verifyAbsentSync(archive, guard);
      native.linkSync(journal, archive);
    }
    verifyArchive();
    const detach = [], evidence = [];
    for (const [label, suffix] of [['before', '.before.md'], ['stage', '.stage']]) {
      const peer = path.join(this.dir, 'link-' + intent.id + suffix), info = await this.ownedFile(peer, file, 'Held relationship ' + label);
      if (!info) continue;
      evidence.push(path.basename(peer));
      if (info.nlink !== 2n) continue;
      const content = await fs.readFile(peer), retained = path.join(this.dir, `link-${intent.id}.held-${label}-${hash(content)}.md`);
      await this.ownedFile(retained, [], 'Held relationship evidence');
      try { await fs.writeFile(retained, content, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await this.ownedFile(retained, [], 'Held relationship evidence');
      if (!(await fs.readFile(retained)).equals(content)) throw Error('Relationship evidence conflicts. All publication peers were preserved.');
      evidence.push(path.basename(retained)); detach.push({ peer, info, content });
    }
    ledger.linkHolds ||= {};
    ledger.linkHolds[annotation.id] = { captureId: annotation.captureId, file: intent.file, journal: path.basename(archive), reason, token: hash(bytes), evidence };
    await this.save(ledger, verifyArchive);
    for (const { peer, info, content } of detach) {
      const current = await this.ownedFile(peer, file, 'Held relationship publication peer');
      if (!current || current.dev !== info.dev || current.ino !== info.ino || !(await fs.readFile(peer)).equals(content)) throw Error('Relationship publication peer changed during its hold. All remaining files were preserved.');
      if (current.nlink === 2n) {
        const proof = { dev: String(info.dev), ino: String(info.ino), digest: hash(content) };
        this.storage.guardSync();
        verifyArchive();
        verifyStageSync(peer, guard, proof, 2);
        verifyStageSync(file, guard, proof, 2);
        native.unlinkSync(peer);
      }
    }
    this.storage.guardSync();
    verifyArchive();
    native.unlinkSync(journal);
    verifyStageSync(archive, guard, journalProof);
  };
  Intake.prototype.retryLink = async function ({ id, token }) {
    return this.locked(async () => {
      assertAnnotationPublication(await annotationAuthority(this), id);
      await this.syncMoves(); const ledger = await this.load(), hold = ledger.linkHolds?.[id];
      if (!hold || hold.token !== token || !/^link-[a-f0-9-]{36}\.json$/.test(hold.journal)) throw Error('Annotation relationship hold changed. Refresh before retrying.');
      const archive = path.join(this.dir, hold.journal); await this.ownedFile(archive, [], 'Relationship hold archive');
      const bytes = await read(archive), intent = bytes && JSON.parse(bytes);
      if (!bytes || hash(bytes) !== token || parseAnnotation(intent.before)?.id !== id) throw Error('Annotation relationship evidence changed. Preserve its recovery files.');
      if (ledger.identityIssues['annotation:' + id]) throw Error('Resolve the duplicate annotation identity before retrying its relationship.');
      let matches = (await this.annotations()).filter(note => note.id === id);
      if (matches.length > 1) matches = matches.filter(note => path.relative(this.vault.vault, note.file) === ledger.identityChoices['annotation:' + id]?.file);
      if (matches.length !== 1) throw Error('Annotation is missing or ambiguous. Restore or resolve it before retrying.');
      const annotation = matches[0], capture = Object.values(ledger.captures).find(item => item.id === annotation.captureId);
      if (!capture || capture.removed || capture.identityIssue) throw Error('Restore or resolve the linked capture before retrying this relationship.');
      const relative = path.relative(path.dirname(annotation.file), this.destination(capture)), content = sourceLink(annotation.content, relative);
      delete ledger.linkHolds[id];
      if (content !== annotation.content) {
        await this.publishJournal(path.join(this.dir, 'link-intent.json'), { schema: 1, id: randomUUID(), file: path.relative(this.vault.vault, annotation.file), before: annotation.content, content, relative });
        await this.finishLink(ledger);
      }
      await this.save(ledger); return { held: !!ledger.linkHolds[id] };
    });
  };
  Intake.prototype.annotations = async function (captureId) {
    // Keep this read's authority separate from an outer writer's CAS baseline.
    const reader = new Intake(this.vault), ledger = await reader.load(), observed = reader.storage.expected;
    const reserved = this.vault.reservedRestorationIdentities(ledger);
    const notes = (await this.vault.scan({ annotations: true, excludedCapturePaths: reserved.paths }))
      .filter(note => !reserved.annotations.has(note.id) && (!captureId || note.captureId === captureId) && !annotationRemoved(ledger, note.id));
    reserved.verify();
    for (const note of notes) await this.ownedFile(note.file, [], 'Annotation');
    if (!reader.storage.matches(await reader.storage.view(), observed)) throw Error('Intake ledger changed during the annotation read. Retry context discovery against the current authority.');
    reserved.verify();
    return notes;
  };
  const inspect = Intake.prototype.inspect;
  Intake.prototype.inspect = async function (id, options) {
    const info = await inspect.call(this, id);
    if (options?.annotations === false) return info;
    return { ...info, annotations: await this.annotations(id) };
  };
  Intake.prototype.addAnnotation = async function ({ id, captureId, text }, now) {
    return this.locked(async () => {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || typeof text !== 'string' || !text.trim()) throw Error('Enter annotation text before saving.');
      const ledger = await this.load(), capture = Object.values(ledger.captures).find(x => x.id === captureId);
      assertAnnotationPublication(ledger, id);
      if (!capture) throw Error('Choose an imported capture before adding an annotation.');
      const annotation = '---\ncompanion_id: ' + JSON.stringify(id) + '\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ' + JSON.stringify(captureId) + (ledger.sourceAuthority?.[captureId]?.phase === 'active' ? '\nsource_generation: ' + JSON.stringify(ledger.sourceAuthority[captureId].generation) : '') + '\ncreated_at: ' + JSON.stringify(now) + '\n---\n\n# Annotation\n\nSource: [Capture](' + urlPath(path.relative(path.join(this.vault.root, 'Annotations'), this.destination(capture))) + ')\n\n' + text + '\n';
      const journal = path.join(this.dir, 'annotation-intent.json');
      const ordinary = this.vault.publicationFolders(this.dir).guard;
      const baseline = this.storage.expected;
      const guard = () => { this.storage.guardSync(baseline); ordinary(); };
      const { proof } = await writeOwnedIntentStage(journal, { schema: 1, id, captureId, annotation }, guard);
      verifyStageSync(journal, guard, proof);
      await this.finishAnnotation();
    });
  };
  Intake.prototype.validateAnnotationIntent = function (intent) {
    const mandatory = ['schema', 'id', 'captureId', 'annotation'];
    const allowed = [...mandatory, 'intentIdentity', 'annotationProof'];
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if (!intent || !mandatory.every(key => Object.hasOwn(intent, key)) || !Object.keys(intent).every(key => allowed.includes(key)) ||
        intent.schema !== 1 || typeof intent.id !== 'string' || !uuid.test(intent.id) ||
        typeof intent.captureId !== 'string' || !uuid.test(intent.captureId) || typeof intent.annotation !== 'string') {
      throw Error('Invalid annotation save intent. Preserve .intake for repair.');
    }
    const note = parseAnnotation(intent.annotation), identity = intent.intentIdentity, proof = intent.annotationProof;
    if (!note || note.id !== intent.id || note.captureId !== intent.captureId ||
        Object.hasOwn(intent, 'intentIdentity') && (!identity || Object.keys(identity).length !== 2 ||
          ![identity.dev, identity.ino].every(value => typeof value === 'string' && /^[0-9]+$/.test(value))) ||
        Object.hasOwn(intent, 'annotationProof') && (!identity || !validProof(proof) || Object.keys(proof).length !== 3 ||
          proof.digest !== hash(intent.annotation))) {
      throw Error('Invalid annotation publication proof. Recovery files were preserved.');
    }
    return note;
  };
  Intake.prototype.finishAnnotation = async function () {
    const journal = path.join(this.dir, 'annotation-intent.json'), baseline = this.storage.expected;
    const ordinary = this.vault.publicationFolders(this.dir).guard;
    let record;
    try { record = readExactSync(journal, ordinary); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const intent = JSON.parse(record.bytes);
    this.validateAnnotationIntent(intent);
    const authority = await annotationAuthority(this);
    if (annotationRemoved(authority, intent.id)) return { held: true, removed: true };
    assertAnnotationPublication(authority, intent.id);
    if (!record.bytes.equals(Buffer.from(JSON.stringify(intent))) || intent.intentIdentity &&
        (intent.intentIdentity.dev !== record.proof.dev || intent.intentIdentity.ino !== record.proof.ino)) {
      throw Error('The annotation save intent changed. Recovery files were preserved.');
    }
    const file = path.join(this.vault.root, 'Annotations', intent.id + '.md'), stage = path.join(this.dir, 'annotation-' + intent.id + '.stage');
    const annotationGuard = this.vault.publicationFolders(path.dirname(file)).guard;
    const guard = () => { ordinary(); annotationGuard(); };
    let journalProof = record.proof, proof = intent.annotationProof;
    const verifyIntent = () => {
      this.storage.guardSync(baseline);
      verifyStageSync(journal, guard, journalProof);
    };
    if (!proof) {
      verifyIntent();
      verifyAbsentSync(file, guard);
      verifyAbsentSync(stage, guard);
      proof = await writeStage(stage, intent.annotation, guard);
      const replacement = path.join(this.dir, `annotation-intent-${randomUUID()}.tmp`);
      const { proof: replacementProof } = await writeOwnedIntentStage(replacement, { ...intent, annotationProof: proof }, guard);
      try {
        verifyIntent();
        verifyAbsentSync(file, guard);
        verifyStageSync(stage, guard, proof);
        verifyStageSync(replacement, guard, replacementProof);
        native.renameSync(replacement, journal);
        verifyStageSync(journal, guard, replacementProof);
        journalProof = replacementProof;
      } finally {
        try {
          readExactSync(replacement, guard, 1, replacementProof);
          native.unlinkSync(replacement);
        } catch (error) {
          if (error.code !== 'ENOENT') this.vault.warnings.push('An annotation intent stage remains for guarded inspection.');
        }
      }
    }
    const verifyPair = () => {
      verifyStageSync(stage, guard, proof, 2);
      verifyStageSync(file, guard, proof, 2);
    };
    verifyIntent();
    const staged = native.lstatSync(stage, { throwIfNoEntry: false });
    if (staged) {
      if (!native.lstatSync(file, { throwIfNoEntry: false })) {
        verifyStageSync(stage, guard, proof);
        verifyAbsentSync(file, guard);
        native.linkSync(stage, file);
      }
      verifyPair();
      await this.vault.checkpoint('annotation-published');
      assertAnnotationPublication(await annotationAuthority(this), intent.id);
      verifyIntent();
      verifyPair();
      native.unlinkSync(stage);
    }
    verifyIntent();
    verifyAbsentSync(stage, guard);
    verifyStageSync(file, guard, proof);
    native.unlinkSync(journal);
  };
  Intake.prototype.repairs = async function () {
    return this.locked(async () => {
      await this.syncMoves();
      const ledger = await this.load(), items = Object.values(ledger.identityIssues || {});
      for (const [id, hold] of Object.entries(ledger.linkHolds || {})) items.push({ kind: 'annotation-link', id, ...hold });
      for (const [sourceHash, block] of Object.entries(ledger.blocks)) {
        if (!/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) continue;
        const current = ledger.captures[sourceHash];
        if (admittedOutputHold(this, ledger, sourceHash)) {
          items.push({ kind: 'intake-output-hold', sourceHash, id: current.id, title: current.title, reason: block.reason });
          continue;
        }
        const tx = JSON.parse(await read(path.join(this.dir, block.journal))); this.validateTransaction(tx);
        this.verifyHeldTransaction(ledger, tx);
        if (current?.identityIssue || current?.removed) continue;
        if (tx.sourceHash !== sourceHash || current && current.id !== tx.capture.id) throw Error('Conflict identity does not match current intake history. All files were preserved.');
        const file = this.destination(current || tx.capture);
        await this.ownedFile(file, [], 'Local capture');
        const local = await read(file);
        items.push({ sourceHash, id: tx.capture.id, reason: block.reason, local, incoming: tx.revision.text, incomingRevision: tx.revision.id });
      }
      return items;
    });
  };
  Intake.prototype.resolveConflict = async function ({ sourceHash, text, localHash }, now) {
    return this.locked(async () => {
      if (typeof text !== 'string' || !text.trim()) throw Error('Choose local writing to preserve in an annotation before applying the incoming revision.');
      const checkHold = ledger => {
        if (admittedOutputHold(this, ledger, sourceHash)) throw Error('This source has a publication hold. Keep its current and recovery files for inspection.');
      };
      checkHold(await this.load());
      await this.syncMoves();
      const ledger = await this.load(), block = ledger.blocks[sourceHash];
      checkHold(ledger);
      if (!block || !/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) throw Error('This source has no resolvable incoming conflict.');
      const tx = JSON.parse(await read(path.join(this.dir, block.journal))); this.validateTransaction(tx);
      this.verifyHeldTransaction(ledger, tx);
      const current = ledger.captures[sourceHash];
      if (!current || current.id !== tx.capture.id || tx.sourceHash !== sourceHash || current.identityIssue || current.removed || ledger.suppressed.includes(sourceHash)) throw Error('Resolve the current capture identity or missing-note state before transferring local writing.');
      const note = await this.vault.find(current.id), file = this.destination(current);
      if (note.file !== file || note.type !== 'reel_import') throw Error('The managed capture identity changed. Refresh before resolving.');
      const localInfo = await this.ownedFile(file, [], 'Local capture'); const local = note.content;
      if (local === null || hash(local) !== localHash) throw Error('Local writing changed. Refresh and inspect it before resolving.');
      const capture = { ...tx.capture, id: current.id, file: current.file, relative: current.relative, capturedAt: current.capturedAt, title: note.title, revisions: [...new Set([...current.revisions, tx.revision.id])] };
      delete capture.conflict; delete capture.identityIssue;
      // A noncurrent candidate stays retained while the verified reviewed current
      // supplies the managed note. The annotation preserves the chosen local text.
      const keptCurrent = tx.retainOnly || tx.keptCurrent ? await this.verifiedKeptCurrent({ capture, sourceHash }, ledger) : undefined;
      const content = noteText(capture, keptCurrent || tx.revision); capture.currentHash = hash(content);
      const id = randomUUID(), annotation = `---\ncompanion_id: ${JSON.stringify(id)}\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ${JSON.stringify(tx.capture.id)}\ncreated_at: ${JSON.stringify(now)}\n---\n\n# Annotation\n\nSource: [Capture](${urlPath(path.relative(path.join(this.vault.root, 'Annotations'), this.destination(capture)))})\n\n${text}\n`;
      const intent = { schema: 1, sourceHash, localHash, annotationId: id, annotation, tx: { ...tx, retainOnly: false, ...(keptCurrent ? { keptCurrent } : {}), capture, content, previous: local, previousHash: localHash, externalConflict: false, resolution: id, backup: `${tx.capture.id}-${tx.revision.id}.before-${id}.md` } };
      const intentFile = path.join(this.dir, 'repair-intent.json');
      if (keptCurrent) {
        const { guard } = this.vault.publicationFolders(this.dir);
        const conflict = this.repairConflictWitness(ledger, intent.tx, block, guard);
        if (!conflict) throw Error('The original repair conflict has no exact journal proof. Recovery files were preserved.');
        intent.priorConflict = { block, journalProof: conflict.proof };
        const sourceStage = path.join(this.dir, `journal-${id}.stage`);
        this.storage.guardSync();
        conflict.verify();
        intent.sourceProof = await writeStage(sourceStage, JSON.stringify(intent.tx), guard);
        const intentStage = path.join(this.dir, `repair-intent-${id}.stage`);
        const { proof } = await writeOwnedIntentStage(intentStage, intent, guard);
        const verifyConflict = () => {
          this.storage.guardSync();
          conflict.verify();
          verifyStageSync(sourceStage, guard, intent.sourceProof);
        };
        verifyConflict();
        verifyStageSync(intentStage, guard, proof);
        verifyAbsentSync(intentFile, guard);
        native.linkSync(intentStage, intentFile);
        verifyStageSync(intentStage, guard, proof, 2);
        verifyStageSync(intentFile, guard, proof, 2);
        native.unlinkSync(intentStage);
        verifyStageSync(intentFile, guard, proof);
      } else {
        const ordinary = this.vault.publicationFolders(this.dir).guard;
        const captureGuard = this.vault.publicationFolders(path.dirname(file)).guard;
        const priorFile = path.join(this.dir, block.journal);
        const prior = readExactSync(priorFile, ordinary, 1, block.outputHold?.journal);
        if (!prior.bytes.equals(Buffer.from(JSON.stringify(tx))) || !localInfo) throw Error('The original conflict changed. Recovery files were preserved.');
        const localProof = { dev: String(localInfo.dev), ino: String(localInfo.ino), digest: localHash };
        this.storage.guardSync();
        verifyStageSync(file, captureGuard, localProof);
        intent.priorConflict = { block, journalProof: prior.proof };
        intent.localProof = localProof;
        await this.publishJournal(intentFile, intent);
      }
      await this.vault.checkpoint('repair-intent-published');
      await this.finishRepair();
    });
  };
  Intake.prototype.validateRepairIntent = function (intent) {
    const tx = intent?.tx;
    this.validateTransaction(tx);
    if (intent.schema !== 1 || intent.sourceHash !== tx.sourceHash || intent.localHash !== tx.previousHash || intent.annotationId !== tx.resolution || typeof intent.annotation !== 'string' || !intent.annotation.includes(`capture_id: ${JSON.stringify(tx.capture.id)}\n`)) throw Error('Invalid annotation repair intent. Preserve .intake for repair.');
    const exactProof = proof => validProof(proof) && Object.keys(proof).length === 3;
    const prior = intent.priorConflict;
    if (Object.hasOwn(intent, 'priorConflict') && (!prior || Object.keys(prior).length !== 2 ||
        !exactProof(prior.journalProof) || prior.block?.incomingRevision !== tx.revision.id ||
        typeof prior.block.reason !== 'string' || !/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(prior.block.journal))) {
      throw Error('Invalid original repair conflict proof. Recovery files were preserved.');
    }
    if (Object.hasOwn(intent, 'localProof') && (tx.keptCurrent || !prior || !exactProof(intent.localProof) ||
        intent.localProof.digest !== intent.localHash)) throw Error('Invalid prior capture proof. Recovery files were preserved.');
    if (Object.hasOwn(intent, 'annotationProof') && (!exactProof(intent.annotationProof) ||
        intent.annotationProof.digest !== hash(intent.annotation))) {
      throw Error('Invalid repair annotation proof. Recovery files were preserved.');
    }
    if (Object.hasOwn(intent, 'sourceProof') && (!prior || !exactProof(intent.sourceProof) ||
        intent.sourceProof.digest !== hash(JSON.stringify(tx)))) {
      throw Error('Invalid repair source proof. Recovery files were preserved.');
    }
    const identity = intent.intentIdentity;
    if (Object.hasOwn(intent, 'intentIdentity') && ((!intent.sourceProof && !intent.annotationProof) || !identity || Object.keys(identity).length !== 2 ||
        ![identity.dev, identity.ino].every(value => typeof value === 'string' && /^[0-9]+$/.test(value)))) {
      throw Error('Invalid repair intent identity. Recovery files were preserved.');
    }
  };
  Intake.prototype.finishRepair = async function (expectedJournal) {
    const ledgerBaseline = this.storage.expected;
    expectedJournal?.verify();
    const intentFile = path.join(this.dir, 'repair-intent.json');
    const intentIdentity = await fs.lstat(intentFile, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!intentIdentity) return;
    const bytes = await read(intentFile);
    if (bytes === null) throw Error('The annotation repair intent changed. All remaining files were preserved.');
    const intent = JSON.parse(bytes), tx = intent.tx;
    this.validateRepairIntent(intent);
    const owner = await annotationAuthority(this);
    // The repair can change its active journal names. The selected restoration
    // journals must remain exact across both that transition and hold cleanup.
    const guardRestorations = this.publishedRestorationControlGuard(owner);
    const guardPrecommit = () => { this.storage.guardSync(ledgerBaseline); guardRestorations(); };
    const readPrecommit = async () => {
      const ledger = await this.load();
      if (!this.storage.matches(this.storage.expected, ledgerBaseline)) throw Error('The repair ledger changed. Recovery files were preserved.');
      guardPrecommit();
      return ledger;
    };
    guardPrecommit();
    if (annotationRemoved(owner, intent.annotationId)) return { held: true, removed: true };
    const file = path.join(this.vault.root, 'Annotations', `${intent.annotationId}.md`), stage = path.join(this.dir, `annotation-${intent.annotationId}.stage`);
    const journal = path.join(this.dir, 'transaction.json'), archivedIntent = path.join(this.dir, `repair-${intent.annotationId}.json`);
    const sourceStage = path.join(this.dir, `journal-${intent.annotationId}.stage`);
    const intentStage = path.join(this.dir, `repair-intent-${intent.annotationId}.stage`);
    const ordinary = this.vault.publicationFolders(this.dir).guard;
    const annotationGuard = this.vault.publicationFolders(path.dirname(file)).guard;
    const guard = () => { ordinary(); annotationGuard(); guardRestorations(); };
    let intentProof = { dev: String(intentIdentity.dev), ino: String(intentIdentity.ino), digest: hash(bytes) };
    if (tx.keptCurrent || intent.intentIdentity) {
      const changed = () => Error('The repair intent or its known aliases changed. Recovery files were preserved.');
      const recorded = intent.intentIdentity;
      guardPrecommit();
      guard();
      if (recorded && (recorded.dev !== intentProof.dev || recorded.ino !== intentProof.ino || bytes !== JSON.stringify(intent))) throw changed();
      const staged = native.lstatSync(intentStage, { throwIfNoEntry: false });
      const archived = native.lstatSync(archivedIntent, { throwIfNoEntry: false });
      if (staged) {
        if (!tx.keptCurrent || !recorded || archived || intent.annotationProof) throw changed();
        this.boundRepairConflict(owner, tx, intent.priorConflict, guard)();
        verifyStageSync(sourceStage, guard, intent.sourceProof);
        for (const absent of [journal, archivedIntent, stage, file]) verifyAbsentSync(absent, guard, changed);
        verifyStageSync(intentFile, guard, intentProof, 2);
        verifyStageSync(intentStage, guard, intentProof, 2);
        native.unlinkSync(intentStage);
        verifyStageSync(intentFile, guard, intentProof);
      } else if (archived) {
        verifyStageSync(intentFile, guard, intentProof, 2);
        verifyStageSync(archivedIntent, guard, intentProof, 2);
      } else verifyStageSync(intentFile, guard, intentProof);
    }
    let freshRepair;
    let verifyConflict;
    const settleSourceStage = candidate => {
      candidate.verify();
      if (candidate.links === 1) return candidate;
      guardPrecommit();
      candidate.verify();
      native.unlinkSync(candidate.sourceStage);
      const settled = this.ordinaryRecoveryJournal(owner);
      if (settled?.links !== 1 || settled.sourceStage !== candidate.sourceStage) {
        throw Error('The repair source stage changed. Recovery files were preserved.');
      }
      return settled;
    };
    const linkPinnedRepairSource = verifyRelated => {
      if (!intent.sourceProof) throw Error('The repair source stage has no recorded identity. Recovery files were preserved.');
      const verifyStage = links => verifyStageSync(sourceStage, guard, intent.sourceProof, links);
      guardPrecommit();
      verifyRelated();
      verifyStage(1);
      verifyAbsentSync(journal, guard);
      native.linkSync(sourceStage, journal);
      guardPrecommit();
      verifyRelated();
      verifyStage(2);
      verifyStageSync(journal, guard, intent.sourceProof, 2);
      native.unlinkSync(sourceStage);
      verifyStageSync(journal, guard, intent.sourceProof);
    };
    const retireRecordedAnnotation = () => {
      this.storage.guardSync();
      verifyStageSync(intentFile, guard, intentProof);
      verifyAbsentSync(archivedIntent, guard);
      if (native.lstatSync(stage, { throwIfNoEntry: false })) {
        verifyStageSync(stage, guard, intent.annotationProof, 2);
        verifyStageSync(file, guard, intent.annotationProof, 2);
        native.unlinkSync(stage);
      }
      verifyStageSync(file, guard, intent.annotationProof);
      native.unlinkSync(intentFile);
    };
    const preserveOutputHold = (ledger, error) => {
      const verifySource = this.heldRepairSourceVerifier(ledger, tx, intent.sourceProof, guard);
      const archive = archivedIntent;
      this.storage.guardSync();
      verifySource();
      if (native.lstatSync(archive, { throwIfNoEntry: false })) {
        verifyStageSync(intentFile, guard, intentProof, 2);
        verifyStageSync(archive, guard, intentProof, 2);
      } else {
        verifyStageSync(intentFile, guard, intentProof);
        verifyAbsentSync(archive, guard);
        native.linkSync(intentFile, archive);
      }
      // The annotation is already published. Only an exact owned pair can
      // retire its stage. Independent edits and unknown copies stay intact.
      try {
        guard();
        const staged = native.lstatSync(stage, { bigint: true, throwIfNoEntry: false });
        if (freshRepair) freshRepair.retireAnnotation();
        else if (staged && (intent.annotationProof || !tx.keptCurrent)) {
          const annotationProof = intent.annotationProof || { dev: String(staged.dev), ino: String(staged.ino), digest: hash(intent.annotation) };
          verifyStageSync(stage, guard, annotationProof, 2);
          verifyStageSync(file, guard, annotationProof, 2);
          native.unlinkSync(stage);
          verifyStageSync(file, guard, annotationProof);
        }
      } catch (cause) {
        this.vault.warnings.push(`Held repair annotation files were preserved: ${cause.message}`);
      }
      this.storage.guardSync();
      verifySource();
      verifyStageSync(intentFile, guard, intentProof, 2);
      verifyStageSync(archive, guard, intentProof, 2);
      native.unlinkSync(intentFile);
      verifyStageSync(archive, guard, intentProof);
      if (error) throw Object.assign(Error('Annotation preserved. Incoming publication remains paused for explicit repair.', { cause: error }), { intakeRepairHeld: true });
      return { held: true };
    };
    if (this.hasHeldJournal(owner, tx)) return preserveOutputHold(owner);
    const admission = activeAdmission(owner, tx.revision.identity, tx.capture.id);
    if (admission?.revision === tx.revision.id) {
      if (!intent.annotationProof || !isDeepStrictEqual(admission, acceptedOutcome(tx)) ||
          !isDeepStrictEqual(owner.outcomes?.[tx.key], admission) || !isDeepStrictEqual(owner.captures?.[tx.sourceHash], tx.capture)) {
        throw Error('The accepted repair has no exact annotation cleanup proof. Recovery files were preserved.');
      }
      this.storage.guardSync();
      verifyAbsentSync(journal, guard);
      if (intent.sourceProof) verifyAbsentSync(sourceStage, guard);
      return retireRecordedAnnotation();
    }
    let verifyRetainedHold;
    const hold = async error => {
      // Retain the complete annotation intent before moving the active source
      // journal into its UUID-specific hold. Cleanup follows durable evidence.
      await this.ownedFile(intentFile, archivedIntent, 'Repair intent');
      await this.ownedFile(archivedIntent, intentFile, 'Repair evidence archive');
      if (freshRepair) {
        guardPrecommit();
        expectedJournal.verify();
        native.linkSync(intentFile, archivedIntent);
      } else if (expectedJournal?.verifyRepair) {
        expectedJournal = settleSourceStage(expectedJournal);
        expectedJournal.verifyRepair();
      }
      else if (verifyRetainedHold) verifyRetainedHold();
      else {
        if (tx.keptCurrent) {
          guardPrecommit();
          if (!intent.sourceProof) throw Error('The repair source stage has no recorded identity. Recovery files were preserved.');
          verifyStageSync(sourceStage, guard, intent.sourceProof);
        } else this.storage.guardSync();
        verifyConflict?.();
        verifyStageSync(intentFile, guard, intentProof);
        verifyAbsentSync(archivedIntent, guard);
        native.linkSync(intentFile, archivedIntent);
      }
      const verifyArchive = () => {
        verifyStageSync(intentFile, guard, intentProof, 2);
        verifyStageSync(archivedIntent, guard, intentProof, 2);
      };
      verifyArchive();
      const journal = path.join(this.dir, 'transaction.json');
      const sourceArchive = path.join(this.dir, `conflict-${tx.revision.id}-${tx.resolution}.json`);
      let journalInfo = await this.ownedFile(journal, sourceArchive, 'Repair source journal');
      await this.ownedFile(sourceArchive, journal, 'Repair source archive');
      if (verifyRetainedHold && journalInfo) throw Error('An unproved repair source journal appeared. Recovery files were preserved.');
      if (!journalInfo && !freshRepair) {
        if (tx.keptCurrent) linkPinnedRepairSource(() => { verifyArchive(); verifyConflict?.(); });
        else await this.publishJournal(journal, tx);
        journalInfo = await this.ownedFile(journal, sourceArchive, 'Repair source journal');
      }
      if (!journalInfo) throw Error('The exact repair source journal is missing. Files were preserved.');
      if (!freshRepair) expectedJournal?.verify();
      const ordinary = this.vault.publicationFolders(this.dir).guard;
      const retained = expectedJournal?.verifyRepair || verifyRetainedHold || (freshRepair && (() => freshRepair.verify(2)));
      const guardJournal = () => { ordinary(); retained?.(); verifyArchive(); verifyConflict?.(); };
      const links = Number(journalInfo.nlink);
      if (expectedJournal && links !== expectedJournal.links) throw Error('The exact repair journal gained an unknown alias. Recovery files were preserved.');
      const expected = intent.sourceProof || expectedJournal || { dev: String(journalInfo.dev), ino: String(journalInfo.ino), digest: hash(JSON.stringify(tx)) };
      const { proof } = readExactSync(journal, guardJournal, links, expected);
      if (links === 2) verifyStageSync(sourceArchive, guardJournal, proof, 2);
      const ledger = tx.keptCurrent ? await readPrecommit() : await this.load();
      // A kept-snapshot failure can occur before any annotation exists. Require
      // fresh explicit transfer; a pending retry must never publish this tx.
      await this.archivePrecommitConflict(tx, ledger, error.message, proof, guardJournal);
      const verifySource = this.heldRepairSourceVerifier(ledger, tx, intent.sourceProof, guard);
      this.storage.guardSync();
      verifySource();
      if (retained) {
        this.storage.guardSync();
        retained();
        freshRepair?.retireAnnotation();
        native.unlinkSync(intentFile);
        verifyStageSync(archivedIntent, ordinary, intentProof);
      } else {
        if (intent.annotationProof) {
          try {
            this.storage.guardSync();
            verifyStageSync(stage, guard, intent.annotationProof, 2);
            verifyStageSync(file, guard, intent.annotationProof, 2);
            native.unlinkSync(stage);
            verifyStageSync(file, guard, intent.annotationProof);
          } catch (cause) {
            this.vault.warnings.push(`Held repair annotation files were preserved: ${cause.message}`);
          }
        } else if (!tx.keptCurrent && await this.ownedFile(stage, file, 'Annotation staging file')) await fs.unlink(stage);
        this.storage.guardSync();
        verifySource();
        verifyArchive();
        native.unlinkSync(intentFile);
        verifyStageSync(archivedIntent, guard, intentProof);
      }
      throw Object.assign(Error('Annotation preserved. Incoming publication remains paused for repair.'), { intakeRepairHeld: true });
    };
    if (!expectedJournal) {
      const candidate = this.ordinaryRecoveryJournal(owner);
      if (candidate?.verifyRepair || candidate?.freshRepair) expectedJournal = candidate;
    }
    const heldReason = () => Error('This previously held repair needs a fresh explicit transfer. Earlier evidence was preserved.');
    if (expectedJournal?.verifyRepair) {
      // The exact retained intent proves this operation already entered hold.
      // A later repair of its inputs still requires a fresh explicit transfer.
      expectedJournal.verify();
      return hold(heldReason());
    }
    ordinary();
    const selectFreshRepair = candidate => {
      candidate = settleSourceStage(candidate);
      expectedJournal = candidate;
      freshRepair = candidate.freshRepair;
      candidate.verify();
      if (intentProof.dev !== freshRepair.intentProof.dev || intentProof.ino !== freshRepair.intentProof.ino ||
          intentProof.digest !== freshRepair.intentProof.digest) throw Error('The fresh repair intent changed. Recovery files were preserved.');
    };
    if (expectedJournal?.freshRepair) selectFreshRepair(expectedJournal);
    else if (native.lstatSync(archivedIntent, { throwIfNoEntry: false })) {
      verifyRetainedHold = () => {
        verifyStageSync(intentFile, ordinary, intentProof, 2);
        verifyStageSync(archivedIntent, ordinary, intentProof, 2);
      };
      verifyRetainedHold();
      verifyAbsentSync(journal, ordinary, () =>
        Error('The retained repair intent has an unproved active source journal. Recovery files were preserved.'));
      if (tx.keptCurrent) verifyConflict = this.boundRepairConflict(owner, tx, intent.priorConflict, guard);
      return hold(heldReason());
    }
    if (tx.keptCurrent) verifyConflict = this.boundRepairConflict(owner, tx, intent.priorConflict, guard);
    else if (intent.priorConflict) {
      const { block, journalProof } = intent.priorConflict, previous = path.join(this.dir, block.journal);
      const capture = owner.captures[tx.sourceHash];
      if (!isDeepStrictEqual(owner.blocks[tx.sourceHash], block) || capture?.id !== tx.capture.id ||
          capture.conflict !== block.reason || capture.identityIssue || capture.removed || owner.suppressed.includes(tx.sourceHash) ||
          owner.pending[tx.sourceHash]) throw Error('The original repair conflict changed. Recovery files were preserved.');
      const previousRecord = readExactSync(previous, guard, 1, journalProof), old = JSON.parse(previousRecord.bytes);
      this.validateTransaction(old);
      if (!previousRecord.bytes.equals(Buffer.from(JSON.stringify(old))) || old.sourceHash !== tx.sourceHash ||
          old.capture.id !== tx.capture.id || old.key !== tx.key || !isDeepStrictEqual(old.revision, tx.revision)) {
        throw Error('The original repair conflict changed. Recovery files were preserved.');
      }
      verifyConflict = () => verifyStageSync(previous, guard, journalProof);
    }
    if (!freshRepair && tx.keptCurrent) verifyAbsentSync(journal, guard);
    const admitted = ledger => activeAdmission(ledger, tx.revision.identity, tx.capture.id)?.revision === tx.revision.id &&
      ledger.captures[tx.sourceHash]?.currentRevision === tx.capture.currentRevision &&
      ledger.captures[tx.sourceHash]?.currentHash === tx.capture.currentHash;
    const recordIntentProof = async (field, proof, verifyFiles) => {
      verifyFiles();
      const replacement = path.join(this.dir, `repair-intent-${randomUUID()}.tmp`);
      const updated = await writeOwnedIntentStage(replacement, { ...intent, [field]: proof }, guard);
      const replacementProof = updated.proof;
      try {
        guardPrecommit();
        verifyStageSync(replacement, guard, replacementProof);
        verifyStageSync(intentFile, guard, intentProof);
        verifyAbsentSync(intentStage, guard);
        verifyAbsentSync(archivedIntent, guard);
        verifyConflict?.();
        verifyFiles();
        native.renameSync(replacement, intentFile);
        verifyStageSync(intentFile, guard, replacementProof);
        intentProof = replacementProof;
        intent[field] = proof;
        intent.intentIdentity = updated.identity;
      } finally {
        try {
          readExactSync(replacement, guard, 1, replacementProof);
          native.unlinkSync(replacement);
        } catch (error) {
          if (error.code !== 'ENOENT') this.vault.warnings.push('A repair intent stage remains for guarded inspection.');
        }
      }
    };
    const verifyTransfer = () => {
      verifyStageSync(intentFile, guard, intentProof);
      verifyAbsentSync(intentStage, guard);
      verifyAbsentSync(archivedIntent, guard);
      verifyStageSync(stage, guard, intent.annotationProof, 2);
      verifyStageSync(file, guard, intent.annotationProof, 2);
    };
    const verifyAnnotationForSource = () => { guardPrecommit(); verifyConflict?.(); verifyTransfer(); };
    const retireRepair = async () => {
      if (freshRepair) {
        this.storage.guardSync();
        guard();
        freshRepair.verify();
        freshRepair.retireAnnotation();
        native.unlinkSync(intentFile);
        return;
      }
      return retireRecordedAnnotation();
    };
    if (tx.keptCurrent) {
      try { await this.verifiedKeptCurrent(tx, await readPrecommit()); }
      catch (error) { if (error.keptCurrentFailure) return hold(error); throw error; }
    }
    await this.vault.contained(path.dirname(file));
    const existing = await this.ownedFile(file, stage, 'Annotation destination');
    if (existing && !intent.annotationProof) {
      throw Error('The published repair annotation has no recorded identity. Recovery files were preserved.');
    }
    if (!existing) {
      assertAnnotationPublication(await annotationAuthority(this), intent.annotationId);
      guardPrecommit();
      verifyConflict?.();
      verifyStageSync(intentFile, guard, intentProof);
      if (!intent.annotationProof) {
        verifyAbsentSync(file, guard);
        const proof = await writeStage(stage, intent.annotation, guard);
        await recordIntentProof('annotationProof', proof, () => {
          verifyAbsentSync(file, guard);
          verifyStageSync(stage, guard, proof);
        });
      }
      guardPrecommit();
      verifyConflict?.();
      verifyStageSync(intentFile, guard, intentProof);
      verifyAbsentSync(intentStage, guard);
      verifyAbsentSync(archivedIntent, guard);
      verifyStageSync(stage, guard, intent.annotationProof);
      verifyAbsentSync(file, guard);
      native.linkSync(stage, file);
    }
    verifyAnnotationForSource();
    await this.vault.checkpoint('repair-annotation-published');
    assertAnnotationPublication(await annotationAuthority(this), intent.annotationId);
    const ledger = await readPrecommit();
    if (!admitted(ledger)) {
      verifyAnnotationForSource();
      if (freshRepair) expectedJournal.verify();
      else if (tx.keptCurrent) linkPinnedRepairSource(verifyAnnotationForSource);
      else if (await read(journal) === null) await this.publishJournal(journal, tx);
      else if (await read(journal) !== JSON.stringify(tx)) throw Error('Another source publication needs recovery before this repair.');
      if (!freshRepair && tx.keptCurrent) {
        const candidate = this.ordinaryRecoveryJournal(ledger);
        if (!candidate?.freshRepair) throw Error('The active repair journal has no exact publication proof. Recovery files were preserved.');
        selectFreshRepair(candidate);
      }
      const clearConflict = () => {
        delete ledger.blocks[tx.sourceHash];
        if (ledger.captures[tx.sourceHash]) delete ledger.captures[tx.sourceHash].conflict;
      };
      const transfer = freshRepair ? undefined : { verify: verifyAnnotationForSource, previous: intent.localProof };
      try { await this.finish(tx, ledger, freshRepair && expectedJournal, transfer); } catch (error) {
        if (error.keptCurrentFailure) return hold(error);
        if (error.intakeOutputHeld) return preserveOutputHold(await annotationAuthority(this), error);
        if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message,
          freshRepair ? { expectedJournal, ...error.intakeConflictProof } : error.intakeConflictProof);
        else if (error.intakeDeferred) {
          clearConflict();
          await this.defer(tx, ledger, error.message, freshRepair && expectedJournal);
        }
        else throw error;
        await retireRepair();
        throw Object.assign(Error('Annotation preserved. Incoming publication remains paused for repair.'), { intakeRepairHeld: !!freshRepair });
      }
    }
    await retireRepair();
  };
}
module.exports = { install, sourceLink };
