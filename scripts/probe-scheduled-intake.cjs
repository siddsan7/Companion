// Root-owned disposable native gate. Never called by application startup or tests.
// Usage: node scripts/probe-scheduled-intake.cjs prepare|arm|observe|cleanup <evidence-directory>
// prepare uses normal desktop setup; arm is a clearly accelerated test trigger.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('@playwright/test');
const { TaskScheduler } = require('../app/task-scheduler');
const repository = path.resolve(__dirname, '..');
const [operation, directory] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory)) throw Error('Supply an absolute disposable evidence directory.');
const scheduleFile = path.join(directory, 'schedule.json');
const tasks = new TaskScheduler({ executable: require('electron'), appPath: repository });
async function load() { return JSON.parse(await fs.readFile(scheduleFile, 'utf8')); }
async function main() {
  if (operation === 'prepare') {
    await fs.mkdir(directory);
    if (await fs.stat(scheduleFile).then(() => true, () => false)) throw Error('Use a fresh disposable directory.');
    const now = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'clock.json'), JSON.stringify({ now, timezone: 'UTC' }));
    const producer = path.join(directory, 'producer', 'ready'); await fs.mkdir(producer, { recursive: true });
    const fixture = require('../tests/fixtures/reel-draft/example.json');
    await fs.writeFile(path.join(producer, 'run.json'), JSON.stringify({ job_id: 'b'.repeat(64), attempt_id: '1'.repeat(32), started_utc: now, input_sha256: 'a'.repeat(64), input_kind: 'synthetic_fixture', result_kind: 'synthetic_video_wiring', state: 'partial', validation: 'passed' }));
    await fs.writeFile(path.join(producer, 'evidence.json'), JSON.stringify({ ...fixture.input, clip_id: 'b'.repeat(64) }));
    await fs.writeFile(path.join(producer, 'first-pass-target.json'), JSON.stringify(fixture.target));
    await fs.copyFile(path.join(repository, 'tests/fixtures/reel-draft/notes.md'), path.join(producer, 'notes.md'));
    await fs.writeFile(path.join(directory, 'fixture-label.json'), JSON.stringify({ authored: true, purpose: 'Windows worker wiring/source-file access; not a real Reel to MD producer handoff.' }, null, 2));
    const desktop = await electron.launch({ args: [repository], env: { ...process.env, COMPANION_TEST_ROOT: directory, COMPANION_NATIVE_SCHEDULER: '1' } });
    try {
      const page = await desktop.firstWindow();
      await page.getByRole('button', { name: 'Choose vault', exact: true }).click();
      await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Vault ready.' }).waitFor();
      await page.getByLabel('Draft source folder').fill(path.dirname(producer));
      await page.getByRole('button', { name: 'Connect draft source', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Source connected' }).waitFor();
      await page.getByRole('button', { name: 'Enable daily intake', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Daily intake enabled' }).waitFor();
      const state = await load(), effective = await tasks.apply('inspect', state, scheduleFile);
      await fs.writeFile(path.join(directory, 'production-task.xml'), effective.xml);
      await fs.writeFile(path.join(directory, 'production-inspection.json'), JSON.stringify({ ...effective, policyMatches: tasks.matchesSchedule(effective, state, scheduleFile) }, null, 2));
      await fs.writeFile(path.join(directory, 'production-state.json'), JSON.stringify(state, null, 2));
      console.log(JSON.stringify({ operation, name: effective.name, anchor: state.anchor, nextRun: effective.nextRun, lastResult: effective.lastResult }));
    } catch (error) {
      // Setup may have registered before an inspection/assertion failed. Retain
      // the identity and attempt exact owned cleanup; report a failed cleanup.
      try {
        const state = await load(); await tasks.apply('disable', state, scheduleFile);
        await fs.writeFile(path.join(directory, 'prepare-failure-cleanup.json'), JSON.stringify({ at: new Date().toISOString(), task: await tasks.apply('inspect', state, scheduleFile) }));
      } catch (cleanupError) {
        await fs.writeFile(path.join(directory, 'cleanup-required.json'), JSON.stringify({ error: cleanupError.message, scheduleFile }));
        console.error('Cleanup still required:', cleanupError.message);
      }
      throw error;
    } finally { await desktop.close(); }
  } else if (operation === 'arm') {
    const state = await load(), due = new Date(Math.ceil((Date.now() + 45000) / 1000) * 1000).toISOString();
    // A controlled clock history represents four missed slots. The test-only first
    // boundary is 45s ahead; it is NOT production cadence/missed-sleep evidence.
    state.anchor = new Date(Date.parse(due) - 4 * 86400000).toISOString();
    delete state.handledSlot; await fs.writeFile(scheduleFile, JSON.stringify(state, null, 2));
    const request = tasks.request('repair', state, scheduleFile); request.firstDue = due;
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repository, 'app/task-scheduler.ps1')], { windowsHide: true, stdio: ['pipe','pipe','inherit'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stdin.end(JSON.stringify(request));
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code ? reject(Error(output)) : resolve()); });
    const effective = JSON.parse(output).task;
    await fs.writeFile(path.join(directory, 'accelerated-task.xml'), effective.xml);
    await fs.writeFile(path.join(directory, 'accelerated-boundary.json'), JSON.stringify({ due, anchor: state.anchor, expectedSlot: 4, label: 'Accelerated automatic launch and simulated missed-slot coalescing; not natural 24-hour recurrence or sleep/sign-out evidence.' }, null, 2));
    console.log(JSON.stringify({ operation, due, name: effective.name, label: 'accelerated test only; UI closed; wait past due then observe' }));
  } else if (operation === 'observe') {
    const state = await load(), effective = await tasks.apply('inspect', state, scheduleFile);
    const ledgerFile = path.join(state.vault, state.parent, '.intake/ledger.json');
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
    const evidence = { observedAt: new Date().toISOString(), state, effective, ledger, captures: await fs.readdir(path.join(state.vault, state.parent, 'Captures')), revisions: await fs.readdir(path.join(state.vault, state.parent, 'Revisions')) };
    await fs.writeFile(path.join(directory, 'observed.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ operation, worker: state.worker, handledSlot: state.handledSlot, lastCheck: ledger.lastCheck, captures: evidence.captures.length, revisions: evidence.revisions.length, lastTaskResult: effective.lastResult }));
  } else if (operation === 'cleanup') {
    const state = await load(); await tasks.apply('disable', state, scheduleFile);
    const remaining = await tasks.apply('inspect', state, scheduleFile);
    await fs.writeFile(path.join(directory, 'cleanup.json'), JSON.stringify({ at: new Date().toISOString(), task: remaining }));
    console.log(JSON.stringify({ operation, exactTaskAbsent: remaining === null }));
  } else throw Error('Use prepare, arm, observe or cleanup.');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
