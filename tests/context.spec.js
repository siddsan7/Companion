const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let root, app, page;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-context-'));
  await fs.writeFile(path.join(root, 'clock.json'), JSON.stringify({ now: '2026-11-08T06:59:00Z', timezone: 'America/Phoenix' }));
});
test.afterEach(async () => { if (app) await app.close(); app = null; await fs.rm(root, { recursive: true, force: true }); });
async function launch(configure = true) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } }); page = await app.firstWindow();
  if (configure) { await page.getByRole('button', { name: 'Choose vault' }).click(); await page.getByRole('button', { name: 'Use this folder' }).click(); await expect(page.getByRole('status')).toContainText('Vault ready.'); }
}
async function capture(text) { await page.getByLabel('Thought or link', { exact: true }).fill(text); await page.getByRole('button', { name: 'Save capture', exact: true }).click(); await expect(page.getByLabel('Thought or link', { exact: true })).toHaveValue(''); await expect(page.getByRole('status')).toContainText('Capture saved.'); }
async function search(question) { await page.getByLabel('Context question', { exact: true }).fill(question); await page.getByRole('button', { name: 'Find context', exact: true }).click(); }
test('local exact matches show reasons and manual selection previews the literal question and source provenance', async () => {
  await launch(); await capture('Spaced retrieval can revisit a learned chord.');
  await search('How can retrieval help MyTune?');
  await expect(page.locator('#context-results')).toContainText(/Text match:[^;]*retrieval/);
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Question:\nHow can retrieval help MyTune\?/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Spaced retrieval can revisit a learned chord/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/user capture/);
  await expect(page.locator('#context-summary')).toContainText('Within limit');
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/Spaced retrieval/);
});


test('explicit vault note scope persists and manual sources recover a lexical paraphrase miss without reading private notes', async () => {
  await launch(); await capture('Spaced retrieval can revisit a learned chord.');
  const personal = path.join(root, 'vault', 'personal.md');
  await fs.writeFile(personal, '---\nartifact_type: diary\n---\nCANARYPRIVATE a personal source about practice.');
  await search('CANARYPRIVATE');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-results')).not.toContainText('a personal source');
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([personal]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await search('CANARYPRIVATE');
  await expect(page.locator('#context-results')).toContainText('a personal source');
  await app.close(); app = null; await launch(false); await search('CANARYPRIVATE');
  await expect(page.locator('#context-results')).toContainText('a personal source');
  await page.locator('#context-notes').getByRole('button', { name: 'Exclude note', exact: true }).click();
  await search('CANARYPRIVATE'); await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  // Relevant authored paraphrase deliberately shares no searchable terms.
  await search('Remember earlier lessons');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'Spaced retrieval can revisit a learned chord.' });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Spaced retrieval/);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/CANARYPRIVATE/);
});

