const { createHash } = require('node:crypto');

// D51-D55: fixture validation, scoring and error attribution for the revisit replay.
// Pure functions over fixture labels and recorded notices; no model, no files.
const triggerKinds = ['trigger:cue', 'trigger:paraphrase', 'trigger:time'];
const nearMissKinds = ['near-miss:same-topic', 'near-miss:opposite', 'near-miss:superseded', 'near-miss:withdrawn', 'near-miss:deleted', 'near-miss:repeat'];
const staleKinds = new Set(['near-miss:superseded', 'near-miss:withdrawn', 'near-miss:deleted']);
const stepTypes = ['decision', 'edit-condition', 'withdraw', 'evidence', 'advance'];
const key = entry => `${entry.decision}|${entry.condition}@${entry.conditionVersion}|${entry.evidence}`;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  return JSON.stringify(value);
}
const fixtureHash = fixture => createHash('sha256').update(canonical(fixture)).digest('hex');

// Structural checks plus the D52-I03 minimums. Throws with every problem found.
function validateFixture(fixture) {
  const problems = [];
  if (fixture?.fixture !== 'revisit-replay' || !Number.isSafeInteger(fixture.version) || !Array.isArray(fixture.timelines)) throw Error('Not a revisit replay fixture.');
  const ids = new Set();
  let triggers = 0, nearMisses = 0, negatives = 0;
  for (const timeline of fixture.timelines) {
    if (!timeline.id || ids.has(timeline.id)) problems.push(`Timeline id missing or repeated: ${timeline.id}`);
    ids.add(timeline.id);
    if (timeline.negative) negatives++;
    const decisions = new Map(), evidence = new Set();
    let at = '';
    for (const step of timeline.steps) {
      const where = `${timeline.id}/${step.id}`;
      if (!step.id || ids.has(step.id)) problems.push(`Step id missing or repeated: ${where}`);
      ids.add(step.id);
      if (!stepTypes.includes(step.type)) problems.push(`${where}: unknown step type ${step.type}`);
      if (typeof step.at !== 'string' || step.at < at) problems.push(`${where}: step time must not go backwards`);
      at = step.at;
      if (!Array.isArray(step.due)) problems.push(`${where}: due set is required (use [] for silence)`);
      if (step.type === 'decision') {
        if (decisions.has(step.decision)) problems.push(`${where}: decision ${step.decision} created twice`);
        decisions.set(step.decision, new Map((step.draft.conditions || []).map(condition => [condition.ref, 1])));
      }
      if (step.type === 'advance') triggers += (step.meets || []).length;
      if (step.type === 'edit-condition') {
        const conditions = decisions.get(step.decision);
        if (!conditions?.has(step.condition)) problems.push(`${where}: unknown condition ${step.condition}`);
        else conditions.set(step.condition, conditions.get(step.condition) + 1);
      }
      if (step.type === 'evidence') {
        if (evidence.has(step.evidence)) problems.push(`${where}: evidence ${step.evidence} repeated (repeats need their own label)`);
        evidence.add(step.evidence);
        if (![...triggerKinds, ...nearMissKinds, 'unrelated'].includes(step.kind)) problems.push(`${where}: unknown evidence kind ${step.kind}`);
        if (step.kind.startsWith('trigger:')) triggers++;
        if (step.kind.startsWith('near-miss:')) nearMisses++;
        if (step.kind === 'near-miss:repeat' && !timeline.steps.some(other => other.evidence === step.repeats)) problems.push(`${where}: repeat must name the earlier evidence it repeats`);
        if (!Array.isArray(step.relevant)) problems.push(`${where}: relevant conditions are required`);
      }
      for (const entry of step.due || []) {
        const version = decisions.get(entry.decision)?.get(entry.condition);
        if (!version) problems.push(`${where}: due entry names unknown condition ${entry.decision}/${entry.condition}`);
        else if (entry.conditionVersion > version) problems.push(`${where}: due entry names condition version ${entry.conditionVersion} before it exists`);
      }
      if (timeline.negative && step.due?.length) problems.push(`${where}: a negative timeline must have empty due sets`);
    }
  }
  if (negatives < 2) problems.push('At least two negative timelines are required (D52-I03).');
  if (nearMisses < triggers) problems.push(`At least one near miss per true trigger is required (D52-I03): ${triggers} triggers, ${nearMisses} near misses.`);
  if (problems.length) throw Error(`Fixture validation failed:\n- ${problems.join('\n- ')}`);
  return { triggers, nearMisses, negatives };
}

