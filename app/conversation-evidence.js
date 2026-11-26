const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { samePath } = require('./codex-policy');

// Qualified together by the signed-in request recorded in verification-ticket8.md.
const personalEstimate = Object.freeze({ model: 'gpt-6.2-sol', maxCodePoints: 12000,
  evidence: 'Personal manual preview. Estimated input limit of 12,000 Unicode code points. Reasoning and output space are not guaranteed. The provider may reject this package.' });
const qualifiedExecutable = '8d06dc231dba649c7d48d3eecab239c452a1ac498c41dd6492a6f301b90a22ce';
const qualifiedCatalog = '1fe7b99c44ff65badad9291e2a3a0e7988dbda60d57ee2132105058106282901';

// Only this main-owned accessor reads private proof. Its public identity is random,
// process-local and contains no account, credential or certificate-derived value.
class ConversationEvidence {
  constructor({ setup, getVault, settingsPath, testRoot, getVerifiedCapacity = async () => null, getVerifiedComparisonSettings = async () => null }) {
    Object.assign(this, { setup, getVault, settingsPath, testRoot, getVerifiedCapacity, getVerifiedComparisonSettings });
    this.chain = Promise.resolve();
  }
  read(personal = false) {
    const next = this.chain.then(() => this.current(personal));
    this.chain = next.catch(() => {}); return next;
  }
  async optional(file) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async current(personal) {
    const certificate = this.setup.certificate;
    const settings = await this.optional(this.settingsPath);
    const controlled = this.testRoot ? await this.optional(path.join(this.testRoot, 'conversation-evidence.json')) : null;
    const raw = controlled ? controlled.capacity : this.testRoot ? await this.optional(path.join(this.testRoot, 'context-bound.json')) : await this.getVerifiedCapacity();
    let capacity = null;
    if (raw !== null && raw !== undefined) {
      if (!Number.isSafeInteger(raw.maxCodePoints) || raw.maxCodePoints < 1 || typeof raw.model !== 'string' || !raw.model.trim() || typeof raw.evidence !== 'string' || !raw.evidence.trim() || raw.harnessAndOutputEvidence !== undefined && (typeof raw.harnessAndOutputEvidence !== 'string' || !raw.harnessAndOutputEvidence.trim())) throw Error('Verified input bound is invalid. Repair its evidence and preview again.');
      // Whitelist inspectable capacity provenance, never spread a private proof object.
      capacity = { maxCodePoints: raw.maxCodePoints, model: raw.model, evidence: raw.evidence, ...(raw.harnessAndOutputEvidence === undefined ? {} : { harnessAndOutputEvidence: raw.harnessAndOutputEvidence }) };
    }
    const candidate = controlled ? controlled.comparisonSettings : this.testRoot ? null : await this.getVerifiedComparisonSettings();
    // Live comparison observations belong to one certificate and one capacity model.
    const rawSettings = this.testRoot || (certificate && candidate?.certificate === certificate && candidate.model === capacity?.model) ? candidate : null;
    let comparisonSettings = null;
    if (rawSettings !== null && rawSettings !== undefined) {
      if (typeof rawSettings.modelProvider !== 'string' || !rawSettings.modelProvider.trim() || (typeof rawSettings.reasoningEffort !== 'string' || !rawSettings.reasoningEffort.trim()) || typeof rawSettings.serviceTier !== 'string' || !rawSettings.serviceTier.trim() || typeof rawSettings.evidence !== 'string' || !rawSettings.evidence.trim()) throw Error('Verified comparison settings are invalid. Repair their evidence and preview again.');
      comparisonSettings = { modelProvider: rawSettings.modelProvider, reasoningEffort: rawSettings.reasoningEffort, serviceTier: rawSettings.serviceTier, evidence: rawSettings.evidence };
    }
    const state = this.setup.snapshot();
    const selected = this.getVault(), vaultRoot = selected?.root;
    const liveProof = state.connected && state.authenticated && state.ready && state.isolationPassed &&
      certificate && certificate === this.setup.certificate && Date.now() < certificate.expires &&
      samePath(vaultRoot, this.setup.vaultRoot) && samePath(settings?.vault, vaultRoot);
    const dispatchEnabled = this.testRoot ? !controlled || controlled.dispatchEnabled === true :
      Boolean(liveProof && raw?.certificate === certificate && capacity?.harnessAndOutputEvidence);
    if (!this.testRoot && !dispatchEnabled) {
      capacity = null;
      comparisonSettings = null;
    }
    const identity = JSON.stringify({ dispatchEnabled, capacityProof: raw, settings, comparisonSettingsProof: rawSettings, vault: vaultRoot, controlled,
      account: this.setup.accountDigest,
      generation: this.setup.generation, ready: state.ready, isolationPassed: state.isolationPassed,
      authenticated: state.authenticated, certificate: this.setup.certificate || null });
    if (identity !== this.identity || this.boundCertificate !== this.setup.certificate) {
      this.identity = identity; this.boundCertificate = this.setup.certificate; this.binding = randomUUID();
    }
    if (personal) {
      const qualified = !this.testRoot && this.setup.identifiedChatGPT && this.setup.accountDigest &&
        state.connected && state.authenticated && state.isolationPassed && certificate && this.setup.certificate === certificate &&
        Date.now() < certificate.expires && samePath(vaultRoot, this.setup.vaultRoot) && samePath(settings?.vault, selected?.vault) &&
        typeof settings?.parent === 'string' && samePath(path.join(settings.vault, settings.parent), vaultRoot) &&
        this.setup.executableDigest === qualifiedExecutable && this.setup.catalogProof?.digest === qualifiedCatalog &&
        this.setup.policy?.model === personalEstimate.model && this.setup.policy.windows?.sandbox === 'mxc';
      return { estimate: personalEstimate, binding: 'personal-' + this.binding, dispatchEnabled: Boolean(qualified) };
    }
    return { capacity, binding: this.binding, dispatchEnabled, comparisonSettings };
  }
}
module.exports = { ConversationEvidence };
