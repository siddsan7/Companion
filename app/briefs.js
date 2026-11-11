const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const YAML = require('yaml');
const { withBriefMutation } = require('./briefs-lock');
const { ordinaryDirectories, writeStage, verifyStage, verifyStageSync, verifyPeers, removeStage } = require('./staged-publication');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceByteLimit = 128000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const titles = ['Project purpose', 'Current behavior', 'Constraints', 'Known limitations', 'Questions worth exploring'];
function extract(sources) {
  const patterns = [/^#\s+[^#]|purpose|overview/i, /behavior|features|journey/i, /constraints|setup|security|requirements/i, /limitations|remaining|scope/i, /questions|explor/i];
  return titles.map((title, section) => {
    const passages = [];
    sources.forEach((source, index) => {
      const lines = source.text.split(/\r?\n/); let heading = '', start = 0;
      const flush = end => {
        let first = start, last = end; while (first < last && !lines[first].trim()) first++; while (last > first && !lines[last - 1].trim()) last--;
        const text = lines.slice(first, last).join('\n');
        if (text && patterns[section].test(heading)) passages.push({ source: index, start: first + 1, end: last, text });
      };
      lines.forEach((line, i) => { if (/^#{1,6} /.test(line)) { flush(i); heading = line; start = i + 1; } }); flush(lines.length);
    });
    return { title, text: passages.length ? passages.map(p => p.text).join('\n\n') : 'Gap: No passage selected for this section. Review the source and add a supported statement or retain this gap.', references: passages.map(({ source, start, end }) => ({ source, start, end })) };
  });
}
function validReference(ref, sources) {
  if (!ref || !Number.isInteger(ref.source) || !sources[ref.source] || !Number.isInteger(ref.start) || !Number.isInteger(ref.end)) return false;
  const lines = sources[ref.source].text.split(/\r?\n/);
  return ref.start >= 1 && ref.end >= ref.start && ref.end <= lines.length && !!lines.slice(ref.start - 1, ref.end).join('\n').trim();
}
function validRecord(record) {
  if (!record || !uuid(record.id) || !['proposal', 'approved', 'failure'].includes(record.kind) || !Number.isSafeInteger(record.ordinal) || record.ordinal < 1 || !instant(record.createdAt) || !Array.isArray(record.sources) || !Array.isArray(record.sections)) return false;
  if (record.kind === 'failure') return typeof record.error === 'string' && record.error.length > 0 && !record.sources.length && !record.sections.length;
  if (!record.sources.length || record.sources.some(s => !s || typeof s.path !== 'string' || !path.isAbsolute(s.path) || typeof s.text !== 'string' || !/^[a-f0-9]{64}$/.test(s.sha256) || hash(s.text) !== s.sha256) || record.sources.reduce((n, s) => n + [...s.text].length, 0) > 32000) return false;
  if (record.sections.length !== titles.length || record.sections.some((s, i) => !s || s.title !== titles[i] || typeof s.text !== 'string' || !s.text.trim() || [...s.text].length > 32000 || !Array.isArray(s.references) || s.references.some(ref => !validReference(ref, record.sources)) || (!s.references.length && !s.text.startsWith('Gap:')))) return false;
  return record.kind !== 'approved' || (Number.isSafeInteger(record.version) && record.version > 0 && instant(record.approvedAt));
}
function markdown(record) {
  const metadata = YAML.stringify({ artifact_type: 'project_brief', schema_version: 1, record });
  return `---\n${metadata}---\n\n# MyTune brief — ${record.kind}${record.version ? ` version ${record.version}` : ''}\n\nOffline source extraction; edited statements are user writing, not model verification.\n\n${record.sections.map(s => `## ${s.title}\n\n${s.text}\n\n${s.references.map(r => `[${path.basename(record.sources[r.source].path)}:L${r.start}-L${r.end}](#source-${r.source + 1}) (source ${r.source + 1}, sha256 ${record.sources[r.source].sha256})`).join('\n')}`).join('\n\n')}\n\n# Selected source snapshots\n\n${record.sources.map((s, i) => `## Source ${i + 1}\n\n${s.path}\n\nsha256: ${s.sha256}\n\n${s.text}`).join('\n\n')}\n`;
}

function finalSourceDigest(file) {
  if (!local.statSync(file).isFile()) return null;
  const descriptor = local.openSync(file, 'r');
  try {
    const before = local.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(sourceByteLimit)) return null;
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = local.readSync(descriptor, bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    const after = local.fstatSync(descriptor, { bigint: true }), leaf = local.statSync(file, { bigint: true });
    const same = stat => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
      stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    return BigInt(used) === before.size && same(after) && same(leaf) ? hash(bytes.subarray(0, used)) : null;
  } finally { local.closeSync(descriptor); }
}

function blockStaleApproval(issues) {
  if (issues.length) throw Error(`Refresh approval blocked. ${issues.join(' ')} Restore or explicitly replace the source, then propose again.`);
}

class Briefs {
  constructor(vault, { assertSelection = () => {} } = {}) {
    this.vault = vault;
    this.dir = path.join(vault.root, 'Briefs');
    this.assertSelection = assertSelection;
  }
  async safe() { await this.vault.contained(this.vault.root); await this.vault.contained(this.dir); if ((await fs.lstat(this.dir)).isSymbolicLink()) throw Error('Briefs folder is a link. Choose an ordinary folder inside the vault.'); }
  async records(onlyVersion) {
    await this.safe(); const records = [];
    for (const name of await fs.readdir(this.dir)) {
      if (onlyVersion !== undefined) {
        const requested = name.match(/^approved-([0-9]+)(?:-|\.md$)/);
        if (!requested || Number(requested[1]) !== onlyVersion) continue;
      }
      if (!/^(proposal|approved|failure)-[\w-]+\.md$/.test(name)) continue;
      const file = path.join(this.dir, name); if ((await fs.lstat(file)).isSymbolicLink()) throw Error('Brief file is a link. Resolve it before continuing.');
      const text = await fs.readFile(file, 'utf8'); const match = text.match(/^---\n([\s\S]*?)\n---\n/);
      const data = match && YAML.parse(match[1]);
      if (name.startsWith('approved-') && !new RegExp(`^approved-[1-9][0-9]*-${hash(text)}\\.md$`).test(name)) throw Error(`Approved brief integrity check failed: ${name}. Preserved for repair; this version cannot be pinned.`);
      if (!data || data.artifact_type !== 'project_brief' || data.schema_version !== 1 || !validRecord(data.record) || !name.startsWith(`${data.record.kind}-`) || (data.record.kind === 'approved' && !name.startsWith(`approved-${data.record.version}-`)) || (data.record.kind !== 'approved' && name !== `${data.record.kind}-${data.record.id}.md`)) throw Error(`Invalid brief file ${name}. Preserved for repair.`);
      records.push({ ...data.record, file: name, digest: hash(text) });
    }
    const versions = records.filter(r => r.kind === 'approved').map(r => r.version);
    if (new Set(versions).size !== versions.length) throw Error('Duplicate approved brief version. Preserve the files and resolve their identity before pinning.');
    return records;
  }
  async write(record, name) {
    this.assertSelection();
    await this.safe();
    const stage = path.join(this.dir, `.brief-stage-${randomUUID()}`), destination = path.join(this.dir, name);
    const { guard } = ordinaryDirectories([this.vault.vault, this.dir], 'The Briefs folder changed or is an alias. Files were preserved for inspection.');
    const selected = () => { this.assertSelection(); guard(); };
    let staged, linked = false;
    try {
      staged = await writeStage(stage, markdown(record), selected);
      if (record.kind === 'approved') {
        await this.vault.checkpoint('brief-before-approval-publish');
        selected();
        await this.requireCurrentSources(record);
      }
      await verifyStage(stage, selected, staged);
      verifyStageSync(stage, selected, staged);
      if (record.kind === 'approved') {
        const issues = [];
        for (const source of record.sources) {
          try { if (finalSourceDigest(source.path) !== source.sha256) issues.push(`Changed source: ${source.path}`); }
          catch { issues.push(`Missing or unreadable source: ${source.path}`); }
        }
        blockStaleApproval(issues);
      }
      selected();
      local.linkSync(stage, destination);
      linked = true;
      await verifyPeers(stage, destination, guard, staged);
      try { await removeStage(stage, guard, staged, 2); }
      catch (error) { throw Error(`The Project Brief was published, but stage cleanup could not be verified. Inspect the saved version before retrying. ${error.message}`); }
      await verifyStage(destination, guard, staged);
    } finally {
      if (staged && !linked) await removeStage(stage, guard, staged).catch(() => {});
    }
  }
  async readSources(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw Error('Select the current MyTune README first.');
    const sources = []; let size = 0;
    for (const file of paths) {
      const stat = await fs.stat(file); if (!stat.isFile()) throw Error(`Source is not a document: ${file}`);
      if (stat.size > sourceByteLimit) throw Error(`Source exceeds local brief limit: ${file}. Nothing was shortened. Select a smaller document explicitly.`);
      const bytes = await fs.readFile(file); const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const front = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (front && YAML.parse(front[1])?.artifact_type === 'conversation_transcript') throw Error('Conversation transcripts are historical dialogue and cannot be used as opaque project brief inputs.');
      size += [...text].length;
      if (size > 32000) throw Error('Selected documents exceed 32000 characters. Nothing was shortened. Select smaller documents explicitly.');
      sources.push({ path: file, sha256: hash(bytes), text });
    }
    return sources;
  }
  async propose(paths, now) {
    return withBriefMutation(this.vault.root, async () => {
      const records = await this.records(); let sources;
      try { sources = await this.readSources(paths); }
      catch (error) {
        const failure = { id: randomUUID(), kind: 'failure', ordinal: Math.max(0, ...records.map(r => r.ordinal || 0)) + 1, createdAt: now, sources: [], sections: [], error: error.message };
        await this.write(failure, `failure-${failure.id}.md`); throw error;
      }
      const record = { id: randomUUID(), kind: 'proposal', ordinal: Math.max(0, ...records.map(r => r.ordinal || 0)) + 1, createdAt: now, sources, sections: extract(sources) };
      await this.write(record, `proposal-${record.id}.md`); return this.state();
    });
  }
  async outdated(record) {
    const issues = [];
    for (const source of record?.sources || []) {
      try { if (hash(await fs.readFile(source.path)) !== source.sha256) issues.push(`Changed source: ${source.path}`); }
      catch { issues.push(`Missing or unreadable source: ${source.path}`); }
    }
    return issues;
  }
  async requireCurrentSources(record) {
    blockStaleApproval(await this.outdated(record));
  }
  async state() {
    const records = await this.records(); const approved = records.filter(r => r.kind === 'approved').sort((a, b) => b.version - a.version);
    const proposed = records.filter(r => r.kind === 'proposal').sort((a, b) => b.ordinal - a.ordinal)[0];
    const latestAttempt = records.filter(r => r.kind !== 'approved').sort((a, b) => b.ordinal - a.ordinal)[0];
    return { approved, proposed, failure: latestAttempt?.kind === 'failure' ? latestAttempt.error : null, issues: await this.outdated(approved[0]), proposalIssues: await this.outdated(proposed) };
  }
  async approve({ id, digest, sections, references }, now) {
    return withBriefMutation(this.vault.root, async () => {
      const records = await this.records(), proposed = records.find(r => r.kind === 'proposal' && r.id === id);
      if (!proposed || proposed.digest !== digest) throw Error('Proposal changed. Inspect it again.');
      await this.requireCurrentSources(proposed);
      const latestAttempt = records.filter(r => r.kind !== 'approved').sort((a, b) => b.ordinal - a.ordinal)[0];
      if (latestAttempt?.kind === 'failure') throw Error('Refresh approval blocked. Resolve the failed refresh and propose again.');
      if (records.some(r => r.kind === 'approved' && r.id === id)) return this.state();
      if (!Array.isArray(sections) || sections.length !== titles.length || sections.some(s => typeof s !== 'string' || !s.trim())) throw Error('Fill every brief section or retain its explicit gap.');
      if (sections.some(s => [...s].length > 32000)) throw Error('Brief section exceeds 32000 characters. Nothing was shortened.');
      if (!Array.isArray(references) || references.length !== titles.length) throw Error('Inspect the passage references for every section.');
      const reviewedSections = proposed.sections.map((s, i) => {
        if (typeof references[i] !== 'string') throw Error('Use references in source:start-end format, for example 1:3-5.');
        const refs = references[i].trim() ? references[i].split(',').map(value => {
          const match = value.trim().match(/^(\d+):(\d+)-(\d+)$/);
          const ref = match && { source: Number(match[1]) - 1, start: Number(match[2]), end: Number(match[3]) };
          if (!ref || !validReference(ref, proposed.sources)) throw Error('Reference must name a nonempty passage in the selected source snapshot (source:start-end).');
          return ref;
        }) : [];
        if (!refs.length && !sections[i].startsWith('Gap:')) throw Error('An unsupported section must keep an explicit Gap: or add a passage reference.');
        return { ...s, text: sections[i], references: refs };
    });
    const version = Math.max(0, ...records.filter(r => r.kind === 'approved').map(r => r.version)) + 1;
    const { digest: _digest, file: _file, ...base } = proposed;
    const approved = { ...base, kind: 'approved', version, approvedAt: now, sections: reviewedSections };
    await this.write(approved, `approved-${version}-${hash(markdown(approved))}.md`);
    return this.state();
    });
  }
  async pinned(version) {
    if (!Number.isSafeInteger(version) || version < 1) throw Error('Approved brief version unavailable.');
    const [record] = await this.records(version);
    if (!record) throw Error('Approved brief version unavailable.');
    return { ...record, issues: await this.outdated(record) };
  }
}
module.exports = { Briefs };
