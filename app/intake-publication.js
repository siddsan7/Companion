const { validProof } = require('./staged-publication');
const { uuid } = require('./source-authority');

const roles = ['snapshotStage', 'captureStage', 'backup'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactProof = proof => validProof(proof) && Object.keys(proof).length === 3;
const pendingName = /^pending-([a-f0-9-]{36})(?:-([a-f0-9-]{36}))?\.json$/;
const backupName = /^([a-f0-9-]{36})-([a-f0-9-]{36})\.before(?:-([a-f0-9-]{36}))?\.md$/;
const validRole = (role, proof) => role === 'detach'
  ? proof && Object.keys(proof).length === 2 && exactProof(proof.intent) && exactProof(proof.stage)
  : roles.includes(role) && exactProof(proof);
const validRecordField = (record, key) => key === 'sourceHash' || key === 'journal' ||
  (key === 'pending' ? typeof record.pending === 'string' && pendingName.test(record.pending) : validRole(key, record[key]));
const matchesProof = (proof, expected) => !!proof && !!expected &&
  proof.dev === expected.dev && proof.ino === expected.ino && proof.digest === expected.digest;

function validateStageRecords(ledger) {
  const records = ledger.intakeStageRecords;
  if (records !== undefined && (!records || typeof records !== 'object' || Array.isArray(records) ||
      Object.entries(records).some(([digest, record]) => !record || !sha(record.sourceHash) ||
        !exactProof(record.journal) || digest !== record.journal.digest ||
        !Object.keys(record).every(key => validRecordField(record, key))))) {
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

function pendingJournalProof(ledger, sourceHash, name) {
  const records = Object.values(ledger.intakeStageRecords || {}).filter(record => record.pending === name);
  if (records.length > 1 || records[0] && records[0].sourceHash !== sourceHash) {
    throw Error('Deferred intake journal ownership is ambiguous. Preserve .intake for repair.');
  }
  return records[0]?.journal;
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

function omittedRetainedBackups(backups, directory, targets, generation) {
  const omitted = [];
  for (const [name, record] of backups) {
    const file = directory + '/' + name;
    const target = targets.find(item => item.file === file);
    if (record.generation !== generation || target && (target.kind !== 'source-backup' || target.peers ||
        !matchesProof({ ...target, digest: target.sha256 }, record.proof))) {
      throw Error('Retained intake backup does not match the confirmed source deletion. Recovery files were preserved.');
    }
    if (!target) omitted.push(file);
  }
  return omitted;
}

function retireBackups(ledger, sourceHash) {
  const entries = Object.entries(ledger.retainedIntakeBackups || {}).filter(([, record]) => record.sourceHash !== sourceHash);
  if (entries.length) ledger.retainedIntakeBackups = Object.fromEntries(entries);
  else delete ledger.retainedIntakeBackups;
}

module.exports = { validateStageRecords, stageRecord, pendingJournalProof, retireStageRecords, matchesProof, retainedBackups, omittedRetainedBackups, retireBackups };
