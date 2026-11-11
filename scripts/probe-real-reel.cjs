// Actual Reel to MD draft and MyTune README, with a controlled reply. Run from a Companion worktree.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const repository = process.cwd(), local = createRequire(path.join(repository, 'package.json'));
const { _electron: electron, expect } = local('@playwright/test');
const YAML = local('yaml');
const inputs = process.argv.slice(2);
assert.ok(process.platform === 'win32' && inputs.length === 3 && inputs.every(file => path.isAbsolute(file)), 'Supply absolute paths for a fresh Temp evidence directory, actual producer attempt, and MyTune README.');
const [root, producer, readme] = inputs.map(file => path.resolve(file));
const names = ['evidence.json', 'first-pass-target.json', 'frames.json', 'notes.md', 'run.json'];
const copied = path.join(root, 'producer', 'actual-attempt'), project = path.join(root, 'project-input', 'README.md');
const vault = path.join(root, 'vault', 'Companion'), ideas = path.join(vault, 'Ideas');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const text = (directory, name) => fs.readFile(path.join(directory, name), 'utf8');
const json = async (directory, name) => JSON.parse(await text(directory, name));
const write = (directory, name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), 'utf8');
const metadata = markdown => YAML.parse(markdown.match(/^---\n([\s\S]*?)\n---\n/)[1]);
const matching = async (directory, suffix) => (await fs.readdir(directory)).filter(name => name.endsWith(suffix));
const one = async (directory, suffix) => { const found = await matching(directory, suffix); assert.equal(found.length, 1, directory); return path.join(directory, found[0]); };
const reply = 'Authored controlled response for this smoke: isolated configurations suggest an offline comparison for MyTune recommendations. No recommendation or learning outcome was verified.';
const title = 'Compare MyTune recommendations in isolated configurations';
const fields = {
  Hypothesis: 'Separately recorded configurations make differences in recommendation traces easier to reproduce.',
  'Borrowed mechanism': 'Isolate per-project dependencies, as the Python virtual environment tutorial describes.',
  'Project application': 'Run the MyTune recommendation evaluator with separate baseline and candidate settings outside the live planner.',
  'Smallest test': 'Run one existing scenario twice under each recorded setting and compare the resulting offline traces.',
  'Observable result': 'Record whether the same setting reproduces its trace and which top-three recommendations differ.'
};
let desktop;

async function inputHashes(folder, readmePath) {
  const files = {};
  for (const name of names) {
    const file = path.join(folder, name), info = await fs.lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Use ordinary selected input files.');
    files[name] = digest(await fs.readFile(file));
  }
  const info = await fs.lstat(readmePath);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Use an ordinary selected README.');
  return { producer: files, readme: digest(await fs.readFile(readmePath)) };
}
async function launch(configure) {
  const profile = path.join(root, 'electron-profile'), roaming = path.join(root, 'roaming'), localData = path.join(root, 'local');
  desktop = await electron.launch({ args: [`--user-data-dir=${profile}`, repository], env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: localData, COMPANION_TEST_ROOT: root } });
  const paths = await desktop.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }));
  for (const current of Object.values(paths)) assert.equal(path.resolve(current).toLowerCase(), profile.toLowerCase());
  const page = await desktop.firstWindow();
  if (configure) {
    await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
    await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Vault ready.');
  }
  return page;
}
const button = (page, name) => page.getByRole('button', { name, exact: true });
const field = (page, name) => page.getByLabel(name, { exact: true });
async function close() { if (desktop) { await desktop.close(); desktop = null; } }

