// D53 "labelled evidence, gate decides": the gate measured alone. Every labelled
// relevant condition is sent to the gate with the production package builder and reply
// parser, so retrieval errors cannot occur. Review-by dates need no model and are
// notified from the labels, as in the proposed system.
const { buildPackage, parseReply } = require('../../app/revisit-gate');

// judge(text) -> { reply, ... }. Calls run in fixture order because each package carries
// the earlier outcomes for its condition.
async function labelledGate(fixture, judge, { onCall } = {}) {
  const raised = [], calls = [];
  for (const timeline of fixture.timelines) {
    const drafts = new Map(), versions = new Map(), history = new Map(), steps = [];
    for (const step of timeline.steps) {
      const notices = [];
      if (step.type === 'decision') {
        drafts.set(step.decision, structuredClone(step.draft));
        for (const condition of step.draft.conditions || []) versions.set(`${step.decision}/${condition.ref}`, 1);
      }
      if (step.type === 'edit-condition') {
        Object.assign(drafts.get(step.decision).conditions.find(condition => condition.ref === step.condition), step.changes);
        const name = `${step.decision}/${step.condition}`; versions.set(name, versions.get(name) + 1);
      }
      if (step.type === 'withdraw') drafts.get(step.decision).state = 'withdrawn';
      if (step.type === 'advance') for (const item of step.meets || []) {
        const [decision, condition] = item.condition.split('/');
        notices.push({ decision, condition, conditionVersion: versions.get(item.condition), evidence: `clock:${item.reviewBy}` });
      }
      if (step.type === 'evidence') for (const ref of step.relevant) {
        const [decisionRef, conditionRef] = ref.split('/'), draft = drafts.get(decisionRef);
        const condition = draft.conditions.find(item => item.ref === conditionRef);
        const passages = [{ start: 1, end: 1, text: step.text }];
        const text = buildPackage({
          decision: { title: draft.title, choice: draft.choice, reasons: draft.reasons || [] },
          condition: { label: condition.label, trigger: condition.trigger, action: condition.action },
          candidate: { evidence: { title: `${step.evidence}.md`, provenance: 'Authored fixture capture (synthetic).' }, passages },
          history: history.get(ref) || []
        });
        const response = await judge(text);
        let parsed = null, parseError = null;
        try { parsed = parseReply(response.reply, passages); } catch (error) { parseError = error.message; }
        const call = { timeline: timeline.id, step: step.id, condition: ref, conditionVersion: versions.get(ref), evidence: step.evidence, kind: step.kind, text, ...response, parsed, parseError };
        calls.push(call); onCall?.(call);
        if (!parsed) continue;
        history.set(ref, [...(history.get(ref) || []), { at: step.at, outcome: parsed.outcome, passage: step.text }]);
        if (parsed.outcome === 'meets') notices.push({ decision: decisionRef, condition: conditionRef, conditionVersion: versions.get(ref), evidence: step.evidence });
      }
      steps.push(notices);
    }
    raised.push(steps);
  }
  return { raised, calls };
}

// Labels a missed due notice: an unparseable reply is reported apart from a wrong one.
function labelledMissAttribution(calls) {
  return entry => {
    if (entry.evidence.startsWith('clock:')) return 'due check miss';
    const call = calls.find(item => item.evidence === entry.evidence && item.condition === `${entry.decision}/${entry.condition}`);
    if (!call) return 'not sent';
    return call.parseError ? 'invalid gate reply' : 'gate miss';
  };
}

module.exports = { labelledGate, labelledMissAttribution };
