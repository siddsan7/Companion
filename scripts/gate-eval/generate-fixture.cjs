#!/usr/bin/env node
// Asks a Claude model to author a new revisit replay fixture, so the evaluation is not
// only measured on cases written by the developer (D52 author-bias limit). The model
// writes decisions, conditions, evidence and labels; this script derives the cumulative
// due sets from the labels, runs every structural check, and writes the file only when
// all pass. The result must be reviewed by a person and frozen before any scored run.
//   node scripts/gate-eval/generate-fixture.cjs --out tests/fixtures/revisit-replay/fixture-v2.json [--model claude-opus-5-5]
const fs = require('node:fs/promises');
const path = require('node:path');
const replay = require('../../app/revisit-replay');
const { readKey, SpendLedger, costOf } = require('./anthropic-gate.cjs');

const repo = path.join(__dirname, '..', '..');
const example = require('../../tests/fixtures/revisit-replay/fixture-v1.json');
const strip = fixture => ({ ...fixture, timelines: fixture.timelines.map(t => ({ ...t, steps: t.steps.map(({ due, ...step }) => step) })) });

const instructions = `You are writing a test fixture for a "revisit notice" feature. A user records technical decisions. Each decision has revisit conditions: an evidence condition (a trigger sentence plus cue terms) or a time condition (a review-by date). Later the user captures short notes ("evidence"). A notice should be raised only when a captured note actually satisfies a condition's trigger, once per condition version and evidence.

Write a NEW fixture in exactly the JSON format of the example below (the example has had its "due" fields removed; do not write "due" fields). Use different decisions, products and wording from the example; do not reuse its sentences, topics (search, audio decoders, SQLite, sync, reviews, shuffle) or numbers. Decisions are about building software products of your choice.

Requirements:
- 8 timelines: 6 with decisions and evidence ("negative": false) and 2 negative timelines ("negative": true) in which no evidence meets any condition. One negative timeline has a decision with conditions and only unrelated notes; the other has a decision with no conditions (empty "conditions" array) and unrelated notes.
- Step types: "decision" (with "draft"), "edit-condition" (with "changes" to trigger, cueTerms or reviewBy), "withdraw", "evidence" and "advance" (the clock moves past a review-by date). Step "at" times never go backwards. All step and evidence ids are unique across the file. Times are in November and December 2026.
- Every evidence step has "kind", "text", "relevant" (the conditions, as "Decision/Condition" refs, that the note is about and that are still active) and, only for true triggers, "meets" (the refs whose trigger it satisfies).
- Across the file include at least 5 "trigger:cue" (shares cue terms with the condition and satisfies the trigger), at least 4 "trigger:paraphrase" and at least 4 time triggers ("advance" steps whose "meets" lists {"condition": ref, "reviewBy": date}).
- A "trigger:paraphrase" note satisfies the trigger but contains NONE of the condition's cue terms as whole words, case-insensitively. It must report a new, separate observation (different data, incident or measurement) from any earlier note, not restate one.
- At least 2 of each near miss, and at least as many near misses in total as true triggers (time triggers count as triggers): "near-miss:same-topic" (about the condition but does not satisfy it), "near-miss:opposite" (reports the opposite), "near-miss:superseded" (would have satisfied the condition before an earlier "edit-condition" step changed it, but does not satisfy the current version), "near-miss:withdrawn" (would satisfy it, but the decision was withdrawn in an earlier step; "relevant" is []), "near-miss:deleted" (would satisfy it, but has "deleteAfter": true; "relevant" is []), "near-miss:repeat" (identical text to an earlier evidence note in the same timeline, with "repeats" naming that evidence id; "relevant" lists the condition, no "meets").
- At least 3 "unrelated" notes with "relevant": [].
- Conditions use "ref" ids, "kind" ("evidence" or "time"), "label", "trigger", "action", and "cueTerms" (evidence) or "reviewBy" (time, a date). Triggers should be concrete and checkable, often with a threshold.
- An "edit-condition" step increments that condition's version; later "meets" on it refer to the new version automatically.

Return only the JSON object, with "fixture": "revisit-replay", "version": 2, "label", "author" and "timelines". No commentary, no code fences.

Example:
${JSON.stringify(strip(example), null, 1)}`;

