const { validProof } = require('./staged-publication');
const { uuid } = require('./source-authority');

const roles = ['snapshotStage', 'captureStage', 'backup'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactProof = proof => validProof(proof) && Object.keys(proof).length === 3;
const backupName = /^([a-f0-9-]{36})-([a-f0-9-]{36})\.before(?:-([a-f0-9-]{36}))?\.md$/;
const validRole = (role, proof) => role === 'detach'
  ? proof && Object.keys(proof).length === 2 && exactProof(proof.intent) && exactProof(proof.stage)
  : roles.includes(role) && exactProof(proof);
const matchesProof = (proof, expected) => !!proof && !!expected &&
  proof.dev === expected.dev && proof.ino === expected.ino && proof.digest === expected.digest;

function validateStageRecords(ledger) {
  const records = ledger.intakeStageRecords;
  if (records !== undefined && (!records || typeof records !== 'object' || Array.isArray(records) ||
      Object.entries(records).some(([digest, record]) => !record || !sha(record.sourceHash) ||
        !exactProof(record.journal) || digest !== record.journal.digest ||
        Object.keys(record).some(key => key !== 'sourceHash' && key !== 'journal' &&
          !validRole(key, record[key]))))) {
    throw Error('Invalid intake stage ownership. Recovery files were preserved.');
  }
  const backups = ledger.retainedIntakeBackups;
  if (backups !== undefined && (!backups || typeof backups !== 'object' || Array.isArray(backups) ||
      Object.entries(backups).some(([name, record]) => {
        const match = backupName.exec(name);
        return !match || !uuid(match[1]) || !uuid(match[2]) || match[3] !== undefined && !uuid(match[3]) ||
          !record || Object.keys(record).length !== 3 || !sha(record.sourceHash) ||
          ledger.captures[record.sourceHash]?.id !== match[1] || !ledger.captures[record.sourceHash].revisions?.includes(match[2]) ||
          record.generation !== null && !uuid(record.generation) || !exactProof(record.proof);
      }))) throw Error('Invalid retained intake backup ownership. Recovery files were preserved.');
}

function stageRecord(ledger, sourceHash, journal) {
  const record = ledger.intakeStageRecords?.[journal.digest];
  if (!record) return undefined;
  if (record.sourceHash !== sourceHash || !matchesProof(record.journal, journal)) {
    throw Error('Intake stage ownership no longer matches the exact journal. Recovery files were preserved.');
  }
  return record;
}

function retireStageRecords(ledger, remove) {
  if (!ledger.intakeStageRecords) return;
  const remaining = Object.entries(ledger.intakeStageRecords).filter(([, record]) => !remove(record));
  if (remaining.length) ledger.intakeStageRecords = Object.fromEntries(remaining);
  else delete ledger.intakeStageRecords;
}

function retainedBackups(ledger, sourceHash) {
  return Object.entries(ledger.retainedIntakeBackups || {}).filter(([, record]) => record.sourceHash === sourceHash);
}

function verifyRetainedBackups(backups, directory, targets, generation) {
  for (const [name, record] of backups) {
    const target = targets.find(item => item.kind === 'source-backup' && item.file === directory + '/' + name);
    if (record.generation !== generation || !target || target.peers || !matchesProof({ ...target, digest: target.sha256 }, record.proof)) {
      throw Error('Retained intake backup does not match the confirmed source deletion. Recovery files were preserved.');
    }
  }
}

function retireBackups(ledger, sourceHash) {
  const entries = Object.entries(ledger.retainedIntakeBackups || {}).filter(([, record]) => record.sourceHash !== sourceHash);
  if (entries.length) ledger.retainedIntakeBackups = Object.fromEntries(entries);
  else delete ledger.retainedIntakeBackups;
}

module.exports = { validateStageRecords, stageRecord, retireStageRecords, matchesProof, retainedBackups, verifyRetainedBackups, retireBackups };
