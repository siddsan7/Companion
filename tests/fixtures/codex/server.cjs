const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2], home = process.env.CODEX_HOME;
let signedIn = false, loginId = 'fixture-login', sequence = 0, active, output = Promise.resolve();
const write = bytes => new Promise((resolve, reject) => process.stdout.write(bytes, error => error ? reject(error) : resolve()));
const send = message => {
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  const emoji = bytes.indexOf(Buffer.from('🎸'));
  // Split a UTF-8 character without interleaving another JSON frame into this one.
  output = output.then(async () => {
    if (emoji < 0) await write(bytes);
    else {
      await write(bytes.subarray(0, emoji + 2));
      await new Promise(resolve => setTimeout(resolve, 15));
      await write(bytes.subarray(emoji + 2));
    }
  }).catch(() => process.exit(24));
};
const notify = (method, params) => send({ method, params });
const agentItem = (id, text, phase, memoryCitation = null) => ({ type: 'agentMessage', id, text, phase, memoryCitation, delivery: null, questions: null });
const turn = (status, items = [], itemsView = 'full') => ({ id: active.turnId, rootTurnId: null, items, itemsView, status, error: null, startedAt: 1794139200, completedAt: status === 'inProgress' ? null : 1794139200, durationMs: status === 'inProgress' ? null : 0 });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line); if (id === undefined) return;
  const conversation = process.env.COMPANION_CONVERSATION_FIXTURE === '1';
  const scenario = JSON.parse(fs.readFileSync(path.join(root, conversation ? 'conversation-provider.json' : 'codex-fixture.json'), 'utf8'));
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
  if (method === 'thread/start') result = { cwd: process.cwd(), runtimeWorkspaceRoots: [process.cwd()], approvalPolicy: 'never', activePermissionProfile: { id: 'companion-context' }, instructionSources: [], model: 'fixture', thread: { id: `fixture-thread-${process.pid}-${++sequence}` } };
  if (method === 'turn/start') {
    if (conversation) fs.appendFileSync(path.join(root, 'conversation-submissions.jsonl'), JSON.stringify({ threadId: params.threadId, text: params.input[0].text }) + '\n');
    if (scenario.turn === 'exit-before-ack') { process.exit(23); return; }
    active = { threadId: params.threadId, turnId: `fixture-turn-${sequence}` }; result = { turn: turn('inProgress') };
  }
  if (method === 'turn/interrupt') setTimeout(() => notify('turn/completed', { threadId: active.threadId, turn: turn('interrupted') }), 30);
  send({ id, result });
  if (method === 'turn/start') notify('turn/started', { threadId: active.threadId, turn: turn('inProgress') });
  if (method === 'turn/start') setTimeout(() => {
    const messages = conversation && scenario.messages || [{ text: conversation ? scenario.reply || 'Authored synthetic response.' : scenario.turn === 'pending' ? 'Incomplete fixture reply 🎸' : 'Companion context received.', phase: null }];
    const completedItems = [];
    messages.forEach((message, index) => {
      const itemId = `fixture-message-${process.pid}-${sequence}-${index}`;
      const identity = { threadId: active.threadId, turnId: active.turnId };
      const item = agentItem(itemId, message.text, message.phase, message.memoryCitation);
      if (!message.omitIndividualEvents) {
        notify('item/started', { ...identity, item: agentItem(itemId, '', message.phase, message.memoryCitation), startedAtMs: 1794139200000 + index });
        notify('item/agentMessage/delta', { ...identity, itemId, delta: message.delta === undefined ? message.text : message.delta });
        if (scenario.turn !== 'pending' && !message.omitCompletedEvent) notify('item/completed', { ...identity, item, completedAtMs: 1794139200000 + index });
      }
      if (scenario.turn !== 'pending') {
        completedItems.push(item);
      }
    });
    if (scenario.terminalCommand) completedItems.push({ type: 'commandExecution', id: `fixture-unselected-command-${sequence}`, pluginId: null, scriptPath: null, command: 'SYNTHETIC_NOT_EXECUTED', cwd: process.cwd(), processId: null, source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: 'UNSELECTED_COMMAND_CONTENT_CANARY', exitCode: 0, durationMs: 0 });
    if (scenario.turn === 'usage-limit') notify('error', { threadId: active.threadId, turnId: active.turnId, willRetry: false, error: { message: 'PRIVATE_PROVIDER_DETAIL', codexErrorInfo: 'usageLimitExceeded' } });
    if (scenario.turn !== 'pending') notify('turn/completed', { threadId: active.threadId, turn: turn(scenario.turn === 'usage-limit' ? 'failed' : scenario.turn || 'completed', scenario.terminalView === 'notLoaded' ? [] : completedItems, scenario.terminalView || 'full') });
  }, 50);
  if (method === 'account/login/start' && scenario.login === 'complete') setTimeout(() => { signedIn = true; notify('account/login/completed', { loginId, success: true }); }, 40);
  if (method === 'account/login/start' && scenario.login === 'expired') setTimeout(() => notify('account/login/completed', { loginId, success: false, error: 'authorization expired' }), 40);
});
