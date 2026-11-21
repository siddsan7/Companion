// D51-I05: plays one replay timeline through the real desktop app and files. Each
// timeline gets a fresh disposable test root and vault. Returns per-step raw records
// with system identities mapped back to fixture labels.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { documentSearch } = require('../app/revisit-replay');

const appRoot = path.join(__dirname, '..');
const timezone = 'America/Phoenix';

async function runTimeline(timeline, { electron, gate = null, automatic = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-replay-'));
  const base = path.join(root, 'vault', 'Companion');
  const clock = at => fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: at, timezone }));
  const readState = async () => { try { return JSON.parse(await fs.readFile(path.join(base, '.revisit', 'state.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  await clock(timeline.steps[0].at);
  if (gate) await fs.writeFile(path.join(root, 'revisit-gate.json'), JSON.stringify(gate));
  const app = await electron.launch({ args: [appRoot], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  const records = [];
  try {
    const page = await app.firstWindow();
    const status = page.getByRole('status');
    const waitStatus = async text => {
      for (let tries = 0; tries < 200; tries++) { if ((await status.textContent()).includes(text)) return; await page.waitForTimeout(25); }
      throw Error(`Timed out waiting for status "${text}"; saw "${await status.textContent()}".`);
    };
    const clearStatus = () => status.evaluate(node => { node.textContent = ''; });
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await waitStatus('Vault ready.'); await clearStatus();
    const call = (name, data) => page.evaluate(([channel, input]) => window.decisions[channel](input), [name, data]);
    if (automatic) await call('revisit-settings', { automatic: true, cap: 100 });
    const decisions = new Map(), decisionRefs = new Map(), conditionRefs = new Map(), evidenceRefs = new Map(), evidenceKeys = new Map();
    const drafts = new Map();
    const view = () => call('decision-view');
    async function saveDraft(ref, draft, resolution) {
      const id = decisions.get(ref) || null, current = id ? (await view()).decisions.find(item => item.id === id) : null;
      const preview = await call('decision-preview', { id, expectedVersion: current?.latest.version || 0, draft, resolution });
      const saved = await call('decision-confirm', { previewId: preview.previewId });
      decisions.set(ref, saved.decisionId); decisionRefs.set(saved.decisionId, ref);
      const latest = (await view()).decisions.find(item => item.id === saved.decisionId).latest;
      return latest;
    }
    const toDraft = (draft, latest) => ({
      title: draft.title, project: 'MyTune', choice: draft.choice, reasons: draft.reasons || [], alternatives: draft.alternatives || [], reliedOn: [], state: draft.state || 'active',
      conditions: draft.conditions.map(condition => ({
        ...(latest ? { id: latest.conditions.find(item => item.label === condition.label).id } : {}),
        kind: condition.kind, label: condition.label, trigger: condition.trigger, action: condition.action,
        cueTerms: condition.cueTerms, links: [], reviewBy: condition.reviewBy, state: condition.state || 'active'
      }))
    });
    const mapNotice = notice => ({
      decision: decisionRefs.get(notice.decision.id), condition: conditionRefs.get(notice.condition.id), conditionVersion: notice.condition.version,
      evidence: notice.evidence.clock ? `clock:${notice.evidence.clock}` : evidenceRefs.get(`${notice.evidence.key}#${notice.evidence.digest}`) || `unlabelled:${notice.evidence.key}`
    });
    for (const step of timeline.steps) {
      await clock(step.at);
      const before = await readState(), noticeIds = new Set((before?.notices || []).map(n => n.id)), candidateIds = new Set((before?.candidates || []).map(c => c.id));
      const eventIds = new Set((before?.events || []).map(e => e.id));
      let baseline = [];
      if (step.type === 'decision' || step.type === 'edit-condition' || step.type === 'withdraw') {
        if (step.type === 'decision') drafts.set(step.decision, structuredClone(step.draft));
        const draft = drafts.get(step.decision);
        if (step.type === 'edit-condition') Object.assign(draft.conditions.find(condition => condition.ref === step.condition), step.changes);
        if (step.type === 'withdraw') draft.state = 'withdrawn';
        const id = decisions.get(step.decision), current = id ? (await view()).decisions.find(item => item.id === id).latest : null;
        const latest = await saveDraft(step.decision, toDraft(draft, current));
        for (const condition of draft.conditions) conditionRefs.set(latest.conditions.find(item => item.label === condition.label).id, condition.ref);
      }
      if (step.type === 'evidence') {
        await page.getByLabel('Thought or link').fill(step.text);
        await page.getByRole('button', { name: 'Save capture', exact: true }).click();
        await waitStatus('Capture saved.'); await clearStatus();
        const state = await readState();
        const event = state.events.find(item => !eventIds.has(item.id) && !evidenceKeys.has(item.evidence.key));
        if (!event) throw Error(`${step.id}: no evidence event was recorded for the capture.`);
        evidenceRefs.set(`${event.evidence.key}#${event.evidence.digest}`, step.evidence); evidenceKeys.set(event.evidence.key, step.evidence);
        // Baseline: search the decision notes as they are on disk at this moment.
        const notes = [];
        for (const [ref, id] of decisions) {
          const directory = path.join(base, 'Decisions', id), names = (await fs.readdir(directory)).filter(name => /^version-\d+\.md$/.test(name));
          const latestVersion = Math.max(...names.map(name => Number(name.match(/\d+/)[0])));
          for (const name of names) notes.push({ decision: ref, version: Number(name.match(/\d+/)[0]), latest: Number(name.match(/\d+/)[0]) === latestVersion, text: await fs.readFile(path.join(directory, name), 'utf8') });
        }
        baseline = documentSearch(notes, step.text).map(hit => ({ decision: hit.decision, condition: null, conditionVersion: null, evidence: step.evidence, matchedVersion: hit.matchedVersion, shared: hit.shared }));
        if (step.deleteAfter) {
          await page.locator('#captures article', { hasText: step.text }).getByRole('button', { name: 'Delete capture', exact: true }).click();
          await page.getByLabel('Capture deletion preview').getByRole('button', { name: 'Confirm capture deletion', exact: true }).click();
          await waitStatus('Capture deleted'); await clearStatus();
        }
      }
      if (step.type === 'advance') {
        await page.getByRole('button', { name: 'Check decisions now', exact: true }).click();
        await waitStatus('Revisit check:'); await clearStatus();
      }
      const after = await readState();
      // A notice whose evidence was removed in the same step does not exist after it.
      const notices = (after?.notices || []).filter(notice => !noticeIds.has(notice.id) && notice.status !== 'evidence removed').map(mapNotice);
      const candidates = (after?.candidates || []).filter(candidate => !candidateIds.has(candidate.id)).map(candidate => ({
        decision: decisionRefs.get(candidate.decision.id), condition: conditionRefs.get(candidate.condition.id), conditionVersion: candidate.condition.version,
        evidence: evidenceRefs.get(`${candidate.evidence.key}#${candidate.evidence.digest}`), status: candidate.status, reasons: candidate.reasons
      }));
      const events = (after?.events || []).filter(event => !eventIds.has(event.id)).map(event => ({ evidence: evidenceKeys.get(event.evidence.key), outcome: event.outcome, considered: event.considered }));
      records.push({ step: step.id, type: step.type, notices, candidates, events, baseline });
    }
    // Candidate status can change after the step that created it (gate replies, removal).
    const final = await readState();
    return { records, finalCandidates: (final?.candidates || []).map(candidate => ({ condition: conditionRefs.get(candidate.condition.id), conditionVersion: candidate.condition.version, decision: decisionRefs.get(candidate.decision.id), evidence: evidenceRefs.get(`${candidate.evidence.key}#${candidate.evidence.digest}`), status: candidate.status })) };
  } finally {
    await app.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
module.exports = { runTimeline };