// Checks beyond validateFixture that the instructions ask for.
function extraProblems(fixture) {
  const problems = [];
  for (const timeline of fixture.timelines) {
    const drafts = new Map(), texts = new Map();
    for (const step of timeline.steps) {
      if (step.type === 'decision') drafts.set(step.decision, structuredClone(step.draft));
      if (step.type === 'edit-condition') Object.assign(drafts.get(step.decision)?.conditions.find(c => c.ref === step.condition) || {}, step.changes);
      if (step.type !== 'evidence') continue;
      texts.set(step.evidence, step.text);
      if (step.kind === 'trigger:paraphrase') for (const ref of step.meets || []) {
        const [d, c] = ref.split('/'), condition = drafts.get(d)?.conditions.find(item => item.ref === c);
        for (const term of condition?.cueTerms || []) if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(step.text)) problems.push(`${step.id}: paraphrase contains cue term "${term}"`);
      }
      if (['near-miss:withdrawn', 'near-miss:deleted', 'unrelated'].includes(step.kind) && step.relevant.length) problems.push(`${step.id}: ${step.kind} must have no relevant conditions`);
      if (step.kind === 'near-miss:deleted' && step.deleteAfter !== true) problems.push(`${step.id}: deleted near miss needs deleteAfter`);
      if (step.kind === 'near-miss:repeat' && texts.get(step.repeats) !== step.text) problems.push(`${step.id}: repeat text differs from ${step.repeats}`);
      if (!step.kind.startsWith('trigger:') && step.meets?.length) problems.push(`${step.id}: only triggers may have meets`);
      for (const ref of step.meets || []) if (!step.relevant.includes(ref)) problems.push(`${step.id}: meets ${ref} but it is not relevant`);
    }
  }
  return problems;
}

// due at each step = every labelled notice so far (checked to hold for fixture v1).
function withDue(fixture) {
  for (const timeline of fixture.timelines) {
    const perfect = replay.perfectAnswers(timeline);
    let due = [];
    timeline.steps.forEach((step, index) => { due = [...due, ...perfect[index]]; step.due = due.map(entry => ({ ...entry })); });
  }
  return fixture;
}

async function main() {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
  const out = option('out', 'tests/fixtures/revisit-replay/fixture-v2.json'), model = option('model', 'claude-opus-5-5');
  const ledger = new SpendLedger({ cap: Number(option('cap', '40')) });
  ledger.reserve(model, instructions + 'x'.repeat(100000));
  const Anthropic = require('@anthropic-ai/sdk').default, client = new Anthropic({ apiKey: readKey() });
  const stream = client.messages.stream({ model, max_tokens: 64000, output_config: { effort: 'high' }, messages: [{ role: 'user', content: instructions }] });
  const message = await stream.finalMessage();
  const costUsd = costOf(model, message.usage);
  ledger.record({ model, effort: 'high', purpose: 'fixture generation', costUsd, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens });
  console.log(`Generated with ${message.model}: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out tokens, $${costUsd.toFixed(4)}, stop ${message.stop_reason}.`);
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const rawPath = path.join(repo, 'docs/evaluation/gate-eval/fixture-generation', `${path.basename(out, '.json')}-${new Date().toISOString().replace(/[:.]/g, '')}.txt`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, text + '\n');
  await fs.writeFile(rawPath.replace(/\.txt$/, '.json'), JSON.stringify({ purpose: 'fixture generation', out, model: message.model, effort: 'high', inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, costUsd, stopReason: message.stop_reason }, null, 2) + '\n');
  const fixture = withDue(JSON.parse(text));
  fixture.label = 'Comparison Fixture (D28, D51-I03): synthetic material for the revisit replay, authored by a model. Not real imports, not real decisions, not evidence about any real system.';
  fixture.author = `Generated by ${message.model} (effort high) with scripts/gate-eval/generate-fixture.cjs; due sets derived from labels; labels reviewed before any scored run (D52-I04).`;
  const problems = extraProblems(fixture);
  try { replay.validateFixture(fixture); } catch (error) { problems.push(error.message); }
  const perfect = replay.score(fixture, fixture.timelines.map(replay.perfectAnswers));
  if (perfect.setF1 !== 1) problems.push(`Perfect-answer audit Set-F1 ${perfect.setF1}`);
  if (problems.length) { console.error(`Not written. Raw output kept at ${path.relative(repo, rawPath)}.\n- ${problems.join('\n- ')}`); process.exit(1); }
  await fs.writeFile(path.join(repo, out), JSON.stringify(fixture, null, 1) + '\n');
  console.log(`Wrote ${out}: ${JSON.stringify(replay.validateFixture(fixture))}. Raw output: ${path.relative(repo, rawPath)}.`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { extraProblems, withDue, instructions };
