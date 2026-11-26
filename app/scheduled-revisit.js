const path = require('node:path');
const { CodexSetup } = require('./codex');
const { ConversationEvidence } = require('./conversation-evidence');
const { ConversationProvider } = require('./conversation-provider');
const { ControlledGate, ProductionGate } = require('./revisit-gate');
const { ordinaryDirectories, readExactSync } = require('./staged-publication');
const { samePath } = require('./codex-policy');

// Pin the active schedule and selected vault before preparing any requests. Their
// files and directories must still match when the provider submits each turn.
function bindWorker(selected, dataRoot, scheduleId, protectedDirectories, isolationValid) {
  const { guard } = ordinaryDirectories([dataRoot, selected.vault, selected.root, ...protectedDirectories], 'Scheduled worker roots changed.');
  const settingsFile = path.join(dataRoot, 'settings.json'), scheduleFile = path.join(dataRoot, 'schedule.json');
  const settings = readExactSync(settingsFile, guard), schedule = readExactSync(scheduleFile, guard);
  const configuration = JSON.parse(settings.bytes), state = JSON.parse(schedule.bytes);
  if (!scheduleId || state.id !== scheduleId || state.launchBinding !== 1 || state.mode !== 'enabled' ||
      ![configuration, state].every(record => samePath(record.vault, selected.vault) &&
        typeof record.parent === 'string' && samePath(path.join(record.vault, record.parent), selected.root))) return () => false;
  return () => {
    try {
      readExactSync(settingsFile, guard, 1, settings.proof);
      readExactSync(scheduleFile, guard, 1, schedule.proof);
      return isolationValid() === true;
    } catch { return false; }
  };
}

async function withScheduledGate({ selected, dataRoot, scheduleId, testRoot, clock, qualifyWorker, getVerifiedCapacity }, check) {
  const now = testRoot ? () => Date.parse(clock().now) : Date.now;
  if (testRoot) {
    const controlled = new ControlledGate(testRoot), fixture = await controlled.fixture();
    if (fixture?.transport !== 'stdio') return check(controlled);
    // Only the unpackaged test worker can issue this simulated independent proof.
    qualifyWorker = setup => {
      if (fixture.workerIsolation !== true) return null;
      setup.certificate = { expires: Date.now() + 60000 };
      return { certificate: setup.certificate, expires: fixture.expires };
    };
  }
  // A new process owns its setup. No live issuer currently supplies worker
  // isolation or managed-route capacity. Desktop sign-in and proofs are separate.
  const setup = new CodexSetup({ dataRoot: path.join(dataRoot, 'scheduled-codex') });
  const getVault = () => selected;
  const evidence = new ConversationEvidence({ setup, getVault, testRoot, getVerifiedCapacity, settingsPath: path.join(setup.dataRoot, 'setup.json') });
  const getEvidence = () => evidence.read();
  const provider = new ConversationProvider({ setup, getVault, testRoot, getEvidence });
  async function verifyWorker() {
    await setup.loaded;
    try {
      const proof = await qualifyWorker?.(setup, selected);
      if (!proof?.certificate || !Number.isSafeInteger(proof.expires)) return null;
      const directories = testRoot ? [] : [...setup.roots, setup.dataRoot, setup.work, setup.home];
      return bindWorker(selected, dataRoot, scheduleId, directories, () => proof.certificate === setup.certificate &&
        now() < proof.expires && Date.now() < proof.certificate.expires);
    } catch { return null; }
  }
  let verification;
  const getWorkerIsolation = () => verification ??= verifyWorker();
  try {
    return await check(new ProductionGate({ provider, getEvidence, getWorkerIsolation }));
  } finally {
    const child = (provider.controlled || setup).rpc?.child;
    const closed = child && child.exitCode === null && child.signalCode === null && new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error('Scheduled provider process did not close.')), 5000);
      child.once('close', () => { clearTimeout(deadline); resolve(); });
    });
    provider.close();
    setup.close();
    if (closed) await closed;
  }
}

module.exports = { withScheduledGate };