function contains(directory, file) {
  const relative = path.relative(directory, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
async function main() {
  const parent = path.dirname(root), resolvedParent = await fs.realpath(parent), temp = await fs.realpath(os.tmpdir());
  assert.ok(resolvedParent.toLowerCase() === parent.toLowerCase() && resolvedParent.toLowerCase() === temp.toLowerCase(), 'Evidence must be a fresh directory directly under the canonical Windows Temp folder.');
  const actualProducer = await fs.realpath(producer), actualProject = path.dirname(await fs.realpath(readme));
  assert.equal(actualProducer, producer);
  assert.ok(!contains(actualProducer, root) && !contains(actualProject, root), 'Evidence must stay outside both selected input folders.');
  const before = await inputHashes(producer, readme);
  const run = await json(producer, 'run.json'), target = await json(producer, 'first-pass-target.json'), packet = await json(producer, 'evidence.json');
  assert.equal(run.input_kind, 'local_video');
  assert.equal(run.result_kind, 'local_video_unreviewed');
  assert.equal(run.validation, 'passed');
  assert.equal(target.title, 'Python Virtual Environment Tutorial');
  const selected = packet.evidence.find(item => item.id === 'audio-0001');
  assert.equal(selected?.kind, 'transcript');
  assert.match(selected.text, /isolate your Python projects/);
  await fs.mkdir(root); // Never reuse a previous evidence or user vault.
  await Promise.all([copied, path.dirname(project), 'electron-profile', 'roaming', 'local'].map(folder => fs.mkdir(path.isAbsolute(folder) ? folder : path.join(root, folder), { recursive: true })));
  await Promise.all(names.map(name => fs.copyFile(path.join(producer, name), path.join(copied, name))));
  await fs.copyFile(readme, project);
  assert.deepEqual(await inputHashes(copied, project), before);
  const now = new Date().toISOString();
  await write(root, 'clock.json', { now, timezone: 'UTC' });
  await write(root, 'brief-selection.json', [project]);
  await write(root, 'conversation-provider.json', { reply });
  await write(root, 'input-evidence.json', { before, producer, readme, job: run.job_id, attempt: run.attempt_id, label: 'Actual producer input and actual project document; authored controlled response, no live provider.' });
  try {
    let page = await launch(true);
    await field(page, 'Draft source folder').fill(path.dirname(copied));
    await page.getByRole('checkbox', { name: 'Scan existing drafts now', exact: true }).check();
    await button(page, 'Connect draft source').click();
    await expect(page.getByRole('status')).toContainText('Intake check complete');
    await expect(page.locator('#captures article')).toContainText(target.title);
    const capture = await one(path.join(vault, 'Captures'), '.md'), captureBytes = await fs.readFile(capture);
    const revisionFile = await one(path.join(vault, 'Revisions'), '.json'), revisionBytes = await fs.readFile(revisionFile);
    const revision = JSON.parse(revisionBytes), snapshot = digest(revisionBytes), captureFields = metadata(captureBytes.toString('utf8'));
    assert.equal(captureFields.companion_id, revision.captureId);
    assert.equal(captureFields.source_revision, revision.id);
    assert.equal(revision.sourceHash, run.input_sha256);
    assert.equal(revision.humanReview, 'unreviewed');
    assert.equal(revision.extraction, 'partial');
    assert.equal(revision.run.attempt_id, run.attempt_id);
    assert.deepEqual(revision.evidence.evidence.find(item => item.id === selected.id), selected);
    const ledger = await json(path.join(vault, '.intake'), 'ledger.json');

    await button(page, 'Select MyTune README').click();
    await button(page, 'Propose brief').click();
    await button(page, 'Approve proposed brief').click();
    await expect(page.locator('#brief-view')).toContainText('Approved version 1');
    const briefName = (await fs.readdir(path.join(vault, 'Briefs'))).find(name => name.startsWith('approved-1-'));
    const briefBytes = await fs.readFile(path.join(vault, 'Briefs', briefName));
    const brief = metadata(briefBytes.toString('utf8')).record;
    assert.equal(brief.sources.length, 1);
    assert.equal(brief.sources[0].path, project);
    assert.equal(brief.sources[0].sha256, before.readme);

    const question = 'How could Python virtual environment isolation inform an offline MyTune recommendation comparison?';
    await field(page, 'Context question').fill(question);
    await button(page, 'Find context').click();
    await field(page, 'Manual context source').selectOption({ label: target.title });
    await button(page, 'Add manual source').click();
    await field(page, 'Conversation brief version').fill('1');
    await button(page, 'Preview conversation').click();
    await expect(button(page, 'Send reviewed package')).toBeEnabled();
    const reviewed = await field(page, 'Reviewed conversation package').inputValue();
    assert.ok(reviewed.includes(question) && reviewed.includes(selected.text) && reviewed.includes(snapshot));
    assert.ok(reviewed.includes(revision.text.replace(/\r\n?/g, '\n')));
    await fs.writeFile(path.join(root, 'reviewed-package.txt'), reviewed, 'utf8');
    await button(page, 'Send reviewed package').click();
    await expect(page.locator('#conversation-history')).toContainText(reply);
    await expect(page.locator('#conversation-history article').last()).toContainText('completed');
    const historyFile = await one(path.join(root, 'conversations'), '.json');
    const history = JSON.parse(await fs.readFile(historyFile, 'utf8')), request = history.requests[0];
    assert.equal(history.requests.length, 1);
    assert.equal(request.package.text, reviewed);
    assert.equal(request.package.digest, digest(reviewed));
    assert.equal(history.brief.digest, digest(briefBytes));
    const dependencies = request.package.dependencies.filter(item => item.key.startsWith('capture:'));
    assert.equal(dependencies.length, 1);
    const dependency = dependencies[0];
    assert.equal(dependency.captureId, revision.captureId);
    assert.equal(dependency.revisionId, revision.id);
    const generation = ledger.sourceAuthority?.[revision.captureId]?.generation;
    assert.deepEqual(dependency.sourceGenerations || [], generation ? [{ captureId: revision.captureId, generation }] : []);

    await button(page, 'Draft saved idea').click();
    await field(page, 'Idea title').fill(title);
    await field(page, 'Idea explanation').fill(reply);
    await field(page, 'Idea limitations').fill('Partial, unreviewed producer draft. Controlled response. No experiment was run and no learning outcome was observed.');
    await field(page, 'Saved idea kind').selectOption({ label: 'Experiment Proposal' });
    for (const [label, value] of Object.entries(fields)) await field(page, label).fill(value);
    await page.getByRole('checkbox', { name: `Cite evidence ${selected.id} from ${target.title}`, exact: true }).check();
    await button(page, 'Preview saved idea').click();
    await expect(field(page, 'Proposed idea Markdown')).toHaveValue(/# Experiment Proposal/);
    assert.deepEqual(await matching(ideas, '.md'), []);
    await button(page, 'Cancel saved idea preview').click();
    assert.deepEqual(await matching(ideas, '.md'), []);
    await button(page, 'Preview saved idea').click();
    await expect(button(page, 'Confirm saved idea')).toBeEnabled();
    const markdown = await field(page, 'Proposed idea Markdown').inputValue(), note = await field(page, 'Proposed idea destination').inputValue();
    assert.equal(path.dirname(note), ideas);
    const saved = metadata(markdown);
    assert.equal(saved.idea_kind, 'experiment_proposal');
    for (const [label, value] of Object.entries(fields)) assert.ok(markdown.includes(`## ${label}\n\n${value}`));
    assert.deepEqual(saved.project_brief, history.brief);
    assert.deepEqual(saved.source_dependencies, [{ capture_id: revision.captureId, revision_id: revision.id, ...(generation ? { source_generation: generation } : {}) }]);
    assert.equal(saved.origin.package_sha256, request.package.digest);
    assert.equal(saved.origin.reply_sha256, digest(reply));
    assert.equal(saved.citations.length, 1);
    assert.deepEqual(saved.citations[0], { kind: 'imported_evidence', capture_id: revision.captureId, revision_id: revision.id, snapshot_sha256: snapshot, evidence_id: selected.id, evidence_kind: selected.kind, start_seconds: selected.start_seconds, end_seconds: selected.end_seconds, excerpt: selected.text, excerpt_sha256: digest(selected.text) });
    await button(page, 'Confirm saved idea').click();
    await expect(page.locator('#idea-status')).toContainText('Saved idea');
    assert.equal(await fs.readFile(note, 'utf8'), markdown);
    await button(page, 'Inspect cited evidence').click();
    await expect(page.locator('#idea-evidence')).toContainText(selected.text);
    await button(page, 'Open saved idea in Obsidian').click();
    const uri = `obsidian://open?path=${encodeURIComponent(note)}`;
    await expect.poll(() => text(root, 'opened-uri.txt').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBe(uri);
    const submissions = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'));
    assert.equal(submissions.toString('utf8').trim().split('\n').length, 1);
    await close();

    await write(root, 'clock.json', { now: new Date(Date.parse(now) + 1000).toISOString(), timezone: 'UTC' });
    page = await launch(false);
    await expect(page.locator('#saved-ideas')).toContainText(title);
    await button(page, 'Check now').click();
    await expect(page.getByRole('status')).toContainText('Intake check complete');
    assert.equal(await one(ideas, '.md'), note);
    assert.equal(await one(path.join(vault, 'Captures'), '.md'), capture);
    assert.equal(await one(path.join(vault, 'Revisions'), '.json'), revisionFile);
    assert.equal(await fs.readFile(note, 'utf8'), markdown);
    assert.deepEqual(await fs.readFile(capture), captureBytes);
    assert.deepEqual(await fs.readFile(revisionFile), revisionBytes);
    assert.deepEqual(await fs.readFile(path.join(root, 'conversation-submissions.jsonl')), submissions);
    assert.deepEqual((await json(path.join(vault, '.intake'), 'ledger.json')).attempts, ledger.attempts);
    assert.deepEqual(await inputHashes(producer, readme), before);
    assert.deepEqual(await inputHashes(copied, project), before);
    await write(root, 'observed.json', { note, noteSha256: digest(markdown), vault: path.dirname(vault), uri, uriMode: 'Controlled URI capture; actual Obsidian opening is a separate gate.', capture: revision.captureId, revision: revision.id, generation: generation || null, snapshot, brief: history.brief, packageSha256: request.package.digest, evidenceId: selected.id, evidenceCount: packet.evidence.length, sourceStatus: { extraction: revision.extraction, humanReview: revision.humanReview }, restartIdempotent: true, originalAndCopiedInputsUnchanged: true, submissions: 1, reply: 'Authored controlled response; no live provider or outcome.' });
  } finally { await close(); }
}
main().then(() => console.log(JSON.stringify({ root, passed: true }))).catch(error => { console.error(error.stack); process.exitCode = 1; });
