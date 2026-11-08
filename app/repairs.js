const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const YAML = require('yaml');

const urlPath = relative => relative.split(path.sep).map(encodeURIComponent).join('/');
const sourceLink = (content, relative) => content.replace(/^Source: \[Capture\]\([^\r\n]*\)$/m, 'Source: [Capture](' + urlPath(relative) + ')');
function install(Intake, { hash, read, noteText }) {
  Intake.prototype.syncMoves = async function () {
    const notes = await this.vault.scan(), ledger = await this.load();
    ledger.identityIssues = {}; ledger.identityChoices ||= {}; this.vault.identityPaths = new Map();
    const groups = new Map(); for (const note of notes) { if (!groups.has(note.id)) groups.set(note.id, []); groups.get(note.id).push(note); }
    for (const [id, matches] of groups) if (matches.length > 1) {
      const files = matches.map(note => ({ file: path.relative(this.vault.vault, note.file), hash: hash(note.content) })).sort((a, b) => a.file.localeCompare(b.file));
      const choice = ledger.identityChoices[id], copies = choice && files.filter(item => item.file !== choice.file);
      if (choice && files.some(item => item.file === choice.file) && JSON.stringify(copies) === JSON.stringify(choice.copies)) this.vault.identityPaths.set(id, path.join(this.vault.vault, choice.file));
      else { ledger.identityIssues[id] = { kind: 'duplicate', id, reason: 'Duplicate identity. Both files are preserved; choose the managed file explicitly. Other copies remain excluded while their bytes are unchanged.', files, token: hash(JSON.stringify(files)) }; this.vault.identityPaths.set(id, null); }
    }
    for (const capture of Object.values(ledger.captures)) {
      if (capture.removed) continue;
      if (ledger.identityIssues[capture.id]) { capture.identityIssue = ledger.identityIssues[capture.id].reason; continue; }
      delete capture.identityIssue;
      const matches = notes.filter(note => note.id === capture.id && (!this.vault.identityPaths.has(capture.id) || note.file === this.vault.identityPaths.get(capture.id)));
      if (!matches.length) {
        capture.identityIssue = 'Missing managed note. Updates are paused until explicit restore or confirmed removal from active intake.';
        ledger.identityIssues[capture.id] = { kind: 'missing', id: capture.id, sourceHash: Object.keys(ledger.captures).find(key => ledger.captures[key] === capture), reason: capture.identityIssue, token: hash(JSON.stringify([capture.id, capture.currentRevision, capture.currentHash, capture.relative || capture.file])) };
        continue;
      }
      if (matches.length !== 1) continue;
      const note = matches[0]; await this.ownedFile(note.file, [], 'Moved capture');
      capture.relative = path.relative(this.vault.vault, note.file);
      for (const annotation of await this.annotations(capture.id)) {
        const relative = path.relative(path.dirname(annotation.file), note.file), content = sourceLink(annotation.content, relative);
        if (content === annotation.content) continue;
        const id = randomUUID();
        await this.publishJournal(path.join(this.dir, 'link-intent.json'), { schema: 1, id, file: path.relative(this.vault.vault, annotation.file), before: annotation.content, content, relative });
        await this.finishLink();
      }
    }
    await this.save(ledger);
  };
  Intake.prototype.restoreMissing = async function ({ id, token }, now) {
    return this.locked(async () => {
      await this.syncMoves(); const ledger = await this.load(), issue = ledger.identityIssues[id];
      if (issue?.kind !== 'missing' || issue.token !== token) throw Error('Missing-note state changed. Refresh before restoring.');
      const previous = ledger.captures[issue.sourceHash], bytes = await read(path.join(this.vault.root, 'Revisions', previous.currentRevision + '.json'));
      const known = Object.values(ledger.attempts).find(item => item.revision === previous.currentRevision);
      if (bytes === null || !known || hash(bytes) !== known.snapshotHash) throw Error('The last managed revision is unavailable or changed. Restore a vault backup; no note was recreated.');
      const revision = JSON.parse(bytes), capture = { ...previous, restoredAt: now }; delete capture.identityIssue;
      const content = noteText(capture, revision); capture.currentHash = hash(content);
      const resolution = randomUUID(), tx = { schema: 1, restore: true, resolution, key: ledger.sources[0].id + ':restore-' + id, sourceHash: issue.sourceHash, capture, revision, content, previousHash: null, previous: null, backup: id + '-' + revision.id + '.before-' + resolution + '.md' };
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
      if (!issue || issue.token !== token || !issue.files.some(item => item.file === file)) throw Error('Identity copies changed. Refresh and inspect all copies before choosing.');
      const selected = this.destination({ relative: file }); await this.ownedFile(selected, [], 'Selected identity file');
      ledger.identityChoices[id] = { file, copies: issue.files.filter(item => item.file !== file) };
      await this.save(ledger); await this.syncMoves();
    });
  };
  Intake.prototype.finishLink = async function () {
    const journal = path.join(this.dir, 'link-intent.json'), bytes = await read(journal); if (bytes === null) return;
    const intent = JSON.parse(bytes), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if (intent.schema !== 1 || !uuid.test(intent.id) || typeof intent.before !== 'string' || typeof intent.content !== 'string' || typeof intent.relative !== 'string' || intent.content !== sourceLink(intent.before, intent.relative)) throw Error('Invalid relationship repair journal. Files were preserved.');
    const file = this.destination({ relative: intent.file }), backup = path.join(this.dir, 'link-' + intent.id + '.before.md'), stage = path.join(this.dir, 'link-' + intent.id + '.stage');
    await this.vault.contained(path.dirname(file)); await this.ownedFile(file, [backup, stage], 'Annotation relationship'); await this.ownedFile(backup, file, 'Annotation relationship backup');
    let current = await read(file), before = await read(backup);
    if (current !== intent.content) {
      if (before === null) {
        if (current !== intent.before) throw Error('Annotation changed during move repair. Its writing was preserved.');
        await fs.rename(file, backup); before = await read(backup); current = await read(file);
      }
      if (before !== intent.before) { if (current === null) await fs.link(backup, file).catch(() => {}); throw Error('Annotation changed during relationship repair. Both versions were preserved.'); }
      if (current !== null) throw Error('Annotation destination was recreated during relationship repair. Both files were preserved.');
      await this.ownedFile(stage, file, 'Annotation relationship stage');
      try { await fs.writeFile(stage, intent.content, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST' || await read(stage) !== intent.content) throw Error('Relationship staging conflict. Files were preserved.'); }
      await this.ownedFile(stage, file, 'Annotation relationship stage'); await fs.link(stage, file);
    }
    await this.ownedFile(file, stage, 'Annotation relationship');
    if (await read(file) !== intent.content || await read(backup) !== intent.before) throw Error('Annotation relationship changed during publication. Files were preserved.');
    await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; }); await fs.unlink(journal);
  };
  Intake.prototype.annotations = async function (captureId) {
    const folder = path.join(this.vault.root, 'Annotations'); await this.vault.contained(folder);
    const notes = [];
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(folder, entry.name); await this.ownedFile(file, [], 'Annotation');
      const content = await read(file), match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      let metadata; try { metadata = match && YAML.parse(match[1]); } catch { continue; }
      if (metadata?.artifact_type === 'annotation' && metadata.capture_id === captureId) notes.push({ id: metadata.companion_id, file, content });
    }
    return notes;
  };
  const inspect = Intake.prototype.inspect;
  Intake.prototype.inspect = async function (id) { const info = await inspect.call(this, id); return { ...info, annotations: await this.annotations(id) }; };
  Intake.prototype.addAnnotation = async function ({ id, captureId, text }, now) {
    return this.locked(async () => {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || typeof text !== 'string' || !text.trim()) throw Error('Enter annotation text before saving.');
      const ledger = await this.load(), capture = Object.values(ledger.captures).find(x => x.id === captureId);
      if (!capture) throw Error('Choose an imported capture before adding an annotation.');
      const annotation = '---\ncompanion_id: ' + JSON.stringify(id) + '\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ' + JSON.stringify(captureId) + '\ncreated_at: ' + JSON.stringify(now) + '\n---\n\n# Annotation\n\nSource: [Capture](' + urlPath(path.relative(path.join(this.vault.root, 'Annotations'), this.destination(capture))) + ')\n\n' + text + '\n';
      await this.publishJournal(path.join(this.dir, 'annotation-intent.json'), { schema: 1, id, captureId, annotation });
      await this.finishAnnotation();
    });
  };
  Intake.prototype.finishAnnotation = async function () {
    const journal = path.join(this.dir, 'annotation-intent.json'), bytes = await read(journal); if (bytes === null) return;
    const intent = JSON.parse(bytes), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
    if (intent.schema !== 1 || !uuid.test(intent.id) || !uuid.test(intent.captureId) || typeof intent.annotation !== 'string' || !intent.annotation.includes('capture_id: ' + JSON.stringify(intent.captureId) + '\n')) throw Error('Invalid annotation save intent. Preserve .intake for repair.');
    const file = path.join(this.vault.root, 'Annotations', intent.id + '.md'), stage = path.join(this.dir, 'annotation-' + intent.id + '.stage');
    await this.vault.contained(path.dirname(file)); await this.ownedFile(stage, file, 'Annotation staging file');
    try { await fs.writeFile(stage, intent.annotation, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST' || await read(stage) !== intent.annotation) throw Error('Annotation staging conflict. Both files were preserved.'); }
    await this.ownedFile(stage, file, 'Annotation staging file'); await this.ownedFile(file, stage, 'Annotation destination');
    try { await fs.link(stage, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await this.ownedFile(file, stage, 'Annotation destination');
    if (await read(file) !== intent.annotation) throw Error('Annotation destination changed. Both files were preserved.');
    await this.vault.checkpoint('annotation-published');
    await fs.unlink(stage); await fs.unlink(journal);
  };
  Intake.prototype.repairs = async function () {
    return this.locked(async () => {
      await this.syncMoves();
      const ledger = await this.load(), items = Object.values(ledger.identityIssues || {});
      for (const [sourceHash, block] of Object.entries(ledger.blocks)) {
        if (!/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) continue;
        const tx = JSON.parse(await read(path.join(this.dir, block.journal))); this.validateTransaction(tx);
        const current = ledger.captures[sourceHash];
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
      await this.syncMoves();
      const ledger = await this.load(), block = ledger.blocks[sourceHash];
      if (!block || !/^conflict-[a-f0-9-]{36}(?:-[a-f0-9-]{36})?\.json$/.test(block.journal)) throw Error('This source has no resolvable incoming conflict.');
      const tx = JSON.parse(await read(path.join(this.dir, block.journal))); this.validateTransaction(tx);
      const current = ledger.captures[sourceHash];
      if (!current || current.id !== tx.capture.id || tx.sourceHash !== sourceHash || current.identityIssue || current.removed || ledger.suppressed.includes(sourceHash)) throw Error('Resolve the current capture identity or missing-note state before transferring local writing.');
      const note = await this.vault.find(current.id), file = this.destination(current);
      if (note.file !== file || note.type !== 'reel_import') throw Error('The managed capture identity changed. Refresh before resolving.');
      await this.ownedFile(file, [], 'Local capture'); const local = note.content;
      if (local === null || hash(local) !== localHash) throw Error('Local writing changed. Refresh and inspect it before resolving.');
      const capture = { ...tx.capture, id: current.id, file: current.file, relative: current.relative, capturedAt: current.capturedAt, title: note.title, revisions: [...new Set([...current.revisions, tx.revision.id])] };
      delete capture.conflict; delete capture.identityIssue;
      const content = noteText(capture, tx.revision); capture.currentHash = hash(content);
      const id = randomUUID(), annotation = `---\ncompanion_id: ${JSON.stringify(id)}\nartifact_type: "annotation"\nschema_version: 1\ncapture_id: ${JSON.stringify(tx.capture.id)}\ncreated_at: ${JSON.stringify(now)}\n---\n\n# Annotation\n\nSource: [Capture](${urlPath(path.relative(path.join(this.vault.root, 'Annotations'), this.destination(capture)))})\n\n${text}\n`;
      const intent = { schema: 1, sourceHash, localHash, annotationId: id, annotation, tx: { ...tx, capture, content, previous: local, previousHash: localHash, externalConflict: false, resolution: id, backup: `${tx.capture.id}-${tx.revision.id}.before-${id}.md` } };
      await this.publishJournal(path.join(this.dir, 'repair-intent.json'), intent);
      await this.finishRepair();
    });
  };
  Intake.prototype.finishRepair = async function () {
    const intentFile = path.join(this.dir, 'repair-intent.json'), bytes = await read(intentFile); if (bytes === null) return;
    const intent = JSON.parse(bytes), tx = intent.tx;
    this.validateTransaction(tx);
    if (intent.schema !== 1 || intent.sourceHash !== tx.sourceHash || intent.localHash !== tx.previousHash || intent.annotationId !== tx.resolution || typeof intent.annotation !== 'string' || !intent.annotation.includes(`capture_id: ${JSON.stringify(tx.capture.id)}\n`)) throw Error('Invalid annotation repair intent. Preserve .intake for repair.');
    const file = path.join(this.vault.root, 'Annotations', `${intent.annotationId}.md`), stage = path.join(this.dir, `annotation-${intent.annotationId}.stage`);
    await this.vault.contained(path.dirname(file));
    const existing = await this.ownedFile(file, stage, 'Annotation destination');
    if (!existing) {
      await this.ownedFile(stage, file, 'Annotation staging file');
      try { await fs.writeFile(stage, intent.annotation, { flag: 'wx', flush: true }); } catch (error) { if (error.code !== 'EEXIST' || await read(stage) !== intent.annotation) throw Error('Annotation staging conflict. Both files were preserved.'); }
      await this.ownedFile(stage, file, 'Annotation staging file');
      try { await fs.link(stage, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await this.ownedFile(file, stage, 'Annotation destination');
    if (await read(file) !== intent.annotation) throw Error('Annotation changed. Incoming source remains paused; preserve both versions.');
    await this.vault.checkpoint('repair-annotation-published');
    const ledger = await this.load();
    if (!ledger.attempts[tx.revision.identity] || ledger.captures[tx.sourceHash]?.currentRevision !== tx.revision.id) {
      const journal = path.join(this.dir, 'transaction.json');
      if (await read(journal) === null) await this.publishJournal(journal, tx);
      else if (await read(journal) !== JSON.stringify(tx)) throw Error('Another source publication needs recovery before this repair.');
      delete ledger.blocks[tx.sourceHash]; if (ledger.captures[tx.sourceHash]) delete ledger.captures[tx.sourceHash].conflict;
      await this.save(ledger);
      try { await this.finish(tx, ledger); } catch (error) {
        if (error.intakeConflict) await this.archiveConflict(tx, ledger, error.message);
        else if (error.intakeDeferred) await this.defer(tx, ledger, error.message);
        else throw error;
        await fs.unlink(stage).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
        await fs.unlink(intentFile);
        throw Error('Annotation preserved. Incoming publication remains paused for repair.');
      }
    }
    await fs.unlink(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(intentFile);
  };
}
module.exports = { install };
