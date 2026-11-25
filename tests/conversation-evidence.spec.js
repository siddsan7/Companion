const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConversationEvidence } = require('../app/conversation-evidence');
const { CodexSetup } = require('../app/codex');
const { runTurn } = require('../app/codex-turn');
const { ConversationProvider } = require('../app/conversation-provider');
const { CodexRpc } = require('../app/codex-rpc');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { holdReadSharing } = require('./fixtures/windows-sharing');

for (const outcome of ['held', 'rejected', 'mismatched', 'missing']) {
  test(`history failure after acknowledgement keeps ownership until interruption or teardown: ${outcome}`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-ack-save-'));
    const evidence = { dispatchEnabled: true, binding: 'fixture', capacity: null };
    const provider = new ConversationProvider({ testRoot: root, getEvidence: async () => evidence });
    const send = () => provider.turn('Disposable source', { capacityBinding: evidence.binding, beforeStart: async () => {}, onState: () => {} });
    const open = fs.open;
    try {
      await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ interruptOutcome: outcome }));
      await provider.preflight();
      const setup = provider.controlled;
      let injected = false;
      fs.open = async (file, ...args) => {
        if (!injected && setup.activeTurn && path.dirname(file) === setup.dataRoot && args[0] === 'wx') {
          injected = true;
          throw Object.assign(Error('PRIVATE_ACK_STORAGE_PATH'), { code: 'ENOSPC' });
        }
        return open(file, ...args);
      };
      const result = send().then(() => null, error => error);
      const requests = async () => (await fs.readFile(path.join(root, 'codex-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      if (outcome === 'held') {
        await expect.poll(async () => (await requests()).some(call => call.method === 'turn/interrupt')).toBe(true);
        expect(setup.snapshot().busy).toBe(true);
        expect(setup.activeTurn.turnId).toBe(setup.turnHistory.at(-1).turnId);
        await setup.interrupt();
        await expect(send()).rejects.toThrow('still finishing');
        await fs.writeFile(path.join(root, 'release-interrupt'), '');
      }
      const error = await result;
      expect(injected).toBe(true);
      expect(error?.message).toContain('(ENOSPC)');
      expect(error.message).not.toMatch(/PRIVATE_|cancelled|canceled/i);
      if (outcome !== 'held') expect(error.message).toContain('without a confirmed terminal');
      expect(error.terminalStatus).toBe('interrupted');
      expect(setup.rpc.closed).toBe(outcome !== 'held');
      expect(setup.turnLease).toBeNull();
      const calls = await requests(), starts = calls.filter(call => call.method === 'turn/start'), interrupts = calls.filter(call => call.method === 'turn/interrupt');
      expect(starts).toHaveLength(1); expect(interrupts).toHaveLength(1);
      expect(interrupts[0].params).toEqual({ threadId: starts[0].params.threadId, turnId: setup.turnHistory.at(-1).turnId });
      expect(setup.turnHistory.at(-1).status).toBe('interrupted');
    } finally {
      fs.open = open;
      provider.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

test('a partial readiness write removes its owned stage and reports only the storage error code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-partial-save-'));
  const setup = new CodexSetup({ dataRoot: root });
  const open = fs.open;
  try {
    await setup.loaded;
    await setup.persist();
    const report = path.join(root, 'readiness.json'), before = await fs.readFile(report);
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (path.dirname(file) === root && args[0] === 'wx') {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async bytes => {
          await write(bytes.subarray(0, 17));
          throw Object.assign(Error('PRIVATE_STORAGE_PATH'), { code: 'ENOSPC' });
        };
      }
      return handle;
    };
    const state = await setup.action({ action: 'invalidate' });
    expect(state).toMatchObject({ status: 'failed', ready: false, busy: false });
    expect(state.message).toContain('(ENOSPC)');
    expect(state.message).not.toContain('PRIVATE_STORAGE_PATH');
    expect(await fs.readdir(root)).toEqual(['readiness.json']);
    expect(await fs.readFile(report)).toEqual(before);
  } finally { fs.open = open; setup.close(); await fs.rm(root, { recursive: true, force: true }); }
});

