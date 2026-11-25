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
