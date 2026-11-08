// Reviewable live harness for the same desktop adapter. Never reads auth.json or exports credentials.
const path = require('node:path');
const { CodexSetup } = require('../app/codex');
const options = Object.fromEntries(process.argv.slice(2).map((value, index, args) => value.startsWith('--') ? [value.slice(2), args[index + 1]] : null).filter(Boolean));
if (!['preflight', 'login', 'synthetic'].includes(options.mode) || !options['data-root'] || !options.executable || !options.project || !options.vault) {
  console.error('Usage: node scripts/codex-gate.cjs --mode preflight|login|synthetic --data-root ABSOLUTE --executable CODEX_EXE --project ABSOLUTE --vault ABSOLUTE [--sandbox mxc|elevated]'); process.exit(2);
}
const setup = new CodexSetup({ dataRoot: path.resolve(options['data-root']) });
let last;
const output = () => { const state = setup.snapshot(); const safe = { status: state.status, message: state.message, authenticated: state.authenticated, ready: state.ready, isolationPassed: state.isolationPassed, checks: setup.checks }; const text = JSON.stringify(safe); if (last !== text) { console.log(text); last = text; } };
const timer = setInterval(output, 500);
process.on('SIGINT', () => { setup.close(); clearInterval(timer); process.exit(130); });
(async () => {
  await setup.action({ action: 'connect', executable: options.executable, project: options.project, sandbox: options.sandbox || 'mxc' }, { vault: options.vault }); output();
  if (!setup.snapshot().connected) { process.exitCode = 1; return; }
  if (options.mode === 'login' && !setup.snapshot().authenticated) {
    await setup.action({ action: 'login' });
    const state = setup.snapshot();
    // These one-time codes are intentional interactive sign-in instructions, never written to readiness history.
    if (state.verificationUrl) console.log(`Open ${state.verificationUrl} and enter ${state.userCode}`);
    while (setup.snapshot().loginPending) await new Promise(resolve => setTimeout(resolve, 500));
    output(); if (!setup.snapshot().authenticated) process.exitCode = 1;
    return;
  }
  await setup.action({ action: 'verify' }); output();
  if (options.mode === 'synthetic' && setup.snapshot().isolationPassed) { await setup.action({ action: 'synthetic' }); output(); }
  if (!setup.snapshot().ready) process.exitCode = 1;
})().catch(() => { console.error('Live verification stopped. Inspect the sanitized readiness report.'); process.exitCode = 1; }).finally(() => { clearInterval(timer); setup.close(); });
