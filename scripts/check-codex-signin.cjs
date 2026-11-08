// Actual managed login failure checks in a NEW throwaway home. Never print URL/code or read tokens.
const fs = require('node:fs/promises');
const path = require('node:path');
const { CodexSetup } = require('../app/codex');
const args = process.argv.slice(2);
const options = Object.fromEntries(args.flatMap((value, index) => value.startsWith('--') ? [[value.slice(2), args[index + 1]]] : []));
let setup;
async function main() {
  if (!['cancel', 'expiry'].includes(options.mode) || !options['data-root'] || !options.executable || !options.project || !options.vault) throw Error('Supply --mode cancel|expiry, NEW --data-root, --executable, --project and --vault.');
  const dataRoot = path.resolve(options['data-root']);
  // An existing managed profile is never used for failure checks.
  await fs.mkdir(dataRoot);
  setup = new CodexSetup({ dataRoot });
  await setup.action({ action: 'connect', executable: options.executable, project: options.project, sandbox: options.sandbox || 'mxc' }, { vault: options.vault });
  if (!setup.snapshot().connected || setup.snapshot().authenticated) throw Error('The fresh managed profile did not start unsigned-in.');
  await setup.action({ action: 'login' });
  if (!setup.snapshot().loginPending) throw Error('The installed App Server did not start managed device sign-in.');
  console.log(JSON.stringify({ check: options.mode, stage: 'actual-managed-signin-started', ready: false }));
  if (options.mode === 'cancel') await setup.action({ action: 'cancel-login' });
  else {
    const deadline = Date.now() + 330000;
    while (setup.snapshot().loginPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    if (setup.snapshot().loginPending) { await setup.action({ action: 'cancel-login' }); throw Error('The application sign-in expiry did not settle within its deadline.'); }
  }
  const state = setup.snapshot();
  const expected = options.mode === 'cancel' ? 'cancelled' : 'expired';
  if (state.status !== expected || state.ready || state.loginPending) throw Error('Managed sign-in did not reach the expected unready terminal state.');
  await setup.persist();
  console.log(JSON.stringify({ check: options.mode, status: state.status, ready: false, evidence: 'actual-installed-App-Server', expiryScope: options.mode === 'expiry' ? 'application-five-minute-deadline; provider-specific expiry is separate' : null }));
}
main().catch(error => { console.error(error.code === 'EEXIST' ? 'Use a new throwaway data root; the supplied directory already exists.' : error.message); process.exitCode = 1; }).finally(() => setup?.close());
