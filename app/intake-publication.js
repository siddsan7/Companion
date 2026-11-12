const { validProof } = require('./staged-publication');

const roles = ['snapshotStage', 'captureStage', 'backup'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactProof = proof => validProof(proof) && Object.keys(proof).length === 3;
const validRole = (role, proof) => role === 'detach'
  ? proof && Object.keys(proof).length === 2 && exactProof(proof.intent) && exactProof(proof.stage)
  : roles.includes(role) && exactProof(proof);
const matchesProof = (proof, expected) => !!proof && !!expected &&
  proof.dev === expected.dev && proof.ino === expected.ino && proof.digest === expected.digest;

function validateStageRecords(ledger) {
  const records = ledger.intakeStageRecords;
  if (records === undefined) return;
  if (!records || typeof records !== 'object' || Array.isArray(records) ||
      Object.entries(records).some(([digest, record]) => !record || !sha(record.sourceHash) ||
        !exactProof(record.journal) || digest !== record.journal.digest ||
        Object.keys(record).some(key => key !== 'sourceHash' && key !== 'journal' &&
          !validRole(key, record[key])))) {
    throw Error('Invalid intake stage ownership. Recovery files were preserved.');
  }
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

module.exports = { validateStageRecords, stageRecord, retireStageRecords, matchesProof };
