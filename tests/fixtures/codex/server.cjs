const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2], home = process.env.CODEX_HOME;
let signedIn = false, loginId = 'fixture-login', sequence = 0, active;
const send = message => {
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  const emoji = bytes.indexOf(Buffer.from('🎸'));
  if (emoji < 0) process.stdout.write(bytes);
  else {
    process.stdout.write(bytes.subarray(0, emoji + 2));
    setTimeout(() => process.stdout.write(bytes.subarray(emoji + 2)), 15);
  }
};
const notify = (method, params) => send({ method, params });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line); if (id === undefined) return;
  const scenario = JSON.parse(fs.readFileSync(path.join(root, 'codex-fixture.json'), 'utf8'));
  fs.appendFileSync(path.join(root, 'codex-requests.jsonl'), JSON.stringify({ method, params }) + '\n');
  let result = {};
  if (method === 'account/read') result = { account: signedIn ? { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' } : null, requiresOpenaiAuth: true };
  if (method === 'account/login/start') result = { type: 'chatgptDeviceCode', loginId, userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' };
  if (method === 'account/login/cancel') result = { status: 'canceled' };
  if (method === 'fixture/login') { signedIn = true; notify('account/login/completed', { loginId, success: true }); }
  if (method === 'config/read') result = { config: {}, layers: [{ name: { type: 'user', file: path.join(home, 'config.toml') }, version: 'fixture', config: JSON.parse(fs.readFileSync(path.join(home, 'companion-policy.json'), 'utf8')) }], origins: {} };
  if (method === 'windowsSandbox/readiness') result = { status: 'ready' };
  if (method === 'skills/list') result = { data: [{ cwd: process.cwd(), errors: [], skills: [] }] };
  if (method === 'mcpServerStatus/list') result = { data: [], nextCursor: null };
  if (method === 'command/exec') {
    const file = params.command.at(-1);
    // Real unrestricted child-process reads emulate a broken sandbox. The production gate must detect it.
    result = scenario.isolation === 'denied' && !file.includes('positive-') ? { exitCode: 73, stdout: 'COMPANION_OS_DENIED', stderr: '' } : { exitCode: 0, stdout: fs.readFileSync(file, 'utf8'), stderr: '' };
  }
  if (method === 'thread/start') result = { cwd: process.cwd(), runtimeWorkspaceRoots: [process.cwd()], approvalPolicy: 'never', activePermissionProfile: { id: 'companion-context' }, instructionSources: [], model: 'fixture', thread: { id: `fixture-thread-${++sequence}` } };
  if (method === 'turn/start') {
    if (scenario.turn === 'exit-before-ack') { process.exit(23); return; }
    active = { threadId: params.threadId, turnId: `fixture-turn-${sequence}` }; result = { turn: { id: active.turnId, status: 'inProgress' } };
  }
  if (method === 'turn/interrupt') setTimeout(() => notify('turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status: 'interrupted' } }), 30);
  send({ id, result });
  if (method === 'turn/start') setTimeout(() => {
    notify('item/agentMessage/delta', { threadId: active.threadId, delta: scenario.turn === 'pending' ? 'Incomplete fixture reply 🎸' : 'Companion context received.' });
    if (scenario.turn === 'usage-limit') notify('error', { threadId: active.threadId, turnId: active.turnId, willRetry: false, error: { message: 'PRIVATE_PROVIDER_DETAIL', codexErrorInfo: 'usageLimitExceeded' } });
    if (scenario.turn !== 'pending') notify('turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status: scenario.turn === 'usage-limit' ? 'failed' : scenario.turn || 'completed' } });
  }, 50);
  if (method === 'account/login/start' && scenario.login === 'complete') setTimeout(() => { signedIn = true; notify('account/login/completed', { loginId, success: true }); }, 40);
  if (method === 'account/login/start' && scenario.login === 'expired') setTimeout(() => notify('account/login/completed', { loginId, success: false, error: 'authorization expired' }), 40);
});
