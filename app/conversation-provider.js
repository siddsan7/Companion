const fs = require('node:fs/promises');
const path = require('node:path');
const { CodexRpc } = require('./codex-rpc');
const { runTurn } = require('./codex-turn');
const { audit } = require('./codex-isolation');
const { samePath } = require('./codex-policy');

// This adapter has no renderer entry point and never runs sign-in or isolation probes.
// Production uses only evidence already established by the main-owned setup gate.
class ConversationProvider {
  constructor({ setup, testRoot, getVault, getVerifiedCapacity = () => null }) {
    Object.assign(this, { setup, testRoot, getVault, getVerifiedCapacity });
  }
  async preflight() {
    if (this.testRoot) {
      await fs.access(path.join(this.testRoot, 'conversation-provider.json'));
      if (this.controlled?.rpc && !this.controlled.rpc.closed) return;
      const work = path.join(this.testRoot, 'conversation-empty-work'); await fs.mkdir(work, { recursive: true });
      const rpc = new CodexRpc(process.execPath, [path.join(__dirname, '../tests/fixtures/codex/server.cjs'), this.testRoot], { cwd: work, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: work, COMPANION_CONVERSATION_FIXTURE: '1' } });
      this.controlled = { rpc, work, state: {}, threads: new Set(), turnHistory: [], persist: async () => {} };
      rpc.on('closed', () => this.controlled.settleTurn?.('interrupted'));
      rpc.on('violation', reason => rpc.close(reason));
      await rpc.request('initialize', { clientInfo: { name: 'companion-controlled-conversation', version: '0.1.0' } }); rpc.notify('initialized');
      return;
    }
    const state = this.setup.snapshot(), capacity = await this.getVerifiedCapacity();
    if (!state.ready || !state.isolationPassed || !state.authenticated || !this.setup.certificate || Date.now() >= this.setup.certificate.expires || !capacity || !Number.isSafeInteger(capacity.maxCodePoints) || capacity.maxCodePoints < 1 || !capacity.model || !capacity.evidence || !capacity.harnessAndOutputEvidence) throw Error('Codex chat is unavailable: verified isolation, prompt/tool inventory, managed sign-in and input/harness/output capacity evidence are required. Local capture remains available.');
    if (!samePath(this.setup.vaultRoot, this.getVault()?.root)) throw Error('Codex protected vault changed. Verify isolation again.');
    await this.setup.readAccount();
    if (!this.setup.state.authenticated || await audit(this.setup) !== this.setup.certificate.fingerprint) throw Error('Codex account, inventory, configuration or protected roots changed. Verify isolation again.');
  }
  async turn(text, { beforeStart, onState }) {
    const setup = this.testRoot ? this.controlled : this.setup;
    const reply = await runTurn(setup, text, { onState: snapshot => onState({ ...snapshot, evidence: this.testRoot ? 'controlled-fixture-not-live' : 'verified-live-integration' }), beforeStart: async metadata => {
      await this.preflight();
      if (!this.testRoot && metadata.model !== (await this.getVerifiedCapacity()).model) throw Error('Codex model changed. Verify input and output capacity, then preview again.');
      await beforeStart();
    } });
    const latest = setup.turnHistory.at(-1);
    return { reply, threadId: latest.threadId, turnId: latest.turnId, model: latest.model, evidence: this.testRoot ? 'controlled-fixture-not-live' : 'verified-live-integration', usage: null, usageEvidence: 'App Server did not provide usage through this supported transport.' };
  }
  close() { this.controlled?.rpc.close(); }
}
module.exports = { ConversationProvider };