// Annotates every step with what each label implies, for scoring and attribution.
function labelSteps(timeline) {
  const kinds = new Map(), versions = new Map(), edited = new Set();
  let previous = [];
  return timeline.steps.map(step => {
    if (step.type === 'decision') for (const condition of step.draft.conditions || []) versions.set(`${step.decision}/${condition.ref}`, 1);
    if (step.type === 'edit-condition') { const name = `${step.decision}/${step.condition}`; versions.set(name, versions.get(name) + 1); edited.add(name); }
    if (step.type === 'evidence') kinds.set(step.evidence, step.kind);
    const before = new Set(previous.map(key)), added = step.due.filter(entry => !before.has(key(entry)));
    const labelled = added.map(entry => ({ ...entry, kind: entry.evidence.startsWith('clock:') ? 'trigger:time' : kinds.get(entry.evidence), updated: edited.has(`${entry.decision}/${entry.condition}`) }));
    previous = step.due;
    return { step, added: labelled, kinds: new Map(kinds), versions: new Map(versions) };
  });
}

// D51-I04: notices driven from the per-evidence labels, independently of the due sets.
// A correct fixture scores 100% against its own due sets.
function perfectAnswers(timeline) {
  const versions = new Map();
  return timeline.steps.map(step => {
    if (step.type === 'decision') for (const condition of step.draft.conditions || []) versions.set(`${step.decision}/${condition.ref}`, 1);
    if (step.type === 'edit-condition') { const name = `${step.decision}/${step.condition}`; versions.set(name, versions.get(name) + 1); }
    // Evidence steps name the conditions they meet; advance steps name the time
    // conditions whose review-by date they pass.
    return (step.meets || []).map(item => {
      const ref = typeof item === 'string' ? item : item.condition, [decision, condition] = ref.split('/');
      return { decision, condition, conditionVersion: versions.get(ref), evidence: step.type === 'advance' ? `clock:${item.reviewBy}` : step.evidence };
    });
  });
}
// D53 "labelled evidence, notify on any match": every labelled relevant condition is
// notified. No retrieval error, no gate.
function labelledMatch(timeline) {
  const versions = new Map();
  return timeline.steps.map(step => {
    if (step.type === 'decision') for (const condition of step.draft.conditions || []) versions.set(`${step.decision}/${condition.ref}`, 1);
    if (step.type === 'edit-condition') { const name = `${step.decision}/${step.condition}`; versions.set(name, versions.get(name) + 1); }
    // A passed review-by date is its own labelled evidence; no retrieval is involved.
    if (step.type === 'advance') return (step.meets || []).map(item => { const [decision, condition] = item.condition.split('/'); return { decision, condition, conditionVersion: versions.get(item.condition), evidence: `clock:${item.reviewBy}` }; });
    if (step.type !== 'evidence') return [];
    return step.relevant.map(ref => { const [decision, condition] = ref.split('/'); return { decision, condition, conditionVersion: versions.get(ref), evidence: step.evidence }; });
  });
}

