const { uuid } = require('./source-authority');
function generations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Error('Source generation attribution is unavailable.');
  let previous = '';
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'captureId') || !Object.hasOwn(item, 'generation') || !uuid(item.captureId) || !uuid(item.generation) || item.captureId <= previous) throw Error('Source generation attribution is malformed or ambiguous.');
    previous = item.captureId; return { captureId: item.captureId, generation: item.generation };
  });
}
const sameGenerations = (a, b) => JSON.stringify(generations(a?.sourceGenerations)) === JSON.stringify(generations(b?.sourceGenerations));
const sameEvidence = (a, b) => !!a && !!b && a.key === b.key && a.digest === b.digest && sameGenerations(a, b);
function unionGenerations(sources) {
  const values = new Map();
  for (const source of sources) for (const item of generations(source.sourceGenerations)) {
    if (values.has(item.captureId) && values.get(item.captureId) !== item.generation) throw Error('Source generation dependency closure conflicts.');
    values.set(item.captureId, item.generation);
  }
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([captureId, generation]) => ({ captureId, generation }));
}
const generationFields = value => { const array = generations(value); return array.length ? { sourceGenerations: array } : {}; };
const generationProvenance = source => generations(source.sourceGenerations).length ? `; source generations ${JSON.stringify(source.sourceGenerations)}` : '';
const scopeKey = key => key.replace(/^conflict-(?:local|imported):/, 'capture:');
module.exports = { generations, sameGenerations, sameEvidence, unionGenerations, generationFields, generationProvenance, scopeKey };