for (const persistent of [false, true]) {
  test(`a ${persistent ? 'persistent' : 'brief'} Windows reader at final history publication releases the turn lease without replay`, async () => {
    test.skip(process.platform !== 'win32', 'Requires a Windows reader denying delete sharing.');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-final-save-'));
    const evidence = { dispatchEnabled: true, binding: 'fixture', capacity: null };
    const provider = new ConversationProvider({ testRoot: root, getEvidence: async () => evidence });
    const send = () => provider.turn('Disposable source', { capacityBinding: evidence.binding, beforeStart: async () => {}, onState: () => {} });
    const finalSave = Promise.withResolvers(), readerReady = Promise.withResolvers();
    let hold, timer, turn;
    try {
      await fs.writeFile(path.join(root, 'conversation-provider.json'), JSON.stringify({ reply: 'Fixture answer.' }));
      await provider.preflight();
      const setup = provider.controlled;
      const save = setup.persist.bind(setup);
      setup.persist = async () => {
        if (!hold && setup.state.status === 'completed') {
          finalSave.resolve();
          await readerReady.promise;
        }
        return save();
      };
      turn = send().then(value => ({ value }), error => ({ error }));
      await Promise.race([finalSave.promise, turn.then(() => { throw Error('Turn ended before its final save.'); })]);
      hold = holdReadSharing(path.join(setup.dataRoot, 'readiness.json'));
      await hold.ready();
      if (!persistent) timer = setTimeout(() => hold.release(), 125);
      readerReady.resolve();
      const result = await turn;
      if (persistent) expect(result.error?.message).toMatch(/history could not be saved.*\((EPERM|EACCES|EBUSY)\)/);
      else expect(result.value?.reply).toBe('Fixture answer.');
      expect(setup.turnLease).toBeNull();
      expect(setup.snapshot().busy).toBe(false);
      expect(setup.state.status).toBe(persistent ? 'interrupted' : 'completed');
      expect(setup.turnHistory.at(-1).status).toBe(setup.state.status);
      expect(setup.state.message).not.toContain(root);
      expect(await fs.readdir(setup.dataRoot)).toEqual(['readiness.json']);
      const calls = await fs.readFile(path.join(root, 'conversation-submissions.jsonl'), 'utf8');
      expect(calls.trim().split('\n')).toHaveLength(1);
      hold.release(); await hold.closed;
      setup.persist = save;
      expect((await send()).reply).toBe('Fixture answer.');
      const saved = JSON.parse(await fs.readFile(path.join(setup.dataRoot, 'readiness.json'), 'utf8'));
      expect(saved.turns.map(turn => turn.status)).toEqual([persistent ? 'interrupted' : 'completed', 'completed']);
    } finally {
      readerReady.resolve(); clearTimeout(timer); hold?.release(); await hold?.closed; await turn; provider.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

test('a second synthetic turn stops reporting the previous completion before it receives a terminal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-synthetic-state-'));
  const project = path.join(root, 'project'), vault = path.join(root, 'vault');
  const fixture = path.join(root, 'codex-fixture.json');
  const scenario = { login: 'complete', isolation: 'denied', turn: 'completed' };
  const setup = new CodexSetup({ dataRoot: path.join(root, 'data'), testRoot: root });
  let pending;
  try {
    await Promise.all([fs.mkdir(project), fs.mkdir(vault), fs.writeFile(fixture, JSON.stringify(scenario))]);
    await setup.action({ action: 'connect', executable: 'controlled-fixture', project, sandbox: 'mxc' }, { vault });
    await setup.action({ action: 'login' });
    await expect.poll(() => setup.snapshot().authenticated).toBe(true);
    await setup.action({ action: 'verify' });
    expect((await setup.action({ action: 'synthetic' })).status).toBe('fixture-completed');
    await fs.writeFile(fixture, JSON.stringify({ ...scenario, holdCompletion: true }));
    pending = setup.action({ action: 'synthetic' });
    await expect.poll(() => setup.snapshot().turnActive).toBe(true);
    expect(setup.snapshot()).toMatchObject({ status: 'running', message: 'Waiting for Codex to finish the current turn.' });
    expect(setup.turnHistory.map(turn => turn.status)).toEqual(['completed', 'inProgress']);
    await fs.writeFile(path.join(root, 'conversation-release.json'), '');
    expect((await pending).status).toBe('fixture-completed');
    expect(setup.turnHistory.map(turn => turn.status)).toEqual(['completed', 'completed']);
  } finally {
    await fs.writeFile(path.join(root, 'conversation-release.json'), '');
    await pending;
    setup.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('the production UI smoke requires hosted Windows or explicit local permission before touching Electron', () => {
  test.skip(process.platform !== 'win32', 'The production UI smoke runs on Windows.');
  const script = path.resolve(__dirname, '../scripts/check-unsigned-chat.cjs');
  const base = { ...process.env, GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'self-hosted' };
  for (const [env, options, expected] of [
    [base, [], 'opens a visible window'],
    [{ ...base, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: 'github-hosted' }, [], 'opens a visible window'],
    [{ ...base, RUNNER_ENVIRONMENT: 'github-hosted' }, [], 'absolute Codex executable path'],
    [base, ['--allow-visible-window'], 'absolute Codex executable path']
  ]) {
    // A relative executable fails before profile creation even on allowed paths.
    const result = spawnSync(process.execPath, [script, 'relative', ...options], { env, encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
  }
});

test('terminal-only HTTP errors preserve the provider failure category without its private message', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-terminal-failure-'));
  const evidence = { dispatchEnabled: true, capacity: null, binding: 'controlled' };
  const provider = new ConversationProvider({ testRoot, getEvidence: async () => evidence });
  try {
    for (const [info, reason] of [
      [{ httpConnectionFailed: { httpStatusCode: 401 } }, /sign-in expired or was rejected/],
      [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, /usage limit reached/],
      [{ httpConnectionFailed: { httpStatusCode: 503 } }, /temporarily unavailable/]
    ]) {
      await fs.writeFile(path.join(testRoot, 'conversation-provider.json'), JSON.stringify({ turn: 'failed', terminalErrorInfo: info }));
      await provider.preflight();
      await expect(provider.turn('Disposable question', { capacityBinding: evidence.binding, beforeStart: async () => {}, onState: () => {} })).rejects.toThrow(reason);
      expect(provider.controlled.state.message).not.toContain('PRIVATE_PROVIDER_DETAIL');
      expect(provider.controlled.turnHistory.at(-1).status).toBe('failed');
    }
  } finally {
    provider.close();
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('the App Server receives only a method refusal for a request to solicit user input', async () => {
  const child = [
    "process.stdin.once('data', bytes => console.log(JSON.stringify({method:'fixture/received', params:JSON.parse(bytes)})));",
    "console.log(JSON.stringify({id:'probe', method:'item/tool/requestUserInput', params:{questions:[]}}));"
  ].join('\n');
  const rpc = new CodexRpc(process.execPath, ['-e', child], {});
  try {
    const received = once(rpc, 'notification');
    const violation = once(rpc, 'violation');
    const [method, response] = await received;
    expect(await violation).toEqual(['Codex requested an unselected capability.']);
    expect(method).toBe('fixture/received');
    expect(response).toEqual({ id: 'probe', error: { code: -32601, message: 'Companion does not permit server requests.' } });
  } finally { rpc.close(); }
});

test('ordinary turns return model settings only when the App Server reported all four', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-observed-settings-'));
  const evidence = { dispatchEnabled: true, capacity: null, binding: 'controlled' };
  const provider = new ConversationProvider({ testRoot, getEvidence: async () => evidence });
  const observed = { model: 'fixture', modelProvider: 'fixture-provider', reasoningEffort: 'low', serviceTier: 'default' };
  try {
    for (const settings of [observed, { ...observed, serviceTier: null }]) {
      await fs.writeFile(path.join(testRoot, 'conversation-provider.json'), JSON.stringify({ ...settings, reply: 'Observed reply.' }));
      await provider.preflight();
      const result = await provider.turn('Disposable question', { capacityBinding: evidence.binding, beforeStart: async () => {}, onState: () => {} });
      expect(result.effective).toEqual(settings.serviceTier ? observed : undefined);
    }
  } finally {
    provider.close();
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('thread startup accepts only the isolated working folder and zero or one matching runtime root', async () => {
  const setup = new CodexSetup();
  setup.work = path.resolve('disposable-work');
  const started = { cwd: setup.work, activePermissionProfile: { id: 'companion-context' }, approvalPolicy: 'never', instructionSources: [] };
  setup.rpc = { request: async method => { expect(method).toBe('thread/start'); return started; } };
  for (const roots of [[], [setup.work]]) {
    started.runtimeWorkspaceRoots = roots;
    // The next guard requires a fresh thread identity. No turn is sent.
    await expect(runTurn(setup, 'fixture')).rejects.toThrow('did not create a fresh thread');
  }
  for (const roots of [undefined, null, [path.resolve('another-folder')], [setup.work, setup.work]]) {
    started.runtimeWorkspaceRoots = roots;
    await expect(runTurn(setup, 'fixture')).rejects.toThrow('widened the controlled context boundary');
  }
  started.runtimeWorkspaceRoots = [];
  started.cwd = path.resolve('another-folder');
  await expect(runTurn(setup, 'fixture')).rejects.toThrow('widened the controlled context boundary');
  started.cwd = setup.work;
  setup.policy = { model: 'pinned-model', model_provider: 'openai' };
  started.model = 'pinned-model';
  await expect(runTurn(setup, 'fixture')).rejects.toThrow('different model or provider');
  started.modelProvider = 'openai';
  started.model = 'another-model';
  await expect(runTurn(setup, 'fixture')).rejects.toThrow('different model or provider');
});

test('a managed account change revokes its certificate without waiting for an account notification', async () => {
  const setup = new CodexSetup();
  let account = { type: 'chatgpt', email: 'first@example.invalid' };
  setup.rpc = { request: async () => ({ account }) };
  await setup.readAccount();
  setup.certificate = { expires: Date.now() + 60000 };
  Object.assign(setup.state, { ready: true, isolationPassed: true });
  await setup.readAccount();
  expect(setup.snapshot().ready).toBe(true);
  account = { type: 'chatgpt', email: 'second@example.invalid' };
  await setup.readAccount();
  expect(setup.certificate).toBeNull();
  expect(setup.snapshot()).toMatchObject({ authenticated: true, ready: false, isolationPassed: false });
  setup.loginId = 'pending';
  account = null;
  await setup.notification('account/login/completed', { loginId: 'pending', success: true });
  expect(setup.snapshot()).toMatchObject({ authenticated: false, ready: false, status: 'incomplete' });
});

test('live evidence closes dispatch and hides settings when its certificate changes during a read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-proof-'));
  try {
    const setup = {
      snapshot: () => ({ connected: true, authenticated: true, ready: true, isolationPassed: true }),
      certificate: { fingerprint: 'original', expires: Date.now() + 60000 },
      accountDigest: 'private-account', vaultRoot: root
    };
    const capacity = { maxCodePoints: 400, model: 'model', evidence: 'input', harnessAndOutputEvidence: 'output', proof: 'first', certificate: setup.certificate };
    const settings = { modelProvider: 'provider', reasoningEffort: 'low', serviceTier: 'default', evidence: 'separate-check' };
    const observation = { ...settings, model: capacity.model, certificate: setup.certificate };
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ vault: root }));
    const reader = new ConversationEvidence({ setup, getVault: () => ({ root }), settingsPath: path.join(root, 'settings.json'),
      getVerifiedCapacity: async () => capacity, getVerifiedComparisonSettings: async () => observation });
    const valid = await reader.read();
    expect(valid.dispatchEnabled).toBe(true);
    expect(valid.comparisonSettings).toEqual(settings);
    expect(valid.capacity).not.toHaveProperty('proof');
    setup.certificate = { ...setup.certificate };
    observation.certificate = capacity.certificate = setup.certificate;
    const renewed = await reader.read();
    expect(renewed.binding).not.toBe(valid.binding);
    capacity.proof = 'second';
    const replacement = await reader.read();
    expect(replacement.binding).not.toBe(renewed.binding);
    setup.vaultRoot = path.join(root, 'different');
    expect(await reader.read()).toMatchObject({ dispatchEnabled: false, capacity: null, comparisonSettings: null });
    setup.vaultRoot = root;
    setup.accountDigest = 'replacement-account';
    expect((await reader.read()).binding).not.toBe(replacement.binding);
    capacity.model = 'another-model';
    expect(await reader.read()).toMatchObject({ dispatchEnabled: true, comparisonSettings: null });
    capacity.model = observation.model;
    reader.getVerifiedComparisonSettings = async () => {
      setup.certificate = { ...setup.certificate, fingerprint: 'replacement' };
      return observation;
    };
    expect(await reader.read()).toMatchObject({ dispatchEnabled: false, capacity: null, comparisonSettings: null });
    reader.getVerifiedComparisonSettings = async () => observation;
    expect(await reader.read()).toMatchObject({ dispatchEnabled: false, capacity: null, comparisonSettings: null });
    capacity.certificate = setup.certificate;
    expect(await reader.read()).toMatchObject({ dispatchEnabled: true, comparisonSettings: null });
    setup.certificate.expires = Date.now();
    expect(await reader.read()).toMatchObject({ dispatchEnabled: false, capacity: null, comparisonSettings: null });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
