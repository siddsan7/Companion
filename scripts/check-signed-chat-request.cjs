// One explicit synthetic hosted turn in an existing signed-in disposable qualification profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexSetup, SYNTHETIC_PROMPT } = require('../app/codex');
const { audit } = require('../app/codex-isolation');
const { canonical } = require('../app/codex-policy');
const { inspectModelInput } = require('./check-chat-request.cjs');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (actual, expected) => assert(canonical(actual) === canonical(expected), 'Request shape or value changed.');
function inspectSignedRequest(body, record, text) {
  const { threadId, turnId, model } = record;
  assert(uuid.test(threadId) && uuid.test(turnId) && body.model === model && body.prompt_cache_key === threadId);
  const meta = body.client_metadata;
  const details = JSON.parse(meta['x-codex-turn-metadata']);
  assert(uuid.test(details.installation_id) && uuid.test(details.context_window_id));
  assert(Number.isSafeInteger(details.turn_started_at_unix_ms) && details.turn_started_at_unix_ms > 0);
  const windowId = threadId + ':0';
  same(details, {
    installation_id: details.installation_id, session_id: threadId, thread_id: threadId, agent_name: '/root', turn_id: turnId,
    window_id: windowId, window_number: 0, context_window_id: details.context_window_id, request_kind: 'turn',
    history_initialization: 'new', root_turn_id: turnId, sandbox: 'windows_mxc', sandbox_mode: 'read-only',
    auto_review_enabled: false, node_repl_auto_review_required: false, node_repl_disabled: false,
    turn_started_at_unix_ms: details.turn_started_at_unix_ms, analytics_enabled: true, model, reasoning_effort: 'low'
  });
  same(JSON.parse(meta.mcp_attribution), { status: 'none' });
  same(meta, {
    turn_id: turnId, 'x-codex-turn-metadata': meta['x-codex-turn-metadata'], session_id: threadId, mcp_attribution: meta.mcp_attribution,
    'x-codex-window-id': windowId, 'x-codex-installation-id': details.installation_id, thread_id: threadId, root_turn_id: turnId
  });
  assert(body.input.length === 3);
  const input = body.input.map((item, index) => {
    if (index === 0) return item;
    const { internal_chat_message_metadata_passthrough: metadata, ...visible } = item;
    assert(Number.isFinite(metadata.create_time) && metadata.create_time > 0);
    const developer = index === 1;
    same(metadata, {
      turn_id: turnId, create_time: metadata.create_time, content_item_kinds: [developer ? 'model.base_instructions' : 'user.text'],
      content_item_metadata: [{ provenance: developer ? { type: 'harness', hook: false } : { type: 'user' } }]
    });
    return visible;
  });
  return inspectModelInput({ ...body, input }, text).toolDefinitionsSha256;
}

async function inspectTrace(traceRoot, record) {
  const bundles = await fs.readdir(traceRoot, { withFileTypes: true });
  assert(bundles.length === 1 && bundles[0].isDirectory());
  const bundle = path.join(traceRoot, bundles[0].name);
  const events = (await fs.readFile(path.join(bundle, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = events.filter(event => event.payload.type === 'inference_started');
  assert(starts.length === 1 && starts[0].thread_id === record.threadId && starts[0].codex_turn_id === record.turnId);
  const ref = starts[0].payload.request_payload;
  assert(ref.kind.type === 'inference_request' && /^payloads\/[0-9]+\.json$/.test(ref.path));
  const requestPath = path.join(bundle, ref.path);
  assert(await fs.realpath(requestPath) === requestPath);
  return inspectSignedRequest(JSON.parse(await fs.readFile(requestPath, 'utf8')), record, SYNTHETIC_PROMPT);
}

async function main(staging, consent) {
  assert(consent === '--send-one-synthetic-turn', 'Explicit hosted qualification required.');
  const root = await fs.realpath(staging);
  assert(path.dirname(root) === await fs.realpath(os.tmpdir()) && /^companion-live-chat-[a-zA-Z0-9]+$/.test(path.basename(root)));
  const dataRoot = path.join(root, 'profile', 'codex');
  const cfg = JSON.parse(await fs.readFile(path.join(dataRoot, 'setup.json')));
  assert(cfg.sandbox === 'mxc' && cfg.project === path.join(root, 'project') && cfg.vault === path.join(root, 'vault', 'Companion'));
  for (const directory of [root, dataRoot, cfg.project, cfg.vault, path.join(dataRoot, 'managed-home')]) assert(await fs.realpath(directory) === directory);
  const trace = await fs.mkdtemp(path.join(root, 'synthetic-trace-'));
  const setup = new CodexSetup({ dataRoot });
  // This diagnostic child traces only a fixed synthetic prompt. Production processes use their ordinary allowlisted environment.
  const startServer = setup.startServer.bind(setup);
  setup.startServer = () => { setup.launch.env.CODEX_ROLLOUT_TRACE_ROOT = trace; return startServer(); };
  try {
    assert((await setup.action({ ...cfg, action: 'connect' }, { vault: cfg.vault })).authenticated);
    assert((await setup.action({ action: 'verify' })).isolationPassed);
    const cert = setup.certificate, rpc = setup.rpc, generation = setup.generation;
    const limits = (await rpc.request('account/rateLimits/read', {})).rateLimits;
    assert(Number.isFinite(limits?.primary?.usedPercent) && limits.primary.usedPercent < 100);
    assert(!limits.secondary || Number.isFinite(limits.secondary.usedPercent) && limits.secondary.usedPercent < 100);
    const count = setup.turnHistory.length;
    const result = await setup.action({ action: 'synthetic' });
    const record = setup.turnHistory.at(-1);
    assert(result.status === 'inventory-unverified' && !result.ready && setup.turnHistory.length === count + 1 && record.status === 'completed');
    const toolDigest = await inspectTrace(trace, record);
    await setup.readAccount();
    const fingerprint = await audit(setup);
    assert(setup.state.authenticated && setup.certificate === cert && cert.fingerprint === fingerprint && Date.now() < cert.expires);
    assert(setup.generation === generation && setup.rpc === rpc && !rpc.closed);
    console.log(JSON.stringify({ model: record.model, toolDigest, currentAccountConfigAndRootsVerified: true, productionReady: false }));
  } finally {
    setup.close();
    // Remove only this process's trace directory, never follow a replacement junction.
    assert(path.dirname(trace) === root && await fs.realpath(trace) === trace && (await fs.lstat(trace)).isDirectory());
    await fs.rm(trace, { recursive: true, force: false });
  }
}
module.exports = { inspectSignedRequest };
if (require.main === module) main(...process.argv.slice(2)).catch(() => { console.error('Signed-in qualification failed. Production readiness remains closed.'); process.exitCode = 1; });