async function reviewBundle(name) {
  const target = path.join(root, 'producer', name); await fs.cp(path.join(__dirname, 'fixtures', 'reel-review', name), target, { recursive: true }); return target;
}
async function intakeCheck() {
  await page.getByRole('button', { name: 'Check now', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Intake check complete');
}
test('managed reviewed evidence and independent annotations are searchable but ambiguity and rejection invalidate selected support', async () => {
  test.setTimeout(90000); // Three real intake checks and explicit reviewed-revision choices.
  await reviewBundle('accept'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  const base = path.join(root, 'vault', 'Companion');
  const ledger = JSON.parse(await fs.readFile(path.join(base, '.intake', 'ledger.json'), 'utf8'));
  const imported = Object.values(ledger.captures)[0];
  await fs.writeFile(path.join(base, 'Annotations', 'independent.md'), `---\ncompanion_id: 11111111-1111-4111-8111-111111111111\nartifact_type: annotation\nschema_version: 1\ncapture_id: ${imported.id}\n---\n\nAnnotation canary about chord drills.\n`);
  await search('synthetic');
  await expect(page.locator('#context-results')).toContainText('Human review: accept');
  await expect(page.locator('#context-results')).toContainText('Extraction: partial');
  await expect(page.locator('#context-results')).toContainText('Source association');
  await expect(page.locator('#context-results')).toContainText('Annotation canary');
  await expect(page.locator('#context-results')).toContainText('unversioned capture association');
  await page.locator('#context-results article').filter({ hasText: 'Text match:' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(new RegExp(imported.currentRevision));
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/reviewSourceText|locator|source\.json|AppData/);
  await reviewBundle('edit'); await intakeCheck();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await search('synthetic');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await expect(page.locator('#context-results')).not.toContainText('Annotation canary');
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await page.getByLabel('Source inspection').getByRole('button', { name: 'Make current', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await reviewBundle('reject'); await intakeCheck();
  await page.getByRole('button', { name: 'Inspect source', exact: true }).click();
  const rejected = page.getByLabel('Source inspection').locator('article').filter({ hasText: 'Human review: reject' });
  await rejected.getByRole('button', { name: 'Make current', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Current revision selected');
  await search('Annotation synthetic');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('rejected');
});



test('approved brief versions and saved-idea dependencies stay exact while proposals, unknown dependencies and damaged pins remain unavailable', async () => {
  test.setTimeout(90000);
  await launch(); await capture('Spaced retrieval can revisit a learned chord.');
  const base = path.join(root, 'vault', 'Companion'), captureDir = path.join(base, 'Captures');
  const file = path.join(captureDir, (await fs.readdir(captureDir)).find(name => name.endsWith('.md')));
  const bytes = await fs.readFile(file, 'utf8'), id = bytes.match(/companion_id: "([^"]+)"/)[1];
  const sha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByLabel('Project purpose', { exact: true }).fill('A guitar practice tutor. PROPOSALCANARY');
  await search('PROPOSALCANARY'); await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await page.getByLabel('Project purpose', { exact: true }).fill('A guitar practice tutor.');
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const idea = `---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 22222222-2222-4222-8222-222222222222\nproject_brief_version: 1\nsource_dependencies:\n  - capture_id: ${id}\n    content_sha256: ${sha}\n---\n\nImprovisation canary: an untested user idea.\n`;
  await fs.writeFile(path.join(base, 'Ideas', 'supported.md'), idea);
  await fs.writeFile(path.join(base, 'Ideas', 'unknown.md'), '---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 33333333-3333-4333-8333-333333333333\n---\nUNKNOWNDEPENDENCYCANARY\n');
  await search('guitar');
  await expect(page.locator('#context-results')).toContainText('Approved brief version 1');
  await expect(page.locator('#context-results')).toContainText('Project association');
  await expect(page.locator('#context-results')).toContainText('Improvisation canary');
  await expect(page.locator('#context-error')).toContainText('dependency');
  await expect(page.locator('#context-results')).not.toContainText('UNKNOWNDEPENDENCYCANARY');
  await page.locator('#context-results article').filter({ hasText: 'Approved brief version 1' }).first().getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.locator('#context-results article').filter({ hasText: 'Improvisation canary' }).getByRole('button', { name: 'Add to context', exact: true }).click();
  await fs.writeFile(readme, '# MyTune\n\nA rhythm practice coach.\n');
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 2');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Approved brief version 1/);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/rhythm practice coach|AppData/);
  await expect(page.locator('#context-summary')).toContainText('brief input');
  await fs.unlink(file); await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await fs.writeFile(file, bytes);
  const approved = (await fs.readdir(path.join(base, 'Briefs'))).find(name => name.startsWith('approved-1-'));
  await fs.writeFile(path.join(base, 'Briefs', approved), 'Damaged requested historical pin.');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('unavailable');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
});

test('actual serialized package counts Unicode code points at 32000 and 32001 and enforces a stricter verified input bound', async () => {
  test.setTimeout(60000);
  await launch();
  const question = '😀'.repeat(31976) + 'e\u0301\n'; // 31979 code points, plus the literal 21-point package envelope.
  await page.getByLabel('Context question', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('32000 / 32000 Unicode code points. Within limit');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('Question:\n' + question + '\n\nSources:\n');
  await page.getByLabel('Context question', { exact: true }).fill(question + 'x');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('32001 / 32000 Unicode code points. Oversized');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('Question:\n' + question + 'x\n\nSources:\n');
  await fs.writeFile(path.join(root, 'context-bound.json'), JSON.stringify({ model: 'controlled-model', maxCodePoints: 100, evidence: 'controlled verified model-input bound' }));
  await page.getByLabel('Context question', { exact: true }).fill('😀'.repeat(80));
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('101 / 100 Unicode code points. Oversized');
  await expect(page.locator('#context-summary')).toContainText('controlled verified model-input bound');
  await expect(page.locator('#context-summary')).toContainText('Application cap: 32000');
});

test('oversized selections stay intact until the inspected shorter passage is explicitly approved and source changes revoke approval', async () => {
  test.setTimeout(60000);
  await launch(); await capture('Long excerpt:\n' + 'x'.repeat(32000) + '\nFinal supported sentence.');
  await search('supported');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Oversized');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/x{32000}/);
  await expect(page.locator('#context-selected')).toContainText('Long excerpt:');
  await page.getByLabel('Shorter passage', { exact: true }).fill('Final supported sentence.');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Oversized');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/x{32000}/);
  await page.getByRole('button', { name: 'Approve shorter passage', exact: true }).click();
  await expect(page.locator('#context-selected')).toContainText('Shortening approved');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Within limit');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Explicitly shortened passage/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Final supported sentence\./);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/x{100}/);
  const dir = path.join(root, 'vault', 'Companion', 'Captures');
  const file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  await fs.appendFile(file, '\nChanged source after shortening approval.\n');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('changed or is unavailable');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
});

test('ranked matching paragraphs expose exact line anchors and explicit passage selection preserves the inspected text', async () => {
  await launch();
  const text = '# Field notes\r\n\r\nUnrelated opening material.\r\n\r\nSpaced retrieval revisits a learned chord.\r\nA short practice check measures recall.\r\n\r\nUnrelated closing material.\r\n';
  const file = path.join(root, 'vault', 'field.md'); await fs.writeFile(file, text);
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([file]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await search('retrieval recall');
  const passage = page.locator('#context-results .context-passage').first();
  await expect(passage).toContainText('lines 5-6');
  await expect(passage).toContainText('Spaced retrieval revisits a learned chord.');
  await expect(passage).toContainText('A short practice check measures recall.');
  await expect(passage).not.toContainText('Unrelated opening material');
  await passage.getByRole('button', { name: 'Add passage', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const sha = require('node:crypto').createHash('sha256').update(text).digest('hex');
  const expected = `Question:\nretrieval recall\n\nSources:\nExplicit vault note field.md; sha256 ${sha}; user selected; not independently verified; Explicit passage lines 5-6\nSpaced retrieval revisits a learned chord.\nA short practice check measures recall.`;
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
  await expect(page.locator('#context-summary')).toContainText(`${Array.from(expected).length} / 32000`);
  await page.locator('#context-selected').getByRole('button', { name: 'Use full source', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Unrelated opening material/);
});

test('source-associated saved ideas can be selected and explicit source removal excludes their support until a new selection', async () => {
  await launch(); await capture('Needle source statement.');
  const base = path.join(root, 'vault', 'Companion'), dir = path.join(base, 'Captures');
  const content = await fs.readFile(path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md'))), 'utf8');
  const id = content.match(/companion_id: "([^"]+)"/)[1], sha = require('node:crypto').createHash('sha256').update(content).digest('hex');
  await fs.writeFile(path.join(base, 'Ideas', 'associated.md'), `---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 44444444-4444-4444-8444-444444444444\ntitle: Dependent idea\nsource_dependencies:\n  - capture_id: ${id}\n    content_sha256: ${sha}\n---\n\nDifferently worded derived canary.\n`);
  await search('Needle');
  const idea = page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Dependent idea', exact: true }) });
  await expect(idea).toContainText(`Source association with ${id}`);
  await expect(idea).not.toContainText('Text match:');
  await page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Needle source statement.', exact: true }) }).getByRole('button', { name: 'Add to context', exact: true }).click();
  await idea.getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Differently worded derived canary/);
  await page.locator('#context-selected article').filter({ has: page.getByText('Needle source statement.', { exact: true }) }).getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Excluded');
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/derived canary|Needle source statement/);
  expect(await fs.readFile(path.join(base, 'Ideas', 'associated.md'), 'utf8')).toContain('Differently worded derived canary');
  await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'Needle source statement.' });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Needle source statement/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/derived canary/);
});


test('intake authority survives mutable capture type labels and explicit-note inclusion cannot bypass managed rejection', async () => {
  await reviewBundle('reject'); await launch();
  await page.getByLabel('Finalized review folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect finalized reviews', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  const dir = path.join(root, 'vault', 'Companion', 'Captures'), file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  const original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, original.replace('capture_type: "reel_import"', 'capture_type: "thought"') + '\nTYPEBYPASSCANARY\n');
  await search('TYPEBYPASSCANARY');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('rejected');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#captures article')).toContainText('reel_import');
  await expect(page.locator('#captures article').getByRole('button', { name: 'Inspect source', exact: true })).toBeVisible();
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([file]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('Managed material');
  const copy = path.join(root, 'vault', 'copied.md'); await fs.writeFile(copy, original);
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([copy]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-error')).toContainText('cannot bypass context eligibility');
  await fs.writeFile(file, original); await search('synthetic');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
});


test('two desktop instances preserve an explicit scope exclusion during an overlapping note inclusion', async () => {
  test.setTimeout(90000);
  await launch();
  const base = path.join(root, 'vault', 'base.md'), added = path.join(root, 'vault', 'added.md');
  await fs.writeFile(base, 'BASESCOPECANARY'); await fs.writeFile(added, 'ADDEDSCOPECANARY');
  await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([base]));
  await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
  await expect(page.locator('#context-notes')).toContainText(base);
  const secondApp = await electron.launch({ args: ['.'], env: { ...process.env, COMPANION_TEST_ROOT: root } });
  try {
    const second = await secondApp.firstWindow();
    await second.getByLabel('Context question', { exact: true }).fill('BASESCOPECANARY');
    await second.getByRole('button', { name: 'Find context', exact: true }).click();
    await expect(second.locator('#context-notes')).toContainText(base);
    await fs.writeFile(path.join(root, 'context-selection.json'), JSON.stringify([added]));
    await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'context-before-scope-publish' }));
    await page.getByRole('button', { name: 'Include vault notes', exact: true }).click();
    await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('context-before-scope-publish');
    await second.locator('#context-notes').getByRole('button', { name: 'Exclude note', exact: true }).click();
    await expect.poll(async () => (await second.locator('#context-error').textContent()).includes('busy') || await second.locator('#context-notes').getByRole('button', { name: 'Exclude note', exact: true }).count() === 0).toBe(true);
    const busy = (await second.locator('#context-error').textContent()).includes('busy');
    await fs.writeFile(path.join(root, 'release.txt'), 'release');
    await expect(page.locator('#context-notes')).toContainText(added);
    if (busy) {
      await second.locator('#context-notes p').filter({ hasText: base }).getByRole('button', { name: 'Exclude note', exact: true }).click();
      await expect(second.locator('#context-notes')).not.toContainText(base);
    }
    await second.getByRole('button', { name: 'Find context', exact: true }).click();
    await expect(second.locator('#context-notes')).toContainText(added);
    await expect(second.locator('#context-results')).toContainText('No Relevant Context');
    await expect(second.locator('#context-notes')).not.toContainText(base);
  } finally { await fs.writeFile(path.join(root, 'release.txt'), 'release'); await secondApp.close(); }
  await app.close(); app = null; await launch(false); await search('BASESCOPECANARY');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-notes')).toContainText(added);
});


test('supported unreviewed drafts and explicit link excerpts retain provenance while held and unadmitted material stay outside discovery', async () => {
  test.setTimeout(60000);
  const fixture = require('./fixtures/reel-draft/example.json'), ready = path.join(root, 'producer', 'ready'); await fs.mkdir(ready, { recursive: true });
  const run = { job_id: 'b'.repeat(64), attempt_id: '1'.repeat(32), started_utc: '2026-11-01T10:00:00Z', input_sha256: 'a'.repeat(64), input_kind: 'synthetic_fixture', result_kind: 'synthetic_video_wiring', state: 'partial', validation: 'passed' };
  await fs.writeFile(path.join(ready, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(ready, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: run.job_id }));
  await fs.writeFile(path.join(ready, 'first-pass-target.json'), JSON.stringify(fixture.target));
  await fs.copyFile(path.join(__dirname, 'fixtures/reel-draft/notes.md'), path.join(ready, 'notes.md'));
  const held = path.join(root, 'producer', 'held'); await fs.cp(ready, held, { recursive: true });
  await fs.writeFile(path.join(held, 'run.json'), JSON.stringify({ ...run, state: 'failed' })); await fs.appendFile(path.join(held, 'notes.md'), '\nHELDMATERIALCANARY\n');
  await launch();
  await page.getByLabel('Draft source folder').fill(path.join(root, 'producer'));
  await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source connected'); await intakeCheck();
  await fs.writeFile(path.join(root, 'vault', 'Companion', 'Captures', 'unadmitted.md'), '---\ncompanion_id: 55555555-5555-4555-8555-555555555555\nartifact_type: capture\nschema_version: 1\ncapture_type: reel_import\ncaptured_at: 2026-11-08T06:59:00Z\ntitle: Unadmitted\n---\nUNADMITTEDCANARY\n');
  await search('retries');
  await expect(page.locator('#context-results')).toContainText('Human review: unreviewed');
  await expect(page.locator('#context-results')).toContainText('Processing: partial');
  await expect(page.locator('#context-results')).toContainText('Extraction: partial');
  await expect(page.locator('#context-results')).toContainText('Authored synthetic fixture');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await search('HELDMATERIALCANARY UNADMITTEDCANARY');
  await expect(page.locator('#context-results')).toContainText('No Relevant Context');
  await expect(page.locator('#context-error')).toContainText('not admitted');
  await capture('https://example.test/barecanary'); await search('barecanary');
  await expect(page.locator('#context-results')).toContainText('user-supplied link; webpage not fetched or verified');
  await page.getByLabel('Thought or link', { exact: true }).fill('https://example.test/excerptcanary');
  await page.getByRole('button', { name: 'Add source excerpt', exact: true }).click();
  await page.getByLabel('User-supplied excerpt').fill('USEREXCERPTCANARY spaced practice.');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByLabel('Thought or link', { exact: true })).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('Capture saved.');
  await search('USEREXCERPTCANARY');
  await expect(page.locator('#context-results')).toContainText('user-supplied excerpt; webpage not verified');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Human review: unreviewed/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/Authored synthetic fixture/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/USEREXCERPTCANARY/);
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/https:\/\/example\.test\/excerptcanary/);
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/HELDMATERIALCANARY|UNADMITTEDCANARY|source\.json|AppData/);
});



test('explicit brief removal excludes a saved idea with that validated project dependency until a new preview', async () => {
  test.setTimeout(60000);
  await launch();
  const readme = path.join(root, 'README.md'); await fs.writeFile(readme, '# MyTune\n\nA guitar practice tutor.\n');
  await fs.writeFile(path.join(root, 'brief-selection.json'), JSON.stringify([readme]));
  await page.getByRole('button', { name: 'Select MyTune README', exact: true }).click();
  await page.getByRole('button', { name: 'Propose brief', exact: true }).click();
  await page.getByRole('button', { name: 'Approve proposed brief', exact: true }).click();
  await expect(page.locator('#brief-view')).toContainText('Approved version 1');
  const ideaFile = path.join(root, 'vault', 'Companion', 'Ideas', 'project-dependent.md');
  const ideaText = '---\nartifact_type: saved_idea\nschema_version: 1\ncompanion_id: 66666666-6666-4666-8666-666666666666\ntitle: Brief dependent idea\nsource_dependencies: []\nproject_brief_version: 1\n---\nBRIEFDERIVEDCANARY retained user interpretation.\n';
  await fs.writeFile(ideaFile, ideaText); await search('guitar');
  const brief = page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Approved brief version 1', exact: true }) });
  const idea = page.locator('#context-results article').filter({ has: page.getByRole('heading', { name: 'Brief dependent idea', exact: true }) });
  await expect(idea).toContainText('Project association');
  await brief.getByRole('button', { name: 'Add to context', exact: true }).click();
  await idea.getByRole('button', { name: 'Add to context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/BRIEFDERIVEDCANARY/);
  await page.locator('#context-selected article').filter({ has: page.getByText('Approved brief version 1', { exact: true }) }).getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.locator('#context-summary')).toContainText('Excluded');
  await expect(page.getByLabel('Actual context package', { exact: true })).not.toHaveValue(/BRIEFDERIVEDCANARY/);
  expect(await fs.readFile(ideaFile, 'utf8')).toBe(ideaText);
  await page.getByLabel('Manual context source', { exact: true }).selectOption({ label: 'Approved brief version 1' });
  await page.getByRole('button', { name: 'Add manual source', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(/BRIEFDERIVEDCANARY/);
});

test('delayed preview results and errors cannot replace the package for changed current controls', async () => {
  test.setTimeout(90000);
  await launch(); await capture('Preview race source.'); await search('Preview');
  await page.locator('#context-results').getByRole('button', { name: 'Add to context', exact: true }).click();
  await fs.writeFile(path.join(root, 'faults.json'), JSON.stringify({ pause: 'context-before-preview-read' }));
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('context-before-preview-read');
  await page.getByLabel('Context question', { exact: true }).fill('New question');
  await fs.writeFile(path.join(root, 'release.txt'), 'release');
  await expect(page.locator('#context-summary')).toContainText('Earlier preview ignored');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue('');
  await fs.unlink(path.join(root, 'release.txt')); await fs.unlink(path.join(root, 'checkpoint.txt'));
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  await expect.poll(() => fs.readFile(path.join(root, 'checkpoint.txt'), 'utf8').catch(() => '')).toBe('context-before-preview-read');
  await page.locator('#context-selected').getByRole('button', { name: 'Remove from context', exact: true }).click();
  await page.getByLabel('Context question', { exact: true }).fill('Newest question');
  const dir = path.join(root, 'vault', 'Companion', 'Captures'), file = path.join(dir, (await fs.readdir(dir)).find(name => name.endsWith('.md')));
  await fs.appendFile(file, '\nChanged before older request reads its selection.\n');
  await fs.writeFile(path.join(root, 'faults.json'), '{}');
  await page.getByRole('button', { name: 'Preview context', exact: true }).click();
  const expected = 'Question:\nNewest question\n\nSources:\n';
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
  await expect(page.locator('#context-summary')).toContainText('Within limit');
  await fs.writeFile(path.join(root, 'release.txt'), 'release');
  await expect(page.locator('#context-summary')).toContainText('Earlier preview ignored');
  await expect(page.getByLabel('Actual context package', { exact: true })).toHaveValue(expected);
  await expect(page.locator('#context-error')).toHaveText('');
});
