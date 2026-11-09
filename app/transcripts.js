const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash, randomUUID } = require('node:crypto');
const { withBriefMutation } = require('./briefs-lock');
const hash = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const literal = text => {
  let length = 3; for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length); return `${fence}text\n${text}\n${fence}`;
};

class Transcripts {
  constructor({ conversations, getVault, getContext, clock, checkpoint, choose }) {
    Object.assign(this, { conversations, getVault, getContext, clock, checkpoint, choose });
    this.previews = new Map(); this.roots = new Map();
  }
  guard(vault, destination, expected, create = false) {
    const root = path.resolve(vault.vault), directory = path.join(vault.root, '.transcripts');
    const relative = path.relative(root, destination);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..') || path.extname(destination).toLowerCase() !== '.md') throw Error('Choose a Markdown destination inside the selected vault.');
    const managed = path.relative(vault.root, destination).split(path.sep);
    if (!managed.includes('..') && managed.some(segment => segment.startsWith('.'))) throw Error('Choose a readable vault destination outside private application folders.');
    const identities = new Map();
    const check = (file, identity) => {
      const stat = local.lstatSync(file, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || local.realpathSync(file) !== file || identity && !same(stat, identity)) throw Error('Transcript folders must be ordinary contained vault folders. Restore the folders before retrying.');
      identities.set(file, stat); return stat;
    };
    const anchor = check(root, this.roots.get(root)); this.roots.set(root, anchor);
    for (const parent of [vault.root, path.dirname(destination)]) {
      const parts = path.relative(root, parent).split(path.sep).filter(Boolean);
      if (parts.includes('..') || path.isAbsolute(path.relative(root, parent))) throw Error('Transcript folder is outside the selected vault.');
      let current = root;
      for (const part of parts) { current = path.join(current, part); check(current, expected?.get(current)); }
    }
    if (create) { try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    if (local.existsSync(directory)) check(directory, expected?.get(directory));
    for (const [file, identity] of expected || []) check(file, identity);
    return identities;
  }
  async read(vault, destination, file, parents, links = 1) {
    this.guard(vault, destination, parents);
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(links)) throw Error('Transcript publication contains a linked or nonordinary file. Preserve it for review.');
    const handle = await fs.open(file, 'r');
    try {
      if (!same(before, await handle.stat({ bigint: true }))) throw Error('Transcript file identity changed. Preserve it for review.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
      this.guard(vault, destination, parents);
      const after = await fs.lstat(file, { bigint: true });
      if (!same(before, after) || after.nlink !== BigInt(links)) throw Error('Transcript file identity changed. Preserve it for review.');
      return { text, stat: after };
    } finally { await handle.close(); }
  }
  async snapshot(id) {
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    if (this.conversations.unsaved.has(id)) throw Error('Preserve or copy the unsaved conversation before exporting its retained history.');
    const { record, text } = await this.conversations.readStored(id, true);
    if (record.vault?.root !== vault.root) throw Error('Conversation belongs to another vault.');
    const warnings = [], dependencies = [], origins = new Map();
    let all = [], contextError;
    try { all = (await (await this.getContext()).corpus()).all; }
    catch (error) { contextError = error.message; warnings.push(`Current support unavailable: ${contextError}`); }
    const scope = record.scope || { excludedSources: [], excludedHistory: [] };
    const resolve = this.conversations.historyResolver({ all, vault, active: record, excludedSources: new Set(scope.excludedSources), excludedHistory: new Set(scope.excludedHistory) });
    for (const request of record.requests) {
      for (const dep of request.package?.dependencies || []) dependencies.push({ requestId: request.id, original: dep, currentDigest: all.find(source => source.key === dep.key)?.digest || null });
      for (const ref of request.package?.historyRefs || []) if (typeof ref.conversationId === 'string' && !origins.has(ref.conversationId)) {
        try { origins.set(ref.conversationId, hash((await this.conversations.readStored(ref.conversationId, true)).text)); }
        catch { origins.set(ref.conversationId, null); }
      }
      try { await resolve(record.id, request.id); }
      catch (error) { warnings.push(`Request ${request.id}: ${error.message}. This is retained historical writing, not current evidence.`); }
      for (const message of request.messages || []) if (!['commentary', 'final_answer'].includes(message.phase)) warnings.push(`Request ${request.id}, assistant item ${message.id}: unknown phase; retained without guessing.`);
      if (!(request.messages || []).length && request.reply) warnings.push(`Request ${request.id}: assistant item phases are unavailable; the retained reply is shown without invented phases.`);
    }
    return { record, digest: hash(text), warnings, state: { digest: hash(text), warnings, dependencies, origins: [...origins], contextError: contextError || null } };
  }
  markdown(snapshot, id, createdAt) {
    const { record, warnings } = snapshot;
    const metadata = {
      artifact_type: 'conversation_transcript', schema_version: 1, companion_id: id, created_at: createdAt,
      conversation_id: record.id, conversation_sha256: snapshot.digest, project_brief: record.brief,
      requests: record.requests.map(request => ({ request_id: request.id, status: request.status, package_sha256: request.package?.digest || null, source_dependencies: request.package?.dependencies || null, historical_refs: request.package?.historyRefs || [], historical_request_ids: request.package?.historyIds || null })),
      warnings
    };
    const turns = record.requests.map(request => {
      const messages = Array.isArray(request.messages) && request.messages.length
        ? request.messages.map(message => `### Assistant item ${message.id} · phase: ${message.phase || 'unknown phase'} · ${message.completed ? 'completed' : 'incomplete'}\n\n${literal(message.text || '')}`).join('\n\n')
        : `### Assistant reply · phase unavailable\n\n${literal(request.reply || '(No retained assistant reply.)')}`;
      return `## Request ${request.id} · ${request.status}${request.status === 'completed' ? '' : ' · incomplete'}\n\nStarted: ${request.startedAt || 'unknown'}; completed: ${request.completedAt || 'unavailable'}.${request.error ? `\n\nRetained error: ${request.error}` : ''}\n\n### User\n\n${literal(request.question || '')}\n\n${messages}\n\n### Approved outgoing context · historical copy\n\n${literal(request.package?.text || 'Context unavailable; dependency attribution is unknown.')}`;
    }).join('\n\n');
    return `---\n${YAML.stringify(metadata)}---\n\n# Conversation transcript\n\nConversation ${record.id}; approved brief ${record.brief.id}, version ${record.brief.version}, sha256 ${record.brief.digest}.\n\nThis is a readable historical copy, separate from the local history archive and current supporting evidence. Source exclusion changes future context. Local conversation deletion does not delete independent saved writing, separate exports or backups. Independent copies and quotations may remain. Previous provider submissions are not erased by local deletion. History has no automatic expiry.\n\n## Current support and completeness warnings\n\n${warnings.length ? warnings.map(warning => `- ${warning}`).join('\n') : 'No currently detected support warnings. This does not independently verify the dialogue.'}\n\n${turns}\n`;
  }
  async preview({ conversationId }) {
    const vault = this.getVault(); if (!vault) throw Error('Choose a vault first.');
    const destination = await this.choose(vault);
    if (!destination) return { canceled: true };
    const file = path.resolve(destination), parents = this.guard(vault, file);
    const snapshot = await this.snapshot(conversationId);
    if (await fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw Error('Transcript destination already exists. Choose a new filename; existing writing was preserved.');
    this.guard(vault, file, parents);
    const id = randomUUID(), operation = randomUUID(), createdAt = this.clock().now;
    const text = this.markdown(snapshot, id, createdAt);
    const intent = { schema: 1, operation, id, vault: { vault: vault.vault, root: vault.root }, conversationId, recordDigest: snapshot.digest, destination: file, text, digest: hash(text), reviewState: snapshot.state, createdAt };
    const token = randomUUID(); if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(token, { intent, parents });
    return { token, text, destination: file, warnings: snapshot.warnings };
  }
  cancel(token) { this.previews.delete(token); }
  async confirm(token) {
    const preview = this.previews.get(token); if (!preview) throw Error('Preview the transcript again before exporting.');
    const { intent } = preview, vault = this.getVault();
    if (!vault || vault.vault !== intent.vault.vault || vault.root !== intent.vault.root) throw Error('Selected vault changed. Preview the transcript again.');
    // Lock order: conversation store, then transcript journal. Never acquire these in reverse.
    return this.conversations.lock(async () => {
      const parents = this.guard(vault, intent.destination, preview.parents, true), directory = path.join(vault.root, '.transcripts');
      return withBriefMutation(directory, async () => {
        this.guard(vault, intent.destination, parents);
        const base = path.join(directory, intent.operation), journal = `${base}.intent.json`, stage = `${base}.md.pending`, receipt = `${base}.published.json`;
        const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        const exactIntent = async () => {
          if (await exists(journal)) {
            if ((await this.read(vault, intent.destination, journal, parents)).text !== JSON.stringify(intent, null, 2)) throw Error('Transcript intent changed. Preserve the proposed writing for review.');
          } else { this.guard(vault, intent.destination, parents); await fs.writeFile(journal, JSON.stringify(intent, null, 2), { flag: 'wx', flush: true }); this.guard(vault, intent.destination, parents); }
        };
        const pair = async () => {
          const a = await this.read(vault, intent.destination, stage, parents, 2), b = await this.read(vault, intent.destination, intent.destination, parents, 2);
          if (!same(a.stat, b.stat) || a.text !== intent.text || b.text !== intent.text) throw Error('Transcript publication peers changed. Preserve both files for review.');
          return a.stat;
        };
        if (await exists(receipt)) {
          const saved = JSON.parse((await this.read(vault, intent.destination, receipt, parents)).text);
          if (saved.schema !== 1 || saved.operation !== intent.operation || saved.id !== intent.id || saved.digest !== intent.digest) throw Error('Transcript publication receipt changed. Preserve files for review.');
          if (await exists(stage)) {
            const stat = await pair();
            if (String(stat.dev) !== saved.dev || String(stat.ino) !== saved.ino) throw Error('Transcript publication identity changed. Preserve files for review.');
            this.guard(vault, intent.destination, parents); await fs.unlink(stage);
          }
          this.previews.delete(token); return { destination: intent.destination, completed: true };
        }
        let published = await exists(stage) && await exists(intent.destination);
        if (published) { await exactIntent(); await pair(); }
        else {
          const fresh = await this.snapshot(intent.conversationId);
          if (fresh.digest !== intent.recordDigest || JSON.stringify(fresh.state) !== JSON.stringify(intent.reviewState)) throw Error('Conversation or support warnings changed. Preview the transcript again before new publication.');
          if (await exists(intent.destination)) throw Error('Transcript destination already exists. Existing writing was preserved.');
          await exactIntent();
          if (await exists(stage)) {
            if ((await this.read(vault, intent.destination, stage, parents)).text !== intent.text) throw Error('Transcript stage changed. Preserve it for review.');
          } else { this.guard(vault, intent.destination, parents); await fs.writeFile(stage, intent.text, { flag: 'wx', flush: true }); }
          await this.checkpoint('transcript-before-publish');
          const current = await this.snapshot(intent.conversationId);
          if (JSON.stringify(current.state) !== JSON.stringify(intent.reviewState)) throw Error('Conversation or support warnings changed. Preview the transcript again before new publication.');
          if ((await this.read(vault, intent.destination, stage, parents)).text !== intent.text) throw Error('Transcript stage changed. Preserve it for review.');
          this.guard(vault, intent.destination, parents); await fs.link(stage, intent.destination); published = true;
          await this.checkpoint('transcript-after-link');
        }
        const stat = await pair();
        this.guard(vault, intent.destination, parents);
        await fs.writeFile(receipt, JSON.stringify({ schema: 1, operation: intent.operation, id: intent.id, digest: intent.digest, dev: String(stat.dev), ino: String(stat.ino) }, null, 2), { flag: 'wx', flush: true });
        await this.checkpoint('transcript-after-receipt');
        await pair(); this.guard(vault, intent.destination, parents); await fs.unlink(stage);
        this.previews.delete(token); return { destination: intent.destination, completed: published };
      });
    });
  }
}

function installTranscripts({ ipcMain, ...options }) {
  const store = new Transcripts(options);
  ipcMain.handle('transcript-preview', (_, input) => store.preview(input));
  ipcMain.handle('transcript-confirm', (_, input) => store.confirm(input?.token));
  ipcMain.handle('transcript-cancel', (_, input) => store.cancel(input?.token));
  return store;
}
module.exports = { Transcripts, installTranscripts };
