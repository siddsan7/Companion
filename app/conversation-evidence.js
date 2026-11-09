const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Only this main-owned accessor reads private proof. Its public identity is random,
// process-local and contains no account, credential or certificate-derived value.
class ConversationEvidence {
  constructor({ setup, getVault, settingsPath, testRoot, getVerifiedCapacity = async () => null, getVerifiedComparisonSettings = async () => null }) {
    Object.assign(this, { setup, getVault, settingsPath, testRoot, getVerifiedCapacity, getVerifiedComparisonSettings });
    this.chain = Promise.resolve();
  }
  read() {
    const next = this.chain.then(() => this.current());
    this.chain = next.catch(() => {}); return next;
  }
  async optional(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async current() {
    const settings = await this.optional(this.settingsPath);
    const controlled = this.testRoot ? await this.optional(path.join(this.testRoot, 'conversation-evidence.json')) : null;
    const raw = controlled ? controlled.capacity : this.testRoot ? await this.optional(path.join(this.testRoot, 'context-bound.json')) : await this.getVerifiedCapacity();
    let capacity = null;
    if (raw !== null && raw !== undefined) {
      if (!Number.isSafeInteger(raw.maxCodePoints) || raw.maxCodePoints < 1 || typeof raw.model !== 'string' || !raw.model.trim() || typeof raw.evidence !== 'string' || !raw.evidence.trim() || raw.harnessAndOutputEvidence !== undefined && (typeof raw.harnessAndOutputEvidence !== 'string' || !raw.harnessAndOutputEvidence.trim())) throw Error('Verified input bound is invalid. Repair its evidence and preview again.');
      // Whitelist inspectable capacity provenance, never spread a private proof object.
      capacity = { maxCodePoints: raw.maxCodePoints, model: raw.model, evidence: raw.evidence, ...(raw.harnessAndOutputEvidence === undefined ? {} : { harnessAndOutputEvidence: raw.harnessAndOutputEvidence }) };
    }
    const rawSettings = controlled ? controlled.comparisonSettings : this.testRoot ? null : await this.getVerifiedComparisonSettings();
    let comparisonSettings = null;
    if (rawSettings !== null && rawSettings !== undefined) {
      if (typeof rawSettings.modelProvider !== 'string' || !rawSettings.modelProvider.trim() || (typeof rawSettings.reasoningEffort !== 'string' || !rawSettings.reasoningEffort.trim()) || typeof rawSettings.serviceTier !== 'string' || !rawSettings.serviceTier.trim() || typeof rawSettings.evidence !== 'string' || !rawSettings.evidence.trim()) throw Error('Verified comparison settings are invalid. Repair their evidence and preview again.');
      comparisonSettings = { modelProvider: rawSettings.modelProvider, reasoningEffort: rawSettings.reasoningEffort, serviceTier: rawSettings.serviceTier, evidence: rawSettings.evidence };
    }
    const state = this.setup.snapshot();
    const dispatchEnabled = !controlled || controlled.dispatchEnabled === true;
    const identity = JSON.stringify({ capacity, settings, comparisonSettingsProof: rawSettings, vault: this.getVault()?.root, controlled,
      generation: this.setup.generation, ready: state.ready, isolationPassed: state.isolationPassed,
      authenticated: state.authenticated, certificate: this.setup.certificate || null });
    if (identity !== this.identity) { this.identity = identity; this.binding = randomUUID(); }
    return { capacity, binding: this.binding, dispatchEnabled, comparisonSettings };
  }
}
module.exports = { ConversationEvidence };
