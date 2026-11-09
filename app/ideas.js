const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { createHash, randomUUID } = require('node:crypto');
const { Briefs } = require('./briefs');
const { withBriefMutation } = require('./briefs-lock');
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function metadata(text) {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return front && YAML.parse(front[1]);
}
class Ideas {
  constructor({ getVault, conversations, clock, open }) {
    Object.assign(this, { getVault, conversations, clock, open });
    this.previews = new Map(); this.roots = new Map();
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
      if (create && area === '.ideas') { try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      if (area === '.ideas' && !create && !local.existsSync(directory)) continue;
      identities.set(directory, check(directory, expected?.get(directory)));
    }
    return identities;
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
    for (const name of await fs.readdir(path.join(vault.root, 'Ideas'))) {
      if (!name.endsWith('.md')) continue;
      try {
        const file = path.join(vault.root, 'Ideas', name), { text } = await this.readFile(vault, file, parents);
        const data = metadata(text);
        if (data?.artifact_type === 'saved_idea' && data.schema_version === 1 && uuid(data.companion_id)) notes.push({ id: data.companion_id, title: data.title, file });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const counts = new Map(); for (const note of notes) counts.set(note.id, (counts.get(note.id) || 0) + 1);
    return notes.map(note => ({ ...note, unavailable: counts.get(note.id) !== 1 }));
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
    const { request } = await this.origin(input);
    return { ...input, explanation: request.reply, limitations: 'This is an interpretation, not a verified outcome. Supporting sentence citations have not been established.' };
  }
  async preview(input) {
    const { vault, record, request } = await this.origin(input);
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
    // An unchanged proposal keeps the same immutable identity and creation instant
    // when the user cancels and reviews it again. Confirmation never regenerates it.
    const proposalKey = hash(JSON.stringify({ vault: vault.root, conversation: record.id, request: request.id, package: request.package, reply: request.reply, status: request.status, brief: record.brief, title: input.title, explanation: input.explanation, limitations: input.limitations, kind, experiment }));
    const retained = [...this.previews.values()].find(preview => preview.proposalKey === proposalKey);
    if (retained) {
      this.guard(vault);
      return { operation: retained.operation, text: retained.text, destination: retained.destination, warnings: [...retained.warnings] };
    }
    const dependencies = request.package.dependencies.filter(dep => dep.key.startsWith('capture:')).map(dep => ({ capture_id: dep.captureId || dep.key.slice(8), ...(dep.revisionId ? { revision_id: dep.revisionId } : { content_sha256: dep.digest }) }));
    const unsupported = request.package.dependencies.some(dep => !dep.key.startsWith('capture:') && !dep.key.startsWith('brief:'));
    const id = randomUUID(), operation = randomUUID();
    const fields = { artifact_type: 'saved_idea', schema_version: 1, companion_id: id, title: input.title.trim(), created_at: this.clock().now, idea_kind: kind, ...(kind === 'experiment_proposal' ? { experiment } : {}), source_dependencies: dependencies, project_brief_version: record.brief.version, project_brief: record.brief, support_attribution_unavailable: unsupported, citations: [], origin: { conversation_id: record.id, request_id: request.id, package_sha256: request.package.digest, reply_sha256: hash(request.reply), status: request.status } };
    const disclosure = 'Supporting references: no sentence-level citations were selected or validated. Context dependencies record provenance and revocation only; they do not prove that the explanation is supported.';
    const experimentText = kind === 'experiment_proposal' ? `\n# Experiment Proposal\n\n${Object.entries(experimentLabels).map(([key, label]) => `## ${label}\n\n${experiment[key]}`).join('\n\n')}\n` : '';
    const text = `---\n${YAML.stringify(fields)}---\n\n# ${fields.title}\n\n## Explanation\n\n${input.explanation}\n\n## Limitations\n\n${input.limitations}\n${experimentText}\n## Supporting references\n\n${disclosure}\n\nExact project brief: ${record.brief.id}, version ${record.brief.version}, sha256 ${record.brief.digest}.\n\n${dependencies.map(dep => `Capture ${dep.capture_id}; ${dep.revision_id ? `exact revision ${dep.revision_id}` : `content sha256 ${dep.content_sha256}`}; context dependency only.`).join('\n')}\n\nConversation output status: ${request.status}. Interpretation is not an executed experiment or a verified result.\n`;
    const slug = fields.title.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 55) || 'Idea';
    const destination = path.join(vault.root, 'Ideas', `${slug}--${id}.md`);
    this.guard(vault);
    const preview = { schema: 1, operation, id, vault: vault.root, destination, text, digest: hash(text), proposalKey, warnings: [disclosure] };
    if (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(operation, preview);
    return { operation, text, destination, warnings: [disclosure] };
  }
  async confirm({ operation }) {
    const preview = this.previews.get(operation), vault = this.getVault();
    if (!preview || !vault || preview.vault !== vault.root) throw Error('Preview the saved idea again before confirmation.');
    const parents = this.guard(vault, undefined, true), directory = path.join(vault.root, '.ideas');
    return withBriefMutation(directory, async () => {
      this.guard(vault, parents);
      const intent = path.join(directory, `${operation}.intent.json`), stage = path.join(directory, `${operation}.md.pending`), receipt = path.join(directory, `${operation}.published.json`);
      const exclusive = async (file, text) => { this.guard(vault, parents); await fs.writeFile(file, text, { flag: 'wx', flush: true, encoding: 'utf8' }); this.guard(vault, parents); };
      try { await exclusive(intent, JSON.stringify(preview, null, 2)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; if ((await this.readFile(vault, intent, parents)).text !== JSON.stringify(preview, null, 2)) throw Error('Saved idea intent conflict. The proposal was preserved.'); }
      let prior;
      try { prior = JSON.parse((await this.readFile(vault, receipt, parents)).text); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (prior) {
        let current;
        try { current = await this.readFile(vault, preview.destination, parents); }
        catch { throw Error('The saved idea is unavailable or changed. The completed operation will not create another note.'); }
        if (current.text !== preview.text || current.stat.ino.toString() !== prior.ino || current.stat.dev.toString() !== prior.dev) throw Error('The saved idea was edited or replaced. Existing content was preserved.');
        return { id: preview.id, destination: preview.destination };
      }
      try { await exclusive(stage, preview.text); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const links = local.lstatSync(stage).nlink;
      if (![1, 2].includes(links)) throw Error('Saved idea stage has unexpected linked copies. Preserve it for inspection.');
      const staged = await this.readFile(vault, stage, parents, links);
      if (staged.text !== preview.text) throw Error('Saved idea stage conflict. The proposal was preserved.');
      this.guard(vault, parents);
      try { await fs.link(stage, preview.destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const current = await this.readFile(vault, preview.destination, parents, 2);
        if (!same(staged.stat, current.stat) || current.text !== preview.text) throw Error('Saved idea destination exists. Existing content was preserved.');
      }
      this.guard(vault, parents);
      const published = await this.readFile(vault, preview.destination, parents, 2);
      if (!same(staged.stat, published.stat) || published.text !== preview.text) throw Error('Saved idea changed during publication. Preserve the proposal and inspect the note.');
      await exclusive(receipt, JSON.stringify({ schema: 1, operation, id: preview.id, digest: preview.digest, dev: published.stat.dev.toString(), ino: published.stat.ino.toString() }));
      this.guard(vault, parents); await fs.unlink(stage);
      return { id: preview.id, destination: preview.destination };
    });
  }
  async openNote(id) {
    if (!uuid(id)) throw Error('Saved idea identity is invalid.');
    const matches = (await this.list()).filter(note => note.id === id);
    if (matches.length !== 1 || matches[0].unavailable) throw Error('Saved idea is missing or has duplicate identities. Preserve the notes and resolve them before opening.');
    await this.open(`obsidian://open?path=${encodeURIComponent(matches[0].file)}`);
  }
}
function installIdeas({ ipcMain, ...options }) {
  const store = new Ideas(options);
  ipcMain.handle('idea-draft', (_, input) => store.draft(input));
  ipcMain.handle('idea-preview', (_, input) => store.preview(input));
  ipcMain.handle('idea-confirm', (_, input) => store.confirm(input));
  ipcMain.handle('idea-list', () => store.list());
  ipcMain.handle('idea-open', (_, id) => store.openNote(id));
  return store;
}
module.exports = { installIdeas };
