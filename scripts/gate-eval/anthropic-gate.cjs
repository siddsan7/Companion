// Anthropic API client for the revisit gate evaluation (developer tool, never loaded by
// the app). It sends one gate package per call, with the same system text the Codex
// catalog gives the production model, and records usage and cost against a cumulative
// spend ledger with a hard cap. The API key is read from a file outside the repository
// and is never printed or written anywhere else.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evalHome = process.env.COMPANION_EVAL_HOME || path.join(os.homedir(), '.companion-eval');
const keyFile = path.join(evalHome, 'keys.env');
const ledgerFile = path.join(evalHome, 'spend.jsonl');
// US dollars per million tokens, first-party API list prices (claude-api reference, cached
// 2026-11-03). Haiku's price holds for prompts under 100K tokens; gate packages are under
// 32,000 characters.
const prices = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 }
};
const maxTokens = 16000;
const catalog = require('../../app/codex-model-catalog.json');
const systemText = catalog.models[0].base_instructions;

function readKey(file = keyFile) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw Error(`No key file at ${file}. Create it with one line: ANTHROPIC_API_KEY=<key>`); }
  const line = text.split(/\r?\n/).find(item => item.startsWith('ANTHROPIC_API_KEY='));
  const key = line?.slice('ANTHROPIC_API_KEY='.length).trim();
  if (!key) throw Error(`ANTHROPIC_API_KEY is empty in ${file}.`);
  return key;
}

const costOf = (model, usage) => {
  const price = prices[model];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * price.input + (usage.output_tokens || 0) * price.output) / 1e6;
};

// Cumulative across every run on this PC, so repeated runs cannot together pass the cap.
class SpendLedger {
  constructor({ cap, file = ledgerFile }) { Object.assign(this, { cap, file }); }
  total() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return text.split('\n').filter(Boolean).reduce((sum, line) => sum + JSON.parse(line).costUsd, 0);
  }
  // Refuses a call whose worst case (full input estimate plus max_tokens of output) could pass the cap.
  reserve(model, text) {
    const price = prices[model], worst = ([...text].length / 2 * price.input + maxTokens * price.output) / 1e6;
    const spent = this.total();
    if (spent + worst > this.cap) throw Error(`Spend cap reached: $${spent.toFixed(4)} spent, a worst-case call costs $${worst.toFixed(4)}, cap $${this.cap}. Remaining candidates stay unsent.`);
  }
  record(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }
}

// Returns judge(text) -> { reply, model, settings, usage, costUsd, elapsedMs, stopReason, requestId }.
// One call per package, no automatic rerolls (D56-I04). The SDK's own retries cover
// transport errors and rate limits only; they never resample a completed reply.
function createJudge({ model, effort, ledger, client }) {
  if (!prices[model]) throw Error(`No price recorded for ${model}; add it before spending.`);
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    client = new Anthropic({ apiKey: readKey() });
  }
  const settings = { effort, maxTokens, thinking: 'adaptive (model default)', fallbacks: 'none: a fallback would change the model under test' };
  return async function judge(text) {
    ledger.reserve(model, text);
    const started = Date.now();
    const response = await client.messages.create({
      model, max_tokens: maxTokens, system: systemText,
      output_config: { effort },
      messages: [{ role: 'user', content: text }]
    });
    const elapsedMs = Date.now() - started, usage = response.usage, costUsd = costOf(model, usage);
    ledger.record({ model, effort, costUsd, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, requestId: response._request_id ?? null });
    const reply = response.stop_reason === 'refusal' ? '' : response.content.filter(block => block.type === 'text').map(block => block.text).join('');
    return { reply, model: response.model, settings, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }, costUsd, elapsedMs, stopReason: response.stop_reason, requestId: response._request_id ?? null };
  };
}

module.exports = { createJudge, SpendLedger, readKey, prices, costOf, systemText, maxTokens, keyFile, ledgerFile };
