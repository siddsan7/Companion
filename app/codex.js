const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { CodexRpc } = require('./codex-rpc');
const { PROFILE, INSTRUCTIONS, policy, toToml, canonical, samePath, inside } = require('./codex-policy');
const { audit, probeIsolation } = require('./codex-isolation');
const { runTurn } = require('./codex-turn');
const { prepareProbe } = require('./codex-probe');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
class CodexSetup {
  constructor({ dataRoot, testRoot } = {}) {
    this.dataRoot = dataRoot; this.testRoot = testRoot; this.generation = 0;
    this.state = { status: 'incomplete', message: 'Verify Windows isolation before using Codex. Local capture remains available.', ready: false, isolationPassed: false, busy: false };
    this.threads = new Set(); this.turnHistory = []; this.saveTail = Promise.resolve(); this.turnLease = null;
    this.loaded = this.restore();
  }
  async restore() {
    if (!this.dataRoot) return;
    try {
      const report = JSON.parse(await fs.readFile(path.join(this.dataRoot, 'readiness.json'), 'utf8'));
      if (report.schema !== 1 || !Array.isArray(report.turns)) throw Error('Invalid readiness history.');
      this.turnHistory = report.turns.filter(turn => turn && typeof turn.threadId === 'string').map(turn => ({ threadId: turn.threadId, turnId: typeof turn.turnId === 'string' ? turn.turnId : null, status: ['completed', 'interrupted', 'failed'].includes(turn.status) ? turn.status : 'interrupted', model: typeof turn.model === 'string' ? turn.model : '', completedAt: turn.completedAt || null }));
      const last = this.turnHistory.at(-1);
      if (last?.status === 'interrupted' || ['running', 'interrupting', 'interrupted'].includes(report.status)) {
        this.state.status = 'interrupted';
        this.state.message = 'Previous Codex turn interrupted. The retained reply is incomplete. Check setup and retry explicitly.';
      } else if (last?.status === 'failed') {
        this.state.status = 'failed'; this.state.message = 'Previous Codex turn failed. Check setup and retry explicitly.';
      }
      if (typeof report.reply === 'string') this.state.reply = report.reply.slice(0, 128000);
      this.fixture = !!this.testRoot && report.evidence === 'controlled-fixture-not-live';
      // No account, connection, ready flag, permission certificate or automatic replay is restored.
    } catch (error) {
      if (error.code !== 'ENOENT') this.state.message = 'Codex history could not be restored. Local capture remains available. Check setup again.';
    }
  }
  snapshot() {
    if (this.certificate && Date.now() >= this.certificate.expires) {
      this.certificate = null;
      Object.assign(this.state, { status: 'expired', ready: false, isolationPassed: false, message: 'Isolation verification expired. Verify again before sending.' });
    }
    return structuredClone({ ...this.state, busy: !!this.state.busy || !!this.turnLease });
  }
  fail(message, status = 'incomplete') { this.certificate = null; Object.assign(this.state, { status, message, ready: false, isolationPassed: false, busy: false }); return this.snapshot(); }
  async persist() {
    if (!this.dataRoot) return;
    const generation = this.generation;
    // No credentials, sign-in codes, URLs, account identifiers or provider error payloads.
    const text = JSON.stringify({ schema: 1, status: this.state.status, ready: this.state.ready, validOnlyDuringProcess: true, message: this.state.message, checkedAt: new Date().toISOString(), evidence: this.fixture ? 'controlled-fixture-not-live' : 'live', checks: this.checks || [], turns: this.turnHistory || [], reply: this.state.reply || '' }, null, 2);
    const write = async () => {
      if (generation !== this.generation) return;
      await fs.mkdir(this.dataRoot, { recursive: true });
      const temporary = path.join(this.dataRoot, `readiness-${crypto.randomUUID()}.pending`);
      try {
        await fs.writeFile(temporary, text, { flag: 'wx' });
        if (generation !== this.generation) return;
        await fs.rename(temporary, path.join(this.dataRoot, 'readiness.json'));
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    };
    this.saveTail = this.saveTail.catch(() => {}).then(write);
    await this.saveTail;
  }
  async action(input = {}, roots = {}) {
    await this.loaded;
    let generation = this.generation;
    try {
      if (input.action === 'interrupt') return await this.interrupt();
      if (input.action === 'invalidate') { this.invalidate(); generation = this.generation; await this.persist(); return this.snapshot(); }
      if (this.turnLease) return this.snapshot();
      if (input.action === 'cancel-login') return await this.cancelLogin();
      if (this.state.busy || this.state.loginPending) return this.snapshot();
      this.state.busy = true;
      if (input.action === 'connect') { generation = this.generation + 1; await this.connect(input, roots); }
      else if (input.action === 'login') await this.login();
      else if (input.action === 'verify') await this.verify();
      else if (input.action === 'synthetic') await this.synthetic();
      else throw Error('Unknown Codex setup action.');
      if (this.generation === generation) this.state.busy = false;
    } catch (error) { if (this.generation === generation) this.fail(error.message, error.terminalStatus || 'incomplete'); }
    if (this.generation === generation) await this.persist(); return this.snapshot();
  }
  async connect(input, roots) {
    this.close(); this.checks = [];
    const project = await fs.realpath(input.project);
    const vault = roots.vault ? await fs.realpath(roots.vault) : null;
    this.vaultRoot = vault;
    this.roots = [...new Set([project, vault].filter(Boolean))];
    this.home = path.join(this.dataRoot, 'managed-home'); this.work = path.join(this.dataRoot, 'empty-work');
    for (const root of this.roots) if (inside(root, this.dataRoot) || inside(this.dataRoot, root)) throw Error('Codex data must be outside protected vault and project folders.');
    await fs.mkdir(this.home, { recursive: true }); await fs.mkdir(this.work, { recursive: true });
    this.work = await fs.realpath(this.work); this.home = await fs.realpath(this.home);
    for (const root of this.roots) if (inside(root, this.work) || inside(root, this.home)) throw Error('The dedicated Codex folders resolve inside a protected root.');
    this.policy = policy(this.work, this.roots, input.sandbox);
    this.configText = toToml(this.policy);
    const configPath = path.join(this.home, 'config.toml');
    // This home belongs only to Companion. Never read or change the user Codex home.
    await fs.writeFile(configPath, this.configText);
    await prepareProbe(this);
    this.fixture = !!this.testRoot && input.executable === 'controlled-fixture';
    if (this.fixture) await fs.writeFile(path.join(this.home, 'companion-policy.json'), JSON.stringify(this.policy));
    this.executable = this.fixture ? process.execPath : await fs.realpath(input.executable);
    this.executableDigest = hash(await fs.readFile(this.executable));
    const env = {};
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ComSpec', 'COMSPEC', 'PATH', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
    env.CODEX_HOME = this.home;
    if (this.fixture) env.ELECTRON_RUN_AS_NODE = '1';
    const args = this.fixture ? [path.join(__dirname, '../tests/fixtures/codex/server.cjs'), this.testRoot] : ['app-server', '--strict-config', '--listen', 'stdio://'];
    this.launch = { env, args };
    await this.startServer();
    // Disabling host discovery is experimental in this CLI. Enumerate metadata, disable each
    // discovered path explicitly, restart once, then require the effective inventory to be disabled.
    const inventory = await this.rpc.request('skills/list', { cwds: [this.work], forceReload: true });
    if (!Array.isArray(inventory.data) || inventory.data.some(entry => !Array.isArray(entry.skills) || entry.errors?.length)) throw Error('Cannot enumerate skills safely for the dedicated profile.');
    const discovered = inventory.data.flatMap(entry => entry.skills);
    if (discovered.length > 1000 || discovered.some(skill => !path.isAbsolute(skill.path))) throw Error('Codex returned an invalid skill inventory.');
    if (discovered.some(skill => skill.enabled !== false)) {
      this.policy.skills.config = [...new Set(discovered.map(skill => skill.path))].map(skillPath => ({ path: skillPath, enabled: false }));
      this.configText = toToml(this.policy);
      await fs.writeFile(configPath, this.configText);
      if (this.fixture) await fs.writeFile(path.join(this.home, 'companion-policy.json'), JSON.stringify(this.policy));
      this.rpc.close('Restarting Codex with explicit disabled skills.');
      this.state.busy = true;
      await this.startServer();
    }
    await this.readAccount();
    this.state.status = this.state.authenticated ? 'signed-in' : 'sign-in-required';
    this.state.message = this.state.authenticated ? 'Managed sign-in available. Verify isolation next.' : 'Sign in to the separate Companion Codex profile.';
    await fs.writeFile(path.join(this.dataRoot, 'setup.json'), JSON.stringify({ executable: this.executable, project, vault, sandbox: input.sandbox }, null, 2));
  }
  async startServer() {
    const { env, args } = this.launch;
    this.rpc = new CodexRpc(this.executable, args, { cwd: this.work, env });
    this.rpc.on('notification', (method, params) => this.notification(method, params).catch(() => this.fail('Codex account notification failed.')));
    this.rpc.on('violation', reason => { this.fail(reason); this.rpc.close(reason); });
    this.rpc.on('closed', reason => { this.state.connected = false; this.state.authenticated = false; this.clearLogin(); this.fail(reason, this.state.turnActive ? 'interrupted' : 'incomplete'); this.settleTurn?.('interrupted'); });
    await this.rpc.request('initialize', { clientInfo: { name: 'companion', title: 'Companion', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.rpc.notify('initialized'); this.state.connected = true;
  }
  async readAccount() {
    const result = await this.rpc.request('account/read', { refreshToken: false });
    this.state.authenticated = result.account?.type === 'chatgpt';
    this.accountDigest = result.account ? hash(canonical({ account: result.account, routing: result.workspaceRouting || null })) : null;
    return result;
  }
  async login() {
    if (!this.state.connected) throw Error('Check Codex setup first.');
    const result = await this.rpc.request('account/login/start', { type: 'chatgptDeviceCode' });
    if (!result.loginId || !result.userCode || !/^https:\/\//.test(result.verificationUrl || '')) throw Error('Codex did not provide a valid managed sign-in.');
    this.loginId = result.loginId;
    Object.assign(this.state, { loginPending: true, verificationUrl: result.verificationUrl, userCode: result.userCode, status: 'signing-in', message: 'Complete sign-in in your browser, or cancel here.', ready: false });
    this.loginTimer = setTimeout(() => this.cancelLogin('Sign-in expired. Start a new sign-in.').catch(() => {}), 5 * 60 * 1000);
  }
  async cancelLogin(message = 'Sign-in cancelled. Start a new sign-in when ready.') {
    const id = this.loginId; this.clearLogin();
    this.fail(message, message.includes('expired') ? 'expired' : 'cancelled');
    if (id && this.rpc && !this.rpc.closed) await this.rpc.request('account/login/cancel', { loginId: id });
    await this.persist(); return this.snapshot();
  }
  clearLogin() { clearTimeout(this.loginTimer); this.loginId = null; Object.assign(this.state, { loginPending: false, verificationUrl: null, userCode: null }); }
  async notification(method, params) {
    if (method === 'account/login/completed' && params.loginId === this.loginId) {
      this.clearLogin();
      if (!params.success) this.fail('Sign-in expired or failed. Start a new sign-in.', 'expired');
      else { try { await this.readAccount(); this.state.status = 'signed-in'; this.state.message = 'Managed sign-in complete. Verify isolation next.'; } catch { this.fail('Cannot verify the managed account.'); } }
      await this.persist();
    }
    if (method === 'account/updated') { this.certificate = null; this.state.ready = false; this.state.isolationPassed = false; this.state.authenticated = params.authMode === 'chatgpt'; this.state.message = 'Account changed. Verify isolation again.'; }
  }
  async verify() {
    if (!this.rpc || this.rpc.closed) throw Error('Check Codex setup first.');
    if (!this.vaultRoot) throw Error('Choose a vault before verifying Windows isolation.');
    this.certificate = null; this.state.ready = false; this.checks = [];
    this.state.status = 'verifying'; this.state.message = 'Auditing configuration and testing actual Windows read denials.';
    await this.readAccount();
    const fingerprint = await audit(this); this.checks.push({ check: 'effective-configuration-skills-connectors', status: 'passed' });
    await probeIsolation(this);
    if (!this.state.authenticated) throw Error('Windows probes passed. Managed sign-in is still required.');
    // Certificates never load from disk and expire quickly. Every use re-audits account/config/root identity.
    this.certificate = { fingerprint, expires: Date.now() + 10 * 60 * 1000 };
    this.state.ready = false; this.state.isolationPassed = true; this.state.status = 'isolated';
    this.state.message = 'Windows read denials passed. Send a synthetic turn to verify model completion. Capture remains available.';
  }
  async synthetic() {
    const generation = this.generation, certificate = this.certificate;
    if (!certificate || Date.now() >= certificate.expires) throw Error('Isolation verification expired. Verify again before sending.');
    await this.readAccount();
    const fingerprint = await audit(this);
    if (generation !== this.generation || this.certificate !== certificate || Date.now() >= certificate.expires || !this.state.authenticated || fingerprint !== certificate.fingerprint) throw Error('Account, executable, configuration or protected roots changed. Verify isolation again.');
    await runTurn(this, 'Synthetic Companion setup check. Reply with exactly: Companion context received. No files or tools are needed.');
    if (generation !== this.generation) return;
    // A completed turn and absence of tool events do not establish the model-visible tool inventory.
    // Keep the live gate closed until that inventory has independent installed-integration evidence.
    this.state.ready = false;
    this.state.status = this.fixture ? 'fixture-completed' : 'inventory-unverified';
    this.state.message = 'Synthetic turn completed on a fresh controlled thread. Live readiness still requires independent prompt and tool inventory verification.';
  }
  async interrupt() {
    if (!this.state.turnActive) return this.snapshot();
    this.cancelRequested = true; this.certificate = null; this.state.ready = false; this.state.status = 'interrupting'; this.state.message = 'Waiting for Codex to confirm interruption.';
    if (this.activeTurn) await this.rpc.request('turn/interrupt', this.activeTurn);
    this.interruptTimer = setTimeout(() => { this.rpc?.close('Interruption was not confirmed. The turn is incomplete.'); this.settleTurn?.('interrupted'); }, 5000);
    return this.snapshot();
  }
  invalidate(message = 'Vault or project configuration changed. Check Codex setup and verify isolation again.') { this.close(); this.fail(message); }
  close() { this.generation++; this.clearLogin(); this.certificate = null; this.rpc?.close(); this.rpc = null; Object.assign(this.state, { ready: false, isolationPassed: false, connected: false, authenticated: false, turnActive: false }); }
}
module.exports = { CodexSetup };
