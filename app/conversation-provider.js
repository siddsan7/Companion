const fs = require('node:fs/promises');
const path = require('node:path');
const { CodexSetup } = require('./codex');
const { runTurn } = require('./codex-turn');
const { audit } = require('./codex-isolation');
const { samePath } = require('./codex-policy');

// This adapter has no renderer entry point and never runs sign-in or isolation probes.
// Production uses only evidence already established by the main-owned setup gate.
class ConversationProvider {
  constructor({ setup, testRoot, getVault, getEvidence, personal = false }) {
    Object.assign(this, { setup, testRoot, getVault, getEvidence, personal });
  }
  async preflight() {
    const evidence = await this.getEvidence();
    if (this.personal && !evidence.dispatchEnabled) throw Error('Personal preview requires a qualified Codex executable and catalog, an identified ChatGPT account and current MXC isolation for this vault. Check setup and preview again.');
    if (!evidence.dispatchEnabled) throw Error('Codex chat is unavailable. Check setup and preview again. Local capture remains available.');
    if (this.testRoot) {
      await fs.access(path.join(this.testRoot, 'conversation-provider.json'));
      if (this.controlled?.rpc && !this.controlled.rpc.closed) return;
      const work = path.join(this.testRoot, 'conversation-empty-work'); await fs.mkdir(work, { recursive: true });
      const controlled = new CodexSetup({ dataRoot: path.join(this.testRoot, 'conversation-transport'), testRoot: this.testRoot });
      await controlled.loaded;
      controlled.fixture = true; controlled.work = work; controlled.executable = process.execPath;
      controlled.launch = { args: [path.join(__dirname, '../tests/fixtures/codex/server.cjs'), this.testRoot], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: work, COMPANION_CONVERSATION_FIXTURE: '1' } };
      this.controlled = controlled;
      await controlled.startServer();
      return;
    }
    const state = this.setup.snapshot(), capacity = evidence.capacity;
    const provenCapacity = Number.isSafeInteger(capacity?.maxCodePoints) && capacity.maxCodePoints > 0 && capacity.model && capacity.evidence && capacity.harnessAndOutputEvidence;
    if (!this.personal && (!state.ready || !provenCapacity)) throw Error('Codex chat is unavailable: verified isolation, prompt/tool inventory, managed sign-in and input/harness/output capacity evidence are required. Local capture remains available.');
    if (!state.isolationPassed || !state.authenticated || !this.setup.certificate || Date.now() >= this.setup.certificate.expires) throw Error('Verify managed sign-in and isolation, then preview again.');
    if (!samePath(this.setup.vaultRoot, this.getVault()?.root)) throw Error('Codex protected vault changed. Verify isolation again.');
    const certificate = this.setup.certificate;
    await this.setup.readAccount();
    const fingerprint = await audit(this.setup);
    if (!this.setup.state.authenticated || this.setup.certificate !== certificate || Date.now() >= certificate.expires || fingerprint !== certificate.fingerprint || (await this.getEvidence()).binding !== evidence.binding) throw Error('Codex account, inventory, configuration or protected roots changed. Verify isolation and preview again.');
  }
  async turn(text, { capacityBinding, beforeStart, onState, comparisonPin }) {
    if (comparisonPin && (Object.keys(comparisonPin).sort().join(',') !== 'model,modelProvider,reasoningEffort,serviceTier' || Object.values(comparisonPin).some(value => typeof value !== 'string' || !value.trim()))) throw Error('Comparison pin is invalid.');
    const setup = this.testRoot ? this.controlled : this.setup;
    const liveEvidence = this.personal ? 'personal-manual-preview' : 'verified-live-integration';
    const turnEvidence = this.testRoot ? 'controlled-fixture-not-live' : liveEvidence;
    const reply = await runTurn(setup, text, { comparisonPin, onState: snapshot => onState({ ...snapshot, evidence: turnEvidence }), beforeStart: async metadata => {
      const certificate = setup.certificate;
      await this.preflight();
      const verifyContext = await beforeStart();
      // Last asynchronous check before the shared transport sends the exact text.
      const evidence = await this.getEvidence(), capacity = this.personal ? evidence.estimate : evidence.capacity;
      if (!evidence.dispatchEnabled || evidence.binding !== capacityBinding) throw Error('Codex setup or capacity evidence changed. Check setup and preview again.');
      if (capacity && metadata.model !== capacity.model) throw Error('Codex model changed. Verify input and output capacity, then preview again.');
      if (comparisonPin && (!capacity || !capacity.harnessAndOutputEvidence || !evidence.comparisonSettings || comparisonPin.model !== capacity.model || ['modelProvider', 'reasoningEffort', 'serviceTier'].some(key => evidence.comparisonSettings[key] !== comparisonPin[key]))) throw Error('Independent comparison model/settings or capacity evidence changed or are unavailable. Nothing was sent.');
      if ([...text].length > Math.min(32000, capacity?.maxCodePoints || 32000)) throw Error('Package exceeds the context limit. Remove or explicitly shorten sources, then preview again.');
      return () => {
        verifyContext?.();
        if (!this.testRoot && (setup.certificate !== certificate || !(this.personal ? setup.snapshot().isolationPassed : setup.snapshot().ready))) throw Error('Codex isolation changed or expired. Verify setup and preview again.');
      };
    } });
    const latest = setup.turnHistory.at(-1);
    return { reply, threadId: latest.threadId, turnId: latest.turnId, model: latest.model, evidence: turnEvidence, usage: latest.usage ? structuredClone(latest.usage) : null, usageEvidence: latest.usageEvidence, ...(latest.effective ? { effective: { ...latest.effective } } : {}) };
  }
  close() { this.controlled?.close(); }
}
module.exports = { ConversationProvider };
