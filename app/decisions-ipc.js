const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Revisit } = require('./revisit');
const { markdown } = require('./decisions');
const { ControlledGate, ProductionGate } = require('./revisit-gate');

// Desktop entry points for the decision ledger and revisit notices. Every decision write
// is an explicit, previewed save (D41-I04, D48-I02); nothing here writes a decision on
// its own.
// orderEvidence queues corpus reads behind capture and intake requests for the same
// vault: reading the corpus holds the intake source lock, and intake refuses to start
// while it is held.
function installDecisions({ ipcMain, getVault, getContext, orderEvidence, clock, checkpoint, testRoot, provider, getEvidence }) {
  const gate = testRoot ? new ControlledGate(testRoot) : new ProductionGate({ provider, getEvidence });
  const previews = new Map();
  const selected = () => { const vault = getVault(); if (!vault) throw Error('Choose a vault first.'); return vault; };
  const corpus = target => orderEvidence(target, async () => (await getContext(target)).corpus());
  const revisitFor = vault => new Revisit(vault, { getEvidence: corpus, gate, checkpoint });
  const now = () => clock();

  function remember(vault, record, expectedVersion, noticeId) {
    const id = randomUUID(), content = markdown(record);
    previews.set(id, { vault, record, expectedVersion, noticeId });
    return {
      previewId: id, version: record.version, decisionId: record.decision_id, content,
      destination: path.relative(vault.vault, path.join(vault.root, 'Decisions', record.decision_id, `version-${record.version}.md`))
    };
  }
  function latestOf(revisit, id) {
    const decision = revisit.decisions.load().decisions.find(item => item.id === id);
    if (!decision) throw Error('This decision is unavailable. Refresh the decision list.');
    if (decision.blocked) throw Error('This decision has a damaged or missing version. Repair it before saving a new version.');
    return decision.latest;
  }

  ipcMain.handle('decision-view', async () => {
    const vault = getVault();
    if (!vault) return null;
    return revisitFor(vault).view();
  });
  ipcMain.handle('decision-sources', async () => {
    const sources = await corpus(selected());
    return sources.all.filter(item => /^(?:capture|annotation|idea|brief):/.test(item.key))
      .map(item => ({ key: item.key, digest: item.digest, title: item.title, revisionId: item.revisionId || null }));
  });
  const noticeEvidence = notice => notice.kind === 'due' ? `review-by date ${notice.evidence.clock}` : `${notice.evidence.key} sha256 ${notice.evidence.digest}`;
  const findNotice = (revisit, noticeId) => revisit.decisions.lock(async () => revisit.readState().state.notices.find(item => item.id === noticeId));
  ipcMain.handle('decision-preview', async (_, { id, expectedVersion, draft, resolution }) => {
    const vault = selected(), revisit = revisitFor(vault), at = now().now;
    const current = id ? latestOf(revisit, id) : null;
    if ((current?.version || 0) !== expectedVersion) throw Error('This decision changed since you opened it. Reload it before saving.');
    // Revising from a notice records that notice's evidence in the new version.
    const notice = resolution ? await findNotice(revisit, resolution.noticeId) : null;
    if (resolution && (!notice || notice.decision.id !== id)) throw Error('This notice is unavailable for this decision. Refresh the Revisit list.');
    const record = revisit.decisions.build({ ...draft, resolution: resolution && { noticeId: resolution.noticeId, reason: resolution.reason, action: 'revise', evidence: noticeEvidence(notice) } }, current, at);
    return remember(vault, record, expectedVersion, resolution?.noticeId);
  });
  // Reaffirm, withdraw and dismiss build the next version directly from the latest one.
  // Revise goes through the editor with the notice attached.
  ipcMain.handle('decision-resolve-preview', async (_, { noticeId, action, reason }) => {
    if (!['reaffirm', 'withdraw', 'dismiss'].includes(action)) throw Error('Choose reaffirm, withdraw or dismiss, or revise the decision in the editor.');
    const vault = selected(), revisit = revisitFor(vault), at = now().now;
    const notice = await findNotice(revisit, noticeId);
    if (!notice || !['open', 'evidence removed'].includes(notice.status)) throw Error('This notice is no longer open. Refresh the Revisit list.');
    const current = latestOf(revisit, notice.decision.id), draft = revisit.decisions.draftFrom(current);
    if (action === 'withdraw') draft.state = 'withdrawn';
    // A time-based condition that has been reviewed is met; a changed date belongs in revise.
    else if (notice.kind === 'due') draft.conditions = draft.conditions.map(condition => condition.id === notice.condition.id ? { ...condition, state: 'met' } : condition);
    const record = revisit.decisions.build({ ...draft, resolution: { noticeId, action, reason, evidence: noticeEvidence(notice) } }, current, at);
    return remember(vault, record, current.version, noticeId);
  });
  ipcMain.handle('decision-confirm', async (_, { previewId }) => {
    const preview = previews.get(previewId);
    if (!preview) throw Error('Preview the decision again before saving.');
    if (preview.vault !== getVault()) throw Error('Vault selection changed. Preview the decision again.');
    const revisit = revisitFor(preview.vault);
    const published = await revisit.publishDecision(preview.record, preview.expectedVersion, { now: now().now, noticeId: preview.noticeId });
    previews.delete(previewId);
    return { file: published.file, version: preview.record.version, decisionId: preview.record.decision_id };
  });
  ipcMain.handle('revisit-check', async () => {
    const { now: at, timezone } = now();
    return revisitFor(selected()).check({ now: at, timezone, trigger: 'manual' });
  });
  ipcMain.handle('revisit-settings', async (_, { automatic, cap }) => revisitFor(selected()).settings({ automatic, cap, now: now().now }));
  ipcMain.handle('revisit-retry', async (_, { candidate }) => revisitFor(selected()).retry({ candidate, now: now().now }));
  ipcMain.handle('revisit-package', async (_, { candidate }) => revisitFor(selected()).previewPackage({ candidate }));
  ipcMain.handle('revisit-send', async (_, { candidate, text }) => revisitFor(selected()).sendReviewed({ candidate, text, now: now().now }));

  // Runs after capture or intake has finished and released its lock. Failures never fail
  // the capture or intake that triggered them; they show in the Revisit status instead.
  async function afterEvidence(vault, trigger) {
    if (!vault) return;
    const { now: at, timezone } = now();
    try { await revisitFor(vault).check({ now: at, timezone, trigger }); }
    catch (error) { console.error(`Revisit check after ${trigger}:`, error.message); }
  }
  return { afterEvidence };
}
module.exports = { installDecisions };
