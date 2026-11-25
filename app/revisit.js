const local = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const {
  readExactSync, verifyAbsentSync, writeStage, removeStageIfPresentSync, publishReplacement, initialPublicationPending, recoverInitialPublication
} = require('./staged-publication');
const { Decisions, activeConditions } = require('./decisions');
const { matchCondition, fingerprint } = require('./revisit-match');
const { buildPackage, parseReply, packageLimit, codePoints, stopPattern } = require('./revisit-gate');

// D44-D50: every admitted evidence revision is matched locally against every active
// revisit condition exactly once. Matches become candidates; a separate gate decides
// whether a candidate becomes a notice. All stage records live in one atomically
// replaced file so a later miss can be traced to retrieval or to the gate.
const stateStageName = /^\.revisit-state-[a-f0-9-]{36}\.pending$/;
const evidencePrefixes = ['capture:', 'annotation:', 'idea:', 'brief:'];
const maxAttempts = 3;
const stateChanged = () => Error('Revisit records changed during this check. Run the check again.');
const defaultCap = 10;
const validCap = cap => Number.isSafeInteger(cap) && cap >= 1 && cap <= 100;
const emptyState = () => ({ schema: 1, settings: { automatic: false, cap: defaultCap, changedAt: null }, seen: {}, events: [], candidates: [], notices: [], lastRun: null });
const evidenceId = item => `${item.key}#${item.digest}`;
const conditionId = condition => `${condition.id}@${condition.version}`;
const open = status => ['pending', 'sending', 'held', 'held-oversize'].includes(status);
// Gate runs in progress in this process. A request owned by one of them, or by another
// live process, is still in flight and must not be settled as interrupted.
const activeRuns = new Set();
// A request older than this is never still in flight, even if its owner's process id has
// been reused by another program (common on Windows after a restart).
const maxRequestMs = 30 * 60 * 1000;
function inFlight(owner) {
  if (!owner) return false;
  if (owner.pid === process.pid && owner.started === processStarted) return activeRuns.has(owner.run);
  if (!Number.isFinite(owner.sentAt) || Date.now() - owner.sentAt > maxRequestMs) return false;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
const processStarted = Math.round(Date.now() - process.uptime() * 1000);

function localDate(instant, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

class Revisit {
  // getEvidence(vault) returns the eligible corpus: rejected, removed and deleted sources
  // are already excluded there (D44-I04, D19-I04, D37).
  constructor(vault, { getEvidence, gate, checkpoint = async () => {} }) {
    Object.assign(this, { vault, getEvidence, gate, checkpoint });
    this.decisions = new Decisions(vault, { checkpoint });
    this.directory = path.join(vault.root, '.revisit');
    this.file = path.join(this.directory, 'state.json');
  }
  guard() {
    try { local.mkdirSync(this.directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return this.vault.publicationFolders(this.directory).guard;
  }
  readState() {
    const guard = this.guard();
    recoverInitialPublication(this.file, guard, stateStageName);
    try {
      const { bytes, proof } = readExactSync(this.file, guard);
      const state = JSON.parse(bytes);
      if (state?.schema !== 1 || !Array.isArray(state.candidates) || !Array.isArray(state.notices)) throw Error('Revisit records need repair. The file was preserved.');
      return { state, proof };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      verifyAbsentSync(this.file, guard);
      return { state: emptyState(), proof: null };
    }
  }
  async writeState(state, expected) {
    const guard = this.guard(), stage = path.join(this.directory, `.revisit-state-${randomUUID()}.pending`);
    const proof = await writeStage(stage, JSON.stringify(state, null, 2), guard);
    try { await publishReplacement(stage, this.file, guard, proof, expected, { conflict: stateChanged, stageName: stateStageName }); }
    catch (error) {
      try { if (expected || !initialPublicationPending(this.file, guard)) removeStageIfPresentSync(stage, guard, proof); } catch {}
      throw error;
    }
    return proof;
  }
  // Gate packages are kept as separate files so the records stay small; the records keep
  // the path, length and digest (D46-I06).
  writePackage(attemptId, text) {
    const guard = this.guard(), directory = path.join(this.directory, 'packages');
    try { local.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.vault.publicationFolders(directory).guard();
    const file = path.join(directory, `${attemptId}.txt`), bytes = Buffer.from(text), descriptor = local.openSync(file, 'wx');
    try { local.writeSync(descriptor, bytes); local.fsyncSync(descriptor); } finally { local.closeSync(descriptor); }
    guard();
    return { packageFile: `packages/${attemptId}.txt`, packageLength: codePoints(text), packageDigest: createHash('sha256').update(bytes).digest('hex') };
  }
  readPackage(attempt) {
    if (typeof attempt.package === 'string') return attempt.package;
    if (typeof attempt.packageFile !== 'string' || !/^packages\/[a-f0-9-]{36}\.txt$/.test(attempt.packageFile)) return null;
    try {
      const bytes = local.readFileSync(path.join(this.directory, attempt.packageFile));
      return createHash('sha256').update(bytes).digest('hex') === attempt.packageDigest ? bytes.toString('utf8') : null;
    } catch { return null; }
  }
  async evidence(dispatch) {
    const corpus = await this.getEvidence(this.vault, { dispatch });
    return { items: corpus.all.filter(item => evidencePrefixes.some(prefix => item.key.startsWith(prefix))), issues: corpus.issues || [] };
  }
  // Records a user's resolution from the ledger note into the notice records, so a crash
  // between publishing a version and updating the records is repaired on the next read.
  reconcileResolutions(state, ledger) {
    const resolved = new Map();
    for (const decision of ledger.decisions) for (const { record } of decision.versions) if (record.resolution) resolved.set(record.resolution.notice_id, record);
    for (const notice of state.notices) {
      const record = resolved.get(notice.id);
      if (!record || notice.resolution) continue;
      notice.status = { reaffirm: 'reaffirmed', revise: 'revised', withdraw: 'withdrawn', dismiss: 'dismissed' }[record.resolution.action];
      notice.resolution = { action: record.resolution.action, reason: record.resolution.reason, decisionVersion: record.version, at: record.saved_at };
    }
  }
  // A failed or interrupted request is terminal and never replayed (D46-I08).
  settleInterrupted(state) {
    for (const candidate of state.candidates) {
      if (candidate.status !== 'sending') continue;
      const sent = candidate.attempts.filter(attempt => attempt.status === 'sent');
      if (sent.some(attempt => inFlight(attempt.owner))) continue;
      for (const attempt of sent) Object.assign(attempt, { status: 'interrupted', error: 'Request interrupted before a reply was recorded. It will not be replayed.' });
      candidate.status = this.afterFailure(candidate);
    }
  }
  failedAttempts(candidate) {
    return candidate.attempts.filter(attempt => attempt.mode === 'automatic' && ['failed', 'interrupted'].includes(attempt.status)).length;
  }
  afterFailure(candidate) {
    const failures = this.failedAttempts(candidate);
    return failures < maxAttempts || candidate.retryAfterFailures === failures ? 'pending' : 'held';
  }
  // D49-I02: removed evidence withdraws open candidates and marks unresolved notices.
  markRemoved(state, present, now) {
    for (const candidate of state.candidates) if (open(candidate.status) && !present.has(candidate.evidence.key)) {
      Object.assign(candidate, { status: 'withdrawn', withdrawnReason: 'Evidence removed, rejected or deleted.', withdrawnAt: now });
    }
    for (const notice of state.notices) if (notice.kind === 'evidence' && notice.status === 'open' && !present.has(notice.evidence.key)) {
      Object.assign(notice, { status: 'evidence removed', removedAt: now });
    }
  }
  // D43-I02/I03: a candidate for a condition version that is no longer current is inert.
  retireStale(state, current, now) {
    for (const candidate of state.candidates) if (open(candidate.status) && !current.has(conditionId(candidate.condition))) {
      Object.assign(candidate, { status: 'withdrawn', withdrawnReason: 'Condition version is no longer active. Earlier outcomes do not carry over.', withdrawnAt: now });
    }
  }
  // Marks every current evidence revision as already seen without matching it. Used when
  // a decision is saved, so evidence that existed before the condition never fires.
  sweep(state, items, now) { for (const item of items) state.seen[evidenceId(item)] ||= now; }
  match(state, ledger, items, now, trigger) {
    const conditions = ledger.decisions.flatMap(activeConditions).filter(({ condition }) => condition.kind === 'evidence');
    for (const item of items) {
      const id = evidenceId(item);
      if (state.seen[id]) continue;
      state.seen[id] = now;
      const event = { id: randomUUID(), at: now, trigger, evidence: { key: item.key, digest: item.digest, title: item.title }, candidates: [], considered: conditions.length };
      const ranked = conditions.map(entry => ({ ...entry, found: matchCondition(entry.condition, item) })).filter(entry => entry.found).sort((a, b) => b.found.score - a.found.score);
      for (const { decision, condition, found } of ranked) {
        const print = fingerprint(found.passages);
        const repeat = state.candidates.find(other => other.condition.id === condition.id && other.condition.version === condition.version && other.fingerprint === print && other.status !== 'withdrawn');
        const candidate = {
          id: randomUUID(), createdAt: now, eventId: event.id,
          decision: { id: decision.decision_id, version: decision.version, title: decision.title },
          condition: { id: condition.id, version: condition.version, label: condition.label, trigger: condition.trigger, action: condition.action },
          evidence: { key: item.key, digest: item.digest, title: item.title, provenance: item.provenance, ...(item.revisionId ? { revisionId: item.revisionId } : {}) },
          passages: found.passages, reasons: found.reasons, fingerprint: print, attempts: [],
          status: repeat ? 'duplicate' : 'pending', ...(repeat ? { duplicateOf: repeat.id } : {})
        };
        state.candidates.push(candidate); event.candidates.push(candidate.id);
      }
      event.outcome = event.candidates.length ? 'candidates' : 'no candidate';
      state.events.push(event);
    }
  }
  // D44-I03: one due notice per time condition version, however many checks were missed.
  due(state, ledger, now, timezone) {
    const today = localDate(now, timezone);
    for (const { decision, condition } of ledger.decisions.flatMap(activeConditions)) {
      if (condition.kind !== 'time' || condition.review_by > today) continue;
      if (state.notices.some(notice => notice.kind === 'due' && notice.condition.id === condition.id && notice.condition.version === condition.version)) continue;
      state.notices.push({
        id: randomUUID(), kind: 'due', raisedAt: now, status: 'open',
        decision: { id: decision.decision_id, version: decision.version, title: decision.title },
        condition: { id: condition.id, version: condition.version, label: condition.label, trigger: condition.trigger, action: condition.action },
        evidence: { clock: condition.review_by }, passage: null,
        reason: `Review-by date ${condition.review_by} reached. No model was used.`
      });
    }
  }
  history(state, condition) {
    return state.candidates.filter(other => conditionId(other.condition) === conditionId(condition) && other.outcome)
      .map(other => ({ at: other.decidedAt, outcome: other.outcome, reason: other.outcomeReason }));
  }
  packageFor(state, ledger, candidate) {
    const decision = ledger.decisions.find(item => item.id === candidate.decision.id)?.latest;
    if (!decision) throw Error('The decision behind this candidate is unavailable.');
    return buildPackage({ decision, condition: candidate.condition, candidate, history: this.history(state, candidate.condition) });
  }
  raise(state, candidate, result, now) {
    candidate.status = result.outcome; candidate.outcome = result.outcome; candidate.outcomeReason = result.reason; candidate.decidedAt = now;
    if (result.outcome !== 'meets') return;
    // One notice per condition version and evidence revision (D47-I02).
    if (state.notices.some(notice => notice.kind === 'evidence' && notice.condition.id === candidate.condition.id && notice.condition.version === candidate.condition.version && notice.evidence.key === candidate.evidence.key && notice.evidence.digest === candidate.evidence.digest)) return;
    const notice = {
      id: randomUUID(), kind: 'evidence', raisedAt: now, status: 'open', candidateId: candidate.id,
      decision: candidate.decision, condition: candidate.condition, evidence: candidate.evidence,
      passage: result.quote, passages: candidate.passages, reason: result.reason
    };
    state.notices.push(notice); candidate.noticeId = notice.id;
  }
  // Chooses candidates for this run and records their packages before anything is sent.
  prepare(state, ledger, { mode, only, now, status, run }) {
    const chosen = [];
    const queue = only ? state.candidates.filter(candidate => candidate.id === only) : state.candidates.filter(candidate => candidate.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cap = mode === 'automatic' ? state.settings.cap : 1;
    for (const candidate of queue) {
      if (chosen.length >= cap) break;
      const text = this.packageFor(state, ledger, candidate);
      const limit = status.limit ?? packageLimit;
      if (codePoints(text) > limit) {
        // Never shortened silently (D46-I04, D36-I03).
        Object.assign(candidate, { status: 'held-oversize', heldReason: `Package is ${codePoints(text)} characters, over the ${limit}-character limit, and is never shortened automatically. Shorten this decision's choice or reasons in a new version; the candidate is then checked again.` });
        if (mode === 'manual') throw Error(candidate.heldReason);
        continue;
      }
      const attemptId = randomUUID();
      const attempt = { id: attemptId, at: now, mode: status.rule === 'match' ? 'rule' : mode, status: 'sent', owner: { pid: process.pid, started: processStarted, run, sentAt: Date.now() }, ...this.writePackage(attemptId, text) };
      candidate.attempts.push(attempt); candidate.status = 'sending';
      chosen.push({ candidate: candidate.id, attempt: attempt.id, text, evidence: candidate.evidence, settings: state.settings });
    }
    return chosen;
  }
  // The provider calls the returned synchronous check immediately before turn/start.
  async beforeStart(item, mode) {
    let verifySource;
    const { items } = await this.evidence({
      dependencies: new Map([[item.evidence.key, item.evidence.digest]]),
      observe: verify => { verifySource = verify; }
    });
    const source = items.find(value => value.key === item.evidence.key && value.digest === item.evidence.digest);
    return () => {
      if (!source || !verifySource) throw Error('Matched evidence is unavailable. Check decisions again.');
      verifySource();
      const { state } = this.readState(), ledger = this.decisions.load();
      const candidate = state.candidates.find(entry => entry.id === item.candidate);
      if (candidate?.status !== 'sending' || !candidate.attempts.some(entry => entry.id === item.attempt && entry.status === 'sent')) throw Error('Revisit candidate is unavailable.');
      if (mode === 'automatic' && (state.settings.automatic !== true || JSON.stringify(state.settings) !== JSON.stringify(item.settings))) throw Error('Automatic revisit consent is unavailable or the cap changed. Check decisions again.');
      const decision = ledger.decisions.find(entry => entry.id === candidate.decision.id);
      const current = decision && activeConditions(decision).find(entry => conditionId(entry.condition) === conditionId(candidate.condition));
      const match = current && matchCondition(current.condition, source);
      if (!match || buildPackage({ ...current, candidate: { evidence: source, passages: match.passages }, history: this.history(state, current.condition) }) !== item.text) throw Error('Reviewed revisit package is unavailable. Preview again.');
    };
  }
  async send(chosen, mode, status) {
    const results = [];
    let stop = null;
    for (const item of chosen) {
      if (stop) { results.push({ ...item, skipped: true }); continue; }
      await this.checkpoint('revisit-before-gate-request', { candidate: item.candidate });
      let dispatched = false;
      const beforeStart = async () => {
        const verify = await this.beforeStart(item, mode);
        return () => { verify(); dispatched = true; };
      };
      try {
        if (status.rule === 'match') { (await beforeStart())(); results.push({ ...item, rule: true }); }
        else results.push({ ...item, response: await this.gate.send(item.text, mode, status, beforeStart) });
      }
      catch (error) {
        // Usage, offline and sign-in failures stop the run and are not the candidate's
        // fault, so they do not count toward its three attempts (D46-I07, D46-I08).
        const stopped = !dispatched || stopPattern.test(error.message);
        results.push({ ...item, error: error.message, stopped, beforeSend: !dispatched });
        if (stopped) stop = error.message;
      }
    }
    return { results, stop };
  }
  apply(state, results, now) {
    let raised = 0;
    for (const result of results) {
      const candidate = state.candidates.find(item => item.id === result.candidate);
      const attempt = candidate?.attempts.find(item => item.id === result.attempt);
      if (!attempt || attempt.status !== 'sent') continue;
      if (candidate.status === 'withdrawn') { Object.assign(attempt, { status: 'withdrawn', finishedAt: now }); continue; }
      if (result.skipped) { Object.assign(attempt, { status: 'not sent', finishedAt: now }); candidate.status = 'pending'; continue; }
      if (result.rule) {
        Object.assign(attempt, { status: 'answered', outcome: 'meets', reason: 'Test rule: notify on any match (D50-I02).', model: 'rule:notify-on-match' });
        const before = state.notices.length;
        this.raise(state, candidate, { outcome: 'meets', reason: attempt.reason, quote: candidate.passages[0]?.text || '' }, now);
        raised += state.notices.length - before; continue;
      }
      if (result.error) {
        Object.assign(attempt, { status: result.stopped ? 'stopped' : 'failed', error: result.error, finishedAt: now });
        candidate.status = this.afterFailure(candidate);
        if (candidate.status === 'held') candidate.heldReason = 'Automatic attempts exhausted. Retry explicitly.';
        continue;
      }
      let parsed;
      try { parsed = parseReply(result.response.reply, candidate.passages); }
      catch (error) {
        Object.assign(attempt, { status: 'failed', error: error.message, reply: String(result.response.reply).slice(0, 4000), model: result.response.model, finishedAt: now });
        candidate.status = this.afterFailure(candidate);
        continue;
      }
      Object.assign(attempt, { status: 'answered', ...parsed, reply: result.response.reply, model: result.response.model, effective: result.response.effective ?? null, usage: result.response.usage, evidence: result.response.evidence, finishedAt: now });
      const before = state.notices.length;
      this.raise(state, candidate, parsed, now);
      raised += state.notices.length - before;
    }
    return raised;
  }
  // Locked bookkeeping shared by every check: recovery, removal, staleness, matching
  // and due dates. Returns the ledger it used.
  reconcile(state, { now, timezone, trigger, items }) {
    const ledger = this.decisions.load();
    this.reconcileResolutions(state, ledger);
    this.settleInterrupted(state);
    if (items) {
      const present = new Set(items.map(item => item.key));
      this.markRemoved(state, present, now);
      const revisions = new Set(items.map(evidenceId));
      for (const candidate of state.candidates) if (open(candidate.status) && !revisions.has(evidenceId(candidate.evidence))) {
        Object.assign(candidate, { status: 'withdrawn', withdrawnReason: 'The matched evidence revision is no longer available.', withdrawnAt: now });
      }
      // Kept so the read-only list can warn about missing references without reading
      // the corpus, which would contend with intake for the source lock.
      state.presentKeys = [...present].sort();
    }
    const current = new Set(ledger.decisions.flatMap(activeConditions).map(({ condition }) => conditionId(condition)));
    this.retireStale(state, current, now);
    if (items) this.match(state, ledger, items, now, trigger);
    this.due(state, ledger, now, timezone);
    return ledger;
  }
  // A revisit check: runs after intake has released its lock (D46-I09).
  // trigger: manual | scheduled | catch-up | capture | intake | annotation | removal
  async check({ now, timezone, trigger, gate = true }) {
    // A vault with no decision has nothing to revisit; leave it untouched.
    if (!this.decisions.decisionDirectories().length) return { lastRun: null, open: 0 };
    const run = randomUUID();
    activeRuns.add(run);
    try { return await this.checkRun({ now, timezone, trigger, gate, run }); }
    finally { activeRuns.delete(run); }
  }
  async checkRun({ now, timezone, trigger, gate, run }) {
    let evidence = null, evidenceError = null;
    try { evidence = await this.evidence(); } catch (error) { evidenceError = error.message; }
    const prepared = await this.decisions.lock(async () => {
      const { state, proof } = this.readState();
      const ledger = this.reconcile(state, { now, timezone, trigger, items: evidence?.items });
      let chosen = [], status = null;
      if (gate && evidence && state.settings.automatic) {
        status = state.settings.automatic === true && validCap(state.settings.cap)
          ? await this.gate.status('automatic') : { open: false, reason: 'Choose a valid automatic revisit setting and request cap.' };
        if (status.open) chosen = this.prepare(state, ledger, { mode: 'automatic', now, status, run });
      }
      const pending = state.candidates.filter(candidate => candidate.status === 'pending').length;
      state.lastRun = {
        run, at: now, trigger, sent: 0, pending, cap: state.settings.cap,
        status: evidenceError ? 'evidence unavailable' : !state.settings.automatic ? 'automatic checks off' : status && !status.open ? 'gate closed' : 'complete',
        message: evidenceError ? `Evidence could not be read: ${evidenceError}` : !state.settings.automatic ? 'Automatic gate checks are off. Candidates stay pending until you enable them or send a reviewed package.' : status && !status.open ? status.reason : `${chosen.length} gate request(s) prepared.`
      };
      await this.writeState(state, proof);
      return { chosen, status };
    });
    if (prepared.chosen.length) {
      const { results, stop } = await this.send(prepared.chosen, 'automatic', prepared.status);
      await this.decisions.lock(async () => {
        const { state, proof } = this.readState();
        const raised = this.apply(state, results, now);
        if (state.lastRun?.run === run) Object.assign(state.lastRun, {
          status: stop ? 'stopped' : 'complete', raised, sent: results.filter(result => !result.skipped && !result.beforeSend).length,
          pending: state.candidates.filter(candidate => candidate.status === 'pending').length,
          message: stop ? `Gate run stopped: ${stop} Remaining candidates stay pending.` : `${results.filter(r => !r.skipped).length} gate request(s) finished; ${raised} notice(s) raised.`
        });
        await this.writeState(state, proof);
      });
    }
    return this.decisions.lock(async () => {
      const { state } = this.readState();
      return { lastRun: state.lastRun, open: state.notices.filter(notice => notice.status === 'open').length };
    });
  }
  // Read-only view for the Revisit list. It never reads the corpus or calls the gate.
  async view() {
    const gate = async () => ({ automatic: await this.gate.status('automatic'), manual: await this.gate.status('manual') });
    if (!this.decisions.decisionDirectories().length && !local.existsSync(this.file)) {
      return { settings: emptyState().settings, lastRun: null, issues: [], decisions: [], notices: [], notRaised: [], pending: [], other: [], events: [], gate: await gate() };
    }
    const result = await this.decisions.lock(async () => {
      const { state } = this.readState();
      const ledger = this.decisions.load();
      const present = state.presentKeys ? new Set(state.presentKeys) : null;
      const decisions = ledger.decisions.map(decision => ({
        id: decision.id, latest: decision.latest, blocked: decision.blocked,
        versions: decision.versions.map(version => ({ version: version.record.version, savedAt: version.record.saved_at, state: version.record.state, file: version.file, content: version.content, current: version.record.version === decision.latest.version })),
        warnings: present ? decision.latest.relied_on.filter(ref => !present.has(ref.key)).map(ref => `Missing reference: ${ref.title} (${ref.key}) is removed or unavailable. The decision is unchanged.`) : [],
        draft: this.decisions.draftFrom(decision.latest)
      }));
      // Attach each recorded package so every request stays inspectable from the list.
      const shown = candidates => candidates.map(candidate => ({ ...candidate, attempts: candidate.attempts.map(attempt => ({ ...attempt, package: this.readPackage(attempt) ?? 'Package file is missing or changed.' })) })).reverse();
      return {
        settings: state.settings, lastRun: state.lastRun, issues: ledger.issues, decisions,
        notices: state.notices.slice().reverse(),
        notRaised: shown(state.candidates.filter(candidate => ['does not meet', 'cannot tell'].includes(candidate.status))),
        pending: shown(state.candidates.filter(candidate => open(candidate.status))),
        other: shown(state.candidates.filter(candidate => ['withdrawn', 'duplicate'].includes(candidate.status))),
        events: state.events.slice(-50).reverse()
      };
    });
    return { ...result, gate: await gate() };
  }
  async settings({ automatic, cap, now }) {
    if (typeof automatic !== 'boolean') throw Error('Choose whether automatic revisit checks are on.');
    if (!validCap(cap)) throw Error('The automatic gate cap must be a whole number from 1 to 100.');
    return this.decisions.lock(async () => {
      const { state, proof } = this.readState();
      state.settings = { automatic, cap, changedAt: now };
      await this.writeState(state, proof);
      return state.settings;
    });
  }
  // Grants one more automatic attempt to a held candidate (D46-I08).
  async retry({ candidate: id, now }) {
    return this.decisions.lock(async () => {
      const { state, proof } = this.readState();
      const candidate = state.candidates.find(item => item.id === id);
      if (!candidate || !['held', 'held-oversize'].includes(candidate.status)) throw Error('This candidate is not held for retry.');
      if (candidate.status === 'held-oversize') throw Error('An oversized package can only be checked manually after you review it.');
      Object.assign(candidate, { status: 'pending', retryGrantedAt: now, retryAfterFailures: this.failedAttempts(candidate), heldReason: null });
      await this.writeState(state, proof);
      return true;
    });
  }
  // D46-I03: while automatic checks are off, the user may review and send one package.
  async previewPackage({ candidate: id }) {
    return this.decisions.lock(async () => {
      const { state } = this.readState();
      const ledger = this.decisions.load();
      const candidate = state.candidates.find(item => item.id === id);
      if (!candidate || !['pending', 'held', 'held-oversize'].includes(candidate.status)) throw Error('This candidate is not waiting for a gate check.');
      const text = this.packageFor(state, ledger, candidate);
      const status = await this.gate.status('manual'), limit = status.limit ?? packageLimit;
      return { candidate: id, text, length: codePoints(text), limit, binding: status.binding, blocked: !status.open || codePoints(text) > limit };
    });
  }
  async sendReviewed({ candidate: id, text: reviewed, binding, now }) {
    const status = await this.gate.status('manual');
    if (!status.open) throw Error(status.reason);
    if (binding !== status.binding) throw Error('Revisit gate evidence changed. Preview again.');
    const run = randomUUID();
    activeRuns.add(run);
    try { return await this.sendReviewedRun({ id, reviewed, now, status, run }); }
    finally { activeRuns.delete(run); }
  }
  async sendReviewedRun({ id, reviewed, now, status, run }) {
    const chosen = await this.decisions.lock(async () => {
      const { state, proof } = this.readState();
      const ledger = this.decisions.load();
      const candidate = state.candidates.find(item => item.id === id);
      if (!candidate || !['pending', 'held', 'held-oversize'].includes(candidate.status)) throw Error('This candidate is not waiting for a gate check.');
      candidate.status = 'pending';
      const prepared = this.prepare(state, ledger, { mode: 'manual', only: id, now, status, run });
      if (prepared[0]?.text !== reviewed) throw Error('The gate package changed since your review. Preview it again.');
      await this.writeState(state, proof);
      return prepared;
    });
    const { results } = await this.send(chosen, 'manual', status);
    return this.decisions.lock(async () => {
      const { state, proof } = this.readState();
      this.apply(state, results, now);
      await this.writeState(state, proof);
      const candidate = state.candidates.find(item => item.id === id);
      const attempt = candidate.attempts.at(-1);
      return { status: candidate.status, outcome: attempt.outcome || null, error: attempt.error || null };
    });
  }
  // Saving or resolving a decision: one previewed version, plus record bookkeeping, under
  // the shared lock. Evidence present at save time is marked seen so it cannot fire later.
  async publishDecision(record, expectedVersion, { now, noticeId }) {
    let items = null;
    try { items = (await this.evidence()).items; } catch {}
    return this.decisions.lock(async () => {
      const { state, proof } = this.readState();
      if (noticeId) {
        const notice = state.notices.find(item => item.id === noticeId);
        if (!notice || !['open', 'evidence removed'].includes(notice.status)) throw Error('This notice is no longer open. Refresh the Revisit list.');
        if (notice.decision.id !== record.decision_id) throw Error('This notice belongs to a different decision.');
      }
      const published = await this.decisions.publish(record, expectedVersion);
      // A shorter version may now fit the package limit; check those candidates again.
      for (const candidate of state.candidates) if (candidate.status === 'held-oversize' && candidate.decision.id === record.decision_id) Object.assign(candidate, { status: 'pending', heldReason: null });
      if (items) { this.sweep(state, items, now); state.presentKeys = [...new Set(items.map(item => item.key))].sort(); }
      this.reconcileResolutions(state, this.decisions.load());
      await this.writeState(state, proof);
      return published;
    });
  }
}
// Read-only rows for a capture deletion preview (D49-I03). Never takes a lock or writes.
function revisitDependents(vault, captureId) {
  const key = `capture:${captureId}`, rows = [], rel = file => path.relative(vault.vault, file).split(path.sep).join('/');
  const decisions = new Decisions(vault);
  if (!decisions.decisionDirectories().length) return rows;
  try {
    for (const decision of decisions.load().decisions) {
      const latest = decision.latest, file = rel(decision.versions.at(-1).file);
      if (latest.relied_on.some(ref => ref.key === key)) rows.push({ kind: 'decision', file, id: latest.decision_id, attribution: 'affected', text: `Decision "${latest.title}" relies on this capture. The decision note is not changed; it will show a missing-reference warning.` });
      for (const condition of latest.conditions) if (condition.links.includes(key)) rows.push({ kind: 'decision', file, id: latest.decision_id, attribution: 'affected', text: `Revisit condition "${condition.label}" links this capture. The link stays in the note but can no longer match it.` });
    }
    const file = path.join(vault.root, '.revisit', 'state.json');
    if (local.existsSync(file)) {
      const state = JSON.parse(local.readFileSync(file, 'utf8'));
      for (const notice of state.notices || []) if (notice.evidence?.key === key && notice.status === 'open') rows.push({ kind: 'revisit notice', file: rel(file), id: notice.id, attribution: 'affected', text: `Open revisit notice for "${notice.decision.title}" will be marked "evidence removed". It is not resolved for you.` });
      for (const candidate of state.candidates || []) if (candidate.evidence?.key === key && open(candidate.status)) rows.push({ kind: 'revisit candidate', file: rel(file), id: candidate.id, attribution: 'affected', text: `Pending revisit candidate for "${candidate.decision.title}" will be withdrawn and never sent to the gate.` });
    }
  } catch (error) {
    rows.push({ kind: 'decision', file: rel(decisions.directory), id: null, attribution: 'unknown', text: `Decision dependencies could not be read: ${error.message} Decision notes are never changed by deletion.` });
  }
  return rows;
}
module.exports = { Revisit, revisitDependents, localDate, evidenceId, maxAttempts };