// D54: per-step comparison of newly raised notices with newly due notices.
// raised[timelineIndex][stepIndex] = notices first raised in that step. A notice with a
// null condition (document search) matches any due entry for the same decision and
// evidence.
function score(fixture, raised, { attribute } = {}) {
  const totals = { tp: 0, fp: 0, fn: 0, repeats: 0 }, byKind = {}, errors = [];
  let updatedDue = 0, updatedHit = 0, negativeFired = 0, negatives = 0;
  const bump = (kind, field) => { byKind[kind] ||= { tp: 0, fp: 0, fn: 0 }; byKind[kind][field]++; };
  fixture.timelines.forEach((timeline, t) => {
    if (timeline.negative) negatives++;
    let fired = false;
    const seen = new Set();
    labelSteps(timeline).forEach(({ step, added, kinds }, s) => {
      const notices = raised[t]?.[s] || [], open = added.map(entry => ({ entry, matched: false }));
      for (const notice of notices) {
        fired = true;
        const exact = notice.condition ? key(notice) : `${notice.decision}|*|${notice.evidence}`;
        if (seen.has(exact)) { totals.fp++; totals.repeats++; errors.push({ timeline: timeline.id, step: step.id, type: 'repeat', notice }); continue; }
        seen.add(exact);
        const due = open.find(item => !item.matched && item.entry.decision === notice.decision && item.entry.evidence === notice.evidence &&
          (!notice.condition || item.entry.condition === notice.condition && item.entry.conditionVersion === notice.conditionVersion));
        if (due) { due.matched = true; totals.tp++; bump(due.entry.kind, 'tp'); if (due.entry.updated) updatedHit++; continue; }
        totals.fp++;
        const kind = notice.evidence.startsWith('clock:') ? 'trigger:time' : kinds.get(notice.evidence) || 'unrelated';
        bump(kind, 'fp');
        const type = kind === 'near-miss:repeat' ? 'repeat' : staleKinds.has(kind) || notice.stale ? 'stale-state error' : attribute?.falseAlarm || 'gate false alarm';
        if (type === 'repeat') totals.repeats++;
        errors.push({ timeline: timeline.id, step: step.id, type, kind, notice });
      }
      for (const item of open) {
        if (item.entry.updated) updatedDue++;
        if (item.matched) continue;
        totals.fn++; bump(item.entry.kind, 'fn');
        errors.push({ timeline: timeline.id, step: step.id, type: attribute?.miss ? attribute.miss(item.entry, t) : 'miss', kind: item.entry.kind, due: item.entry });
      }
    });
    if (timeline.negative && fired) negativeFired++;
  });
  const { tp, fp, fn } = totals;
  return {
    ...totals,
    setF1: tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 1,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    updateHitRate: updatedDue ? updatedHit / updatedDue : null, updatedDue,
    falseTriggerRate: negatives ? negativeFired / negatives : null, negatives,
    byKind, errors
  };
}

// D53-I02: the document-search baseline. For one evidence text, every decision whose
// notes (any version, no state) share at least two distinctive words in one paragraph
// is notified. It knows nothing about conditions, versions, removal or history.
const stopwords = new Set(['about', 'after', 'again', 'also', 'among', 'because', 'before', 'being', 'between', 'could', 'decision', 'every', 'from', 'have', 'into', 'more', 'most', 'none', 'only', 'other', 'over', 'reports', 'should', 'some', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'version', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'capture', 'state', 'active', 'reasons', 'choice', 'project', 'condition', 'action', 'trigger', 'recorded', 'alternatives', 'rejected', 'revisit', 'conditions', 'sources', 'linked', 'terms', 'evidence', 'based', 'kind']);
const terms = text => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word.length >= 4 && !stopwords.has(word)))];
function documentSearch(notes, evidenceText) {
  const wanted = terms(evidenceText), hits = new Map();
  for (const note of notes) {
    const body = note.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    for (const paragraph of body.split(/\n\s*\n/)) {
      const words = new Set(terms(paragraph)), shared = wanted.filter(word => words.has(word));
      if (shared.length >= 2 && !hits.has(note.decision)) hits.set(note.decision, { decision: note.decision, matchedVersion: note.version, latest: note.latest, shared });
    }
  }
  return [...hits.values()];
}

module.exports = { validateFixture, fixtureHash, labelSteps, perfectAnswers, labelledMatch, score, documentSearch, triggerKinds, nearMissKinds, key };
