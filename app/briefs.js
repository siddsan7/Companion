const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const YAML = require('yaml');
const { withBriefMutation } = require('./briefs-lock');
const {
  ordinaryDirectories, readExact, writeStage, verifyStage, verifyStageSync, verifyAbsentSync,
  verifyPeersSync, validProof, removeStage, settlePublishedLink
} = require('./staged-publication');
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
function markdown(record, managedParent) {
  const metadata = YAML.stringify({
    artifact_type: 'project_brief', schema_version: 1,
    ...(record.kind === 'approved' && { managed_parent: managedParent }), record
  });
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

const privateStores = new Set(['.codex', '.companion-capture-owners', '.git', '.ideas', '.intake', '.obsidian', '.transcripts', 'managed-home']);
const approvalName = /^approved-([1-9][0-9]*)(?:-[\w-]+)?\.md$/;
const checksumName = /^approved-[1-9][0-9]*-[a-f0-9]{64}\.md$/i;
const receiptName = version => `.brief-approval-${version}.json`;
const receiptVersion = /^\.brief-approval-([1-9][0-9]*)\.json$/;
const pendingName = (version, phase = 'pending') => `.brief-approval-${version}.${phase}.json`;
const pendingVersion = /^\.brief-approval-([1-9][0-9]*)\.(pending|retiring)\.json$/;
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const integrityError = name => Error(`Approved brief integrity check failed: ${name}. Preserved for repair; this version cannot be pinned.`);
const duplicateError = () => Error('Duplicate approved brief version. Preserve the files and resolve their identity before pinning.');
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const parentMatches = (recorded, expected) => typeof recorded === 'string' && comparable(recorded) === comparable(expected);
const validParent = value => typeof value === 'string' && !/[\\<>:"|?*\0]/.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');

function metadata(bytes) {
  const match = bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match || !/^artifact_type:\s*project_brief\s*$/m.test(match[1])) return null;
  return YAML.parse(match[1]);
}

function approvedMetadata(data, version) {
  return data?.artifact_type === 'project_brief' && data.schema_version === 1 &&
    data.record?.kind === 'approved' && data.record.version === version && validRecord(data.record);
}

function versionEntries(names) {
  const versions = new Map();
  for (const name of names) {
    const approval = checksumName.test(name) && approvalName.exec(name);
    const receipt = receiptVersion.exec(name), pending = pendingVersion.exec(name);
    const version = Number((approval || receipt || pending)?.[1]);
    if (!Number.isSafeInteger(version)) continue;
    if (!versions.has(version)) versions.set(version, { canonical: [], receipt: null, pending: [] });
    const entry = versions.get(version);
    if (approval) entry.canonical.push(name);
    else if (receipt) entry.receipt = name;
    else entry.pending.push(name);
  }
  for (const name of names) {
    if (checksumName.test(name)) continue;
    const match = approvalName.exec(name);
    if (match) versions.get(Number(match[1]))?.canonical.push(name);
  }
  return versions;
}

class Briefs {
  constructor(vault, { assertSelection = () => {} } = {}) {
    this.vault = vault;
    this.dir = path.join(vault.root, 'Briefs');
    this.managedParent = path.relative(vault.vault, vault.root).split(path.sep).join('/');
    this.assertSelection = assertSelection;
  }
  async safe() { await this.vault.contained(this.vault.root); await this.vault.contained(this.dir); if ((await fs.lstat(this.dir)).isSymbolicLink()) throw Error('Briefs folder is a link. Choose an ordinary folder inside the vault.'); }
  folderGuard(directory = this.dir) {
    const { guard } = ordinaryDirectories(
      [...new Set([this.vault.vault, this.vault.root, this.dir, directory])],
      'The Briefs folder changed or is an alias. Files were preserved for inspection.'
    );
    return () => { this.assertSelection(); guard(); };
  }
  async index() {
    await this.safe();
    const guard = this.folderGuard();
    const names = await fs.readdir(this.dir);
    guard();
    return { guard, names, versions: versionEntries(names) };
  }
  async recoveredIndex(onlyVersion, lockHeld) {
    const index = await this.index();
    const pending = observed => [...observed.versions].filter(([version, entry]) =>
      entry.pending.length && (onlyVersion === undefined || onlyVersion === version));
    if (!pending(index).length) return index;
    const errors = new Map();
    const recover = async () => {
      const current = await this.index();
      for (const [version, entry] of pending(current)) {
        try {
          if (entry.pending.length !== 1) throw integrityError(entry.pending.join(', '));
          await this.recoverApproval(version, entry.pending[0], current.guard);
        } catch (error) { errors.set(version, error); }
      }
      return this.index();
    };
    try {
      const settled = await (lockHeld ? recover() : withBriefMutation(this.vault.root, recover));
      return { ...settled, errors };
    } catch (error) {
      for (const [version] of pending(index)) errors.set(version, error);
      return { ...index, errors };
    }
  }
  async publishMarker(file, value, guard, linkedMarker = () => {}) {
    const stage = `${file}.stage-${randomUUID()}`;
    const proof = await writeStage(stage, JSON.stringify({ ...value, markerStage: path.basename(stage) }), guard);
    let linked = false;
    try {
      verifyStageSync(stage, guard, proof);
      verifyAbsentSync(file, guard);
      local.linkSync(stage, file);
      linked = true;
      linkedMarker(proof);
      await settlePublishedLink(stage, file, guard, proof);
      return proof;
    } finally {
      if (!linked) await removeStage(stage, guard, proof).catch(() => {});
    }
  }
  async readMarker(file, guard, { validate, lockHeld = false, stagedFor = path.basename(file), retiring = false }) {
    const name = path.basename(file);
    const read = async owned => {
      guard();
      const stat = await fs.lstat(file, { bigint: true });
      if (stat.nlink !== 1n && (stat.nlink !== 2n || retiring)) throw integrityError(name);
      if (stat.nlink === 2n && !owned) return withBriefMutation(this.vault.root, () => read(true));
      const { bytes, proof } = await readExact(file, guard, Number(stat.nlink));
      const value = JSON.parse(bytes.toString('utf8'));
      validate(value, bytes);
      const stageName = value.markerStage;
      let stage;
      if (stageName !== undefined) {
        const prefix = `${stagedFor}.stage-`;
        if (typeof stageName !== 'string' || !stageName.startsWith(prefix) ||
            !uuid(stageName.slice(prefix.length)) || !bytes.equals(Buffer.from(JSON.stringify(value)))) {
          throw integrityError(name);
        }
        stage = path.join(this.dir, stageName);
      }
      if (stat.nlink === 2n) {
        if (!stage) throw integrityError(name);
        await settlePublishedLink(stage, file, guard, proof);
      }
      if (stage) verifyAbsentSync(stage, guard);
      verifyStageSync(file, guard, proof);
      return { value, proof };
    };
    return read(lockHeld);
  }
  async receipt(version, name, guard, lockHeld) {
    if (!name) return null;
    const file = path.join(this.dir, name);
    try {
      const { value, proof } = await this.readMarker(file, guard, {
        lockHeld,
        validate: entry => {
          if (entry?.schema !== 1 || entry.version !== version || !uuid(entry.id) ||
              typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest) ||
              !parentMatches(entry.parent, this.managedParent)) throw integrityError(name);
        }
      });
      return { ...value, file, proof };
    } catch (error) { throw Error(integrityError(name).message, { cause: error }); }
  }
  async managedClaim(version, name, guard, receipt) {
    const file = path.join(this.dir, name);
    try {
      const { bytes, proof } = await readExact(file, guard);
      const data = metadata(bytes);
      const recordedVersion = data?.record?.version;
      const valid = approvedMetadata(data, recordedVersion);
      const checksumClaim = checksumName.test(name);
      const checksumMatches = name === `approved-${version}-${proof.digest}.md`;
      if (!checksumClaim && valid && recordedVersion !== version) return null;
      const owner = data?.managed_parent;
      const foreign = valid && validParent(owner) && !parentMatches(owner, this.managedParent) &&
        receipt?.id !== data.record.id && (!checksumClaim || checksumMatches);
      if (foreign) return null;
      const readableRename = !checksumClaim && receipt &&
        receipt.id === data?.record?.id && receipt.digest === proof.digest;
      if ((!checksumMatches && !readableRename) || !valid || recordedVersion !== version ||
          owner !== undefined && (!receipt || !parentMatches(owner, this.managedParent))) throw integrityError(name);
      return { file, proof, data, guard };
    } catch (error) { throw Error(integrityError(name).message, { cause: error }); }
  }
  receiptValue(version, id, digest) {
    return { schema: 1, parent: this.managedParent, id, version, digest };
  }
  async readPending(version, name, guard) {
    const file = path.join(this.dir, name);
    const retiring = name === pendingName(version, 'retiring');
    let parents;
    const { value: pending, proof } = await this.readMarker(file, guard, {
      lockHeld: true, stagedFor: pendingName(version), retiring,
      validate: (entry, bytes) => {
        if (entry?.schema !== 1 || entry.version !== version || !uuid(entry.id) ||
            !parentMatches(entry.parent, this.managedParent) || !validProof(entry.staged) ||
            typeof entry.stage !== 'string' || !entry.stage.startsWith('.brief-stage-') ||
            !uuid(entry.stage.slice('.brief-stage-'.length)) || !Array.isArray(entry.identities) ||
            !bytes.equals(Buffer.from(JSON.stringify(entry)))) throw integrityError(name);
        parents = ordinaryDirectories([this.vault.vault, this.vault.root, this.dir],
          'The pending approval folders changed. Files were preserved for inspection.', entry.identities);
      }
    });
    const pinned = () => { guard(); parents.guard(); };
    verifyStageSync(file, pinned, proof);
    return { ...pending, file, proof, guard: pinned, retiring };
  }
  async finishPublishedApproval(pending, destination, guard) {
    const { version, id, staged } = pending;
    const stage = path.join(this.dir, pending.stage);
    const name = receiptName(version), file = path.join(this.dir, name);
    const verifyPending = () => verifyStageSync(pending.file, pending.guard, pending.proof);
    const verifyPublication = () => {
      verifyPending();
      guard();
      if (local.lstatSync(destination, { bigint: true }).nlink === 2n) {
        verifyPeersSync(stage, destination, guard, staged);
      } else {
        verifyAbsentSync(stage, guard);
        verifyStageSync(destination, guard, staged);
      }
    };
    verifyPublication();
    const links = Number(local.lstatSync(destination, { bigint: true }).nlink);
    const data = metadata(verifyStageSync(destination, guard, staged, links).bytes);
    if (!approvedMetadata(data, version) || data.record.id !== id ||
        !parentMatches(data.managed_parent, this.managedParent)) throw integrityError(path.basename(destination));
    const existing = await fs.lstat(file).catch(missing);
    let proof;
    if (existing) {
      const receipt = await this.receipt(version, name, pending.guard, true);
      if (receipt.id !== id || receipt.digest !== staged.digest) throw integrityError(name);
      proof = receipt.proof;
    } else {
      proof = await this.publishMarker(file, this.receiptValue(version, id, staged.digest), verifyPublication);
    }
    const verifyReceipts = () => {
      verifyPending();
      verifyStageSync(file, pending.guard, proof);
    };
    const verifySettlement = () => {
      verifyStageSync(file, pending.guard, proof);
      verifyAbsentSync(stage, guard);
      verifyStageSync(destination, guard, staged);
    };
    await settlePublishedLink(stage, destination, guard, staged, verifyReceipts);
    await removeStage(pending.file, pending.guard, pending.proof, 1, verifySettlement);
    verifySettlement();
  }
  async retireUnpublishedApproval(pending, stage, destination) {
    const { version, guard, proof, staged } = pending;
    const receipt = path.join(this.dir, receiptName(version));
    const unpublished = () => {
      verifyAbsentSync(receipt, guard);
      verifyAbsentSync(destination, guard);
    };
    let marker = pending.file;
    if (!pending.retiring) {
      const retiring = path.join(this.dir, pendingName(version, 'retiring'));
      verifyStageSync(stage, guard, staged);
      verifyStageSync(marker, guard, proof);
      unpublished();
      verifyAbsentSync(retiring, guard);
      local.renameSync(marker, retiring);
      marker = retiring;
    }
    const pendingNameBefore = path.join(this.dir, pendingName(version));
    const verifyRetirement = () => {
      unpublished();
      verifyAbsentSync(pendingNameBefore, guard);
    };
    guard();
    if (await fs.lstat(stage).catch(missing)) {
      await removeStage(stage, guard, staged, 1, () => {
        verifyRetirement();
        verifyStageSync(marker, guard, proof);
      });
    }
    await removeStage(marker, guard, proof, 1, () => {
      verifyRetirement();
      verifyAbsentSync(stage, guard);
    });
  }
  async recoverApproval(version, name, guard) {
    try {
      const pending = await this.readPending(version, name, guard);
      const stage = path.join(this.dir, pending.stage);
      const canonical = path.join(this.dir, `approved-${version}-${pending.staged.digest}.md`);
      pending.guard();
      if (!pending.retiring && await fs.lstat(canonical).catch(missing)) {
        await this.finishPublishedApproval(pending, canonical, pending.guard);
        return;
      }
      const claims = await this.scanApprovalClaims(new Set([pending.id]), new Set());
      const candidates = claims.get(pending.id) || [];
      if (candidates.length) {
        if (pending.retiring || candidates.length !== 1) throw integrityError(name);
        const [moved] = candidates;
        const movedGuard = () => {
          verifyAbsentSync(canonical, pending.guard);
          moved.guard();
        };
        await this.finishPublishedApproval(pending, moved.file, movedGuard);
        return;
      }
      await this.retireUnpublishedApproval(pending, stage, canonical);
    } catch (error) { throw Error(integrityError(name).message, { cause: error }); }
  }
  async observeLegacy(version, candidate, guard, lockHeld) {
    const reserve = async () => {
      const name = receiptName(version);
      const file = path.join(this.dir, name);
      const { proof, data } = candidate;
      verifyStageSync(candidate.file, candidate.guard, proof);
      let present;
      try { present = local.lstatSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present) {
        const receipt = await this.receipt(version, name, guard, true);
        if (receipt.id !== data.record.id || receipt.digest !== proof.digest) throw integrityError(name);
        verifyStageSync(file, guard, receipt.proof);
        verifyStageSync(candidate.file, candidate.guard, proof);
        return receipt;
      }
      const canonical = () => verifyStageSync(candidate.file, candidate.guard, proof);
      const receiptGuard = () => { guard(); canonical(); };
      const receiptProof = await this.publishMarker(file, this.receiptValue(version, data.record.id, proof.digest), receiptGuard);
      verifyStageSync(file, guard, receiptProof);
      verifyStageSync(candidate.file, candidate.guard, proof);
      return { id: data.record.id, digest: proof.digest, file, proof: receiptProof };
    };
    return lockHeld ? reserve() : withBriefMutation(this.vault.root, reserve);
  }
  async scanApprovalClaims(ids, canonicalFiles) {
    const claims = new Map();
    if (!ids.size) return claims;
    const visit = async (directory, guard) => {
      guard();
      const children = await fs.readdir(directory, { withFileTypes: true });
      guard();
      for (const child of children) {
        if (privateStores.has(child.name.toLowerCase()) || child.isSymbolicLink()) continue;
        const file = path.join(directory, child.name);
        if (child.isDirectory()) await visit(file, this.folderGuard(file));
        else if (child.isFile() && /\.md$/i.test(child.name) && !canonicalFiles.has(file)) {
          const stat = await fs.lstat(file, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const { bytes, proof } = await readExact(file, guard, Number(stat.nlink));
          let data;
          try { data = metadata(bytes); } catch { continue; }
          if (data?.record?.kind !== 'approved' || !ids.has(data.record.id)) continue;
          if (!claims.has(data.record.id)) claims.set(data.record.id, []);
          claims.get(data.record.id).push({ file, proof, data, guard, links: Number(stat.nlink) });
        }
      }
    };
    await visit(this.vault.vault, this.folderGuard(this.vault.vault));
    return claims;
  }
  async approvedInventory(index, onlyVersion, lockHeld) {
    const inspected = new Map(), ids = new Set(), canonicalFiles = new Set();
    for (const [version, entry] of index.versions) {
      if (onlyVersion !== undefined && onlyVersion !== version) continue;
      const recoveryError = index.errors?.get(version);
      if (recoveryError) { inspected.set(version, { error: recoveryError }); continue; }
      try {
        const receipt = await this.receipt(version, entry.receipt, index.guard, lockHeld);
        let canonical;
        for (const name of entry.canonical) {
          const claim = await this.managedClaim(version, name, index.guard, receipt);
          if (!claim) continue;
          canonicalFiles.add(claim.file);
          if (canonical) throw duplicateError();
          canonical = claim;
        }
        if (!receipt && !canonical) continue;
        const id = receipt?.id || canonical?.data.record.id;
        if (id) ids.add(id);
        if (receipt && canonical && (receipt.id !== canonical.data.record.id || receipt.digest !== canonical.proof.digest)) {
          throw integrityError(path.basename(canonical.file));
        }
        inspected.set(version, { id, receipt, canonical });
      } catch (error) { inspected.set(version, { error }); }
    }
    for (const [version, error] of index.errors || []) {
      if (!inspected.has(version)) inspected.set(version, { error });
    }
    const claims = await this.scanApprovalClaims(ids, canonicalFiles);
    index.guard();
    const approvals = new Map();
    for (const [version, entry] of inspected) {
      if (entry.error) { approvals.set(version, entry); continue; }
      const { id, canonical } = entry;
      let { receipt } = entry;
      const moved = claims.get(id) || [];
      if (moved.length + Number(Boolean(canonical)) > 1) {
        approvals.set(version, { error: duplicateError() });
        continue;
      }
      const candidate = canonical || moved[0];
      if (!candidate || !canonical && !receipt) { approvals.set(version, { receipt }); continue; }
      try {
        verifyStageSync(candidate.file, candidate.guard, candidate.proof);
        const { data, proof, file } = candidate;
        if (!approvedMetadata(data, version) || receipt && receipt.digest !== proof.digest ||
            data.managed_parent !== undefined && !parentMatches(data.managed_parent, this.managedParent)) {
          throw integrityError(path.basename(file));
        }
        receipt ||= await this.observeLegacy(version, candidate, index.guard, lockHeld);
        verifyStageSync(receipt.file, index.guard, receipt.proof);
        verifyStageSync(file, candidate.guard, proof);
        approvals.set(version, { receipt, record: { ...data.record, file: path.relative(this.dir, file), digest: proof.digest } });
      } catch (error) {
        approvals.set(version, { error: Error(integrityError(path.basename(candidate.file)).message, { cause: error }) });
      }
    }
    return approvals;
  }
  async readStore({ onlyVersion, lockHeld = false, inspectRecoveryHolds = false } = {}) {
    const index = await this.recoveredIndex(onlyVersion, lockHeld);
    const approvals = await this.approvedInventory(index, onlyVersion, lockHeld);
    const records = [], recoveryHolds = [];
    for (const [version, { record, error }] of approvals) {
      if (error) {
        if (!inspectRecoveryHolds || index.errors?.get(version) !== error) throw error;
        recoveryHolds.push(error.message);
      }
      if (record) records.push(record);
    }
    if (onlyVersion === undefined) {
      for (const name of index.names) {
        if (!/^(proposal|failure)-[\w-]+\.md$/.test(name)) continue;
        const { bytes, proof } = await readExact(path.join(this.dir, name), index.guard);
        const data = metadata(bytes);
        if (!data || data.artifact_type !== 'project_brief' || data.schema_version !== 1 || !validRecord(data.record) ||
            name !== `${data.record.kind}-${data.record.id}.md`) throw Error(`Invalid brief file ${name}. Preserved for repair.`);
        records.push({ ...data.record, file: name, digest: proof.digest });
      }
    }
    return { records, approvals, recoveryHolds };
  }
  async records(onlyVersion) {
    return (await this.readStore({ onlyVersion })).records;
  }
  async write(record, name) {
    this.assertSelection();
    await this.safe();
    const stage = path.join(this.dir, `.brief-stage-${randomUUID()}`), destination = path.join(this.dir, name);
    const { guard, identities } = ordinaryDirectories([this.vault.vault, this.vault.root, this.dir], 'The Briefs folder changed or is an alias. Files were preserved for inspection.');
    const selected = () => { this.assertSelection(); guard(); };
    let staged, pending, linked = false;
    const approved = record.kind === 'approved';
    try {
      staged = await writeStage(stage, markdown(record, this.managedParent), selected);
      if (approved) {
        await this.vault.checkpoint('brief-before-approval-publish');
        selected();
        await this.requireCurrentSources(record);
      }
      await verifyStage(stage, selected, staged);
      verifyStageSync(stage, selected, staged);
      if (approved) {
        this.requireCurrentSourcesSync(record);
        const file = path.join(this.dir, pendingName(record.version));
        const value = {
          schema: 1, parent: this.managedParent, id: record.id, version: record.version,
          stage: path.basename(stage), staged, identities
        };
        const proof = await this.publishMarker(file, value, selected, markerProof => {
          pending = { ...value, file, proof: markerProof, guard: selected };
        });
        verifyStageSync(file, selected, proof);
        this.requireCurrentSourcesSync(record);
        verifyAbsentSync(path.join(this.dir, receiptName(record.version)), selected);
        verifyAbsentSync(path.join(this.dir, pendingName(record.version, 'retiring')), selected);
        verifyStageSync(stage, selected, staged);
      }
      selected();
      local.linkSync(stage, destination);
      linked = true;
      try {
        if (pending) await this.finishPublishedApproval(pending, destination, guard);
        else await settlePublishedLink(stage, destination, guard, staged);
      }
      catch (error) { throw Error(`The Project Brief was published, but stage cleanup could not be verified. Inspect the saved version before retrying. ${error.message}`); }
      verifyStageSync(destination, guard, staged);
    } finally {
      if (staged && !pending && !linked) await removeStage(stage, guard, staged).catch(() => {});
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
      const { records } = await this.readStore({ lockHeld: true }); let sources;
      try { sources = await this.readSources(paths); }
      catch (error) {
        const failure = { id: randomUUID(), kind: 'failure', ordinal: Math.max(0, ...records.map(r => r.ordinal || 0)) + 1, createdAt: now, sources: [], sections: [], error: error.message };
        await this.write(failure, `failure-${failure.id}.md`); throw error;
      }
      const record = { id: randomUUID(), kind: 'proposal', ordinal: Math.max(0, ...records.map(r => r.ordinal || 0)) + 1, createdAt: now, sources, sections: extract(sources) };
      await this.write(record, `proposal-${record.id}.md`); return this.state(true);
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
  requireCurrentSourcesSync(record) {
    const issues = [];
    for (const source of record.sources) {
      try { if (finalSourceDigest(source.path) !== source.sha256) issues.push(`Changed source: ${source.path}`); }
      catch { issues.push(`Missing or unreadable source: ${source.path}`); }
    }
    blockStaleApproval(issues);
  }
  async state(lockHeld = false) {
    // The desktop can inspect valid approvals while a pending publication is held.
    // Propose and approve still require the strict store read before any mutation.
    const { records, recoveryHolds } = await this.readStore({ lockHeld, inspectRecoveryHolds: true });
    const approved = records.filter(r => r.kind === 'approved').sort((a, b) => b.version - a.version);
    const proposed = records.filter(r => r.kind === 'proposal').sort((a, b) => b.ordinal - a.ordinal)[0];
    const latestAttempt = records.filter(r => r.kind !== 'approved').sort((a, b) => b.ordinal - a.ordinal)[0];
    const failure = recoveryHolds.join(' ') || (latestAttempt?.kind === 'failure' ? latestAttempt.error : null);
    return { approved, proposed, failure, issues: await this.outdated(approved[0]), proposalIssues: await this.outdated(proposed) };
  }
  async approve({ id, digest, sections, references }, now) {
    return withBriefMutation(this.vault.root, async () => {
      const { records, approvals } = await this.readStore({ lockHeld: true });
      const proposed = records.find(r => r.kind === 'proposal' && r.id === id);
      if (!proposed || proposed.digest !== digest) throw Error('Proposal changed. Inspect it again.');
      const prior = [...approvals.values()].find(entry => entry.receipt?.id === id);
      if (prior && !prior.record) throw Error('This proposal was already approved. Its reserved version is unavailable.');
      await this.requireCurrentSources(proposed);
      const latestAttempt = records.filter(r => r.kind !== 'approved').sort((a, b) => b.ordinal - a.ordinal)[0];
      if (latestAttempt?.kind === 'failure') throw Error('Refresh approval blocked. Resolve the failed refresh and propose again.');
      if (prior) return this.state(true);
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
    const version = Math.max(0, ...approvals.keys()) + 1;
    if (!Number.isSafeInteger(version)) throw Error('No unused approved brief version is available.');
    const { digest: _digest, file: _file, ...base } = proposed;
    const approved = { ...base, kind: 'approved', version, approvedAt: now, sections: reviewedSections };
    await this.write(approved, `approved-${version}-${hash(markdown(approved, this.managedParent))}.md`);
    return this.state(true);
    });
  }
  async pinned(version) {
    if (!Number.isSafeInteger(version) || version < 1) throw Error('Approved brief version unavailable.');
    const [record] = await this.records(version);
    if (!record) throw Error('Approved brief version unavailable.');
    return { ...record, issues: await this.outdated(record) };
  }
  async pins() {
    const inventory = await this.approvedInventory(await this.recoveredIndex());
    const ordered = [...inventory].sort(([a], [b]) => a - b);
    return Promise.all(ordered.map(async ([version, { record, error }]) => record
      ? { version, pin: { ...record, issues: await this.outdated(record) } }
      : { version, error: error || Error('Approved brief version unavailable.') }));
  }
}
module.exports = { Briefs };
