// One explicit synthetic hosted turn in an existing signed-in disposable qualification profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexSetup, SYNTHETIC_PROMPT } = require('../app/codex');
const { audit } = require('../app/codex-isolation');
const { canonical } = require('../app/codex-policy');
const { openTrace, observe, retireTrace } = require('./chat-trace-retirement.cjs');
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

async function inspectTrace(trace, record, reply) {
  trace.entries = [trace.entries[0]];
  assert(record.status === 'completed' && typeof reply === 'string' && reply.trim());
  const bundles = await fs.readdir(trace.root, { withFileTypes: true });
  assert(bundles.length === 1 && bundles[0].isDirectory());
  const name = bundles[0].name;
  assert(name.startsWith('trace-') && name.endsWith('-' + record.threadId));
  const traceId = name.slice(6, -37);
  assert(uuid.test(traceId));
  // Build the candidate plan separately. A partial or unverified bundle grants no leaf removal.
  const plan = { root: trace.root, entries: [trace.entries[0]] };
  observe(plan, name, true);
  observe(plan, path.join(name, 'payloads'), true);
  const manifest = JSON.parse(observe(plan, path.join(name, 'manifest.json')));
  assert(manifest.trace_id === traceId && manifest.root_thread_id === record.threadId && manifest.rollout_id === record.threadId);
  assert(manifest.schema_version === 2 && manifest.raw_event_log === 'trace.jsonl' && manifest.payloads_dir === 'payloads');
  const events = observe(plan, path.join(name, 'trace.jsonl')).toString('utf8').trim().split('\n').map(JSON.parse);
  const inference = events.filter(event => event.payload.type.startsWith('inference_'));
  same(inference.map(event => event.payload.type), ['inference_started', 'inference_completed']);
  const [start, completion] = inference;
  same(Object.keys(start.payload).sort(), ['codex_turn_id', 'inference_call_id', 'model', 'provider_name', 'request_payload', 'thread_id', 'type']);
  same(Object.keys(completion.payload).sort(), ['inference_call_id', 'response_id', 'response_payload', 'type', 'upstream_request_id']);
  assert(start.payload.request_payload?.kind?.type === 'inference_request' && completion.payload.response_payload?.kind?.type === 'inference_response');
  assert(inference.every(event => event.thread_id === record.threadId && event.codex_turn_id === record.turnId));
  assert(start.payload.thread_id === record.threadId && start.payload.codex_turn_id === record.turnId);
  assert(start.payload.model === record.model && start.payload.provider_name === 'OpenAI');
  assert(uuid.test(start.payload.inference_call_id) && completion.payload.inference_call_id === start.payload.inference_call_id);
  assert(typeof completion.payload.response_id === 'string' && completion.payload.response_id.trim());
  assert(completion.payload.upstream_request_id === null || typeof completion.payload.upstream_request_id === 'string' && completion.payload.upstream_request_id.trim());
  let toolDigest, verifiedReply = false;
  const seen = new Set();
  for (const event of events) {
    assert((event.thread_id === null || event.thread_id === record.threadId) && event.rollout_id === record.threadId);
    for (const [field, ref] of Object.entries(event.payload)) {
      if (!ref?.raw_payload_id) continue;
      const match = /^payloads\/([1-9][0-9]*)\.json$/.exec(ref.path);
      assert(match && ref.raw_payload_id === 'raw_payload:' + match[1] && !seen.has(ref.path));
      seen.add(ref.path);
      const value = JSON.parse(observe(plan, path.join(name, 'payloads', match[1] + '.json')));
      if (ref.kind.type === 'inference_request') {
        assert(event === start && field === 'request_payload' && !toolDigest);
        toolDigest = inspectSignedRequest(value, record, SYNTHETIC_PROMPT);
      } else if (ref.kind.type === 'inference_response') {
        assert(event === completion && field === 'response_payload' && !verifiedReply);
        assert(value.response_id === completion.payload.response_id && value.upstream_request_id === completion.payload.upstream_request_id);
        assert(Array.isArray(value.output_items) && value.output_items.every(item => item.type === 'reasoning' || item.type === 'message'));
        const messages = value.output_items.filter(item => item.type === 'message');
        assert(messages.length && messages.every(item => item.role === 'assistant' && item.status === 'completed' &&
          Array.isArray(item.content) && item.content.every(part => part.type === 'output_text' && typeof part.text === 'string')));
        assert(messages.map(item => item.content.map(part => part.text).join('')).join('\n\n') === reply);
        assert(Number.isSafeInteger(record.usage?.last?.totalTokens) && record.usage.last.totalTokens > 0);
        assert(value.token_usage?.total_tokens === record.usage.last.totalTokens);
        verifiedReply = true;
      } else if (ref.kind.type === 'session_metadata') {
        assert(field === 'metadata_payload' && event.payload.type === 'thread_started' && value.thread_id === record.threadId);
      } else {
        const legacyTypes = { turn_started: 'task_started', turn_complete: 'task_complete' };
        assert(field === 'event_payload' && ref.kind.type === 'protocol_event' && event.payload.type === 'protocol_event_observed');
        assert(value.type === (legacyTypes[event.payload.event_type] ?? event.payload.event_type));
      }
    }
  }
  assert(toolDigest && verifiedReply);
  trace.entries = plan.entries;
  return toolDigest;
}

async function main(staging, consent) {
  assert(consent === '--send-one-synthetic-turn', 'Explicit hosted qualification required.');
  const root = await fs.realpath(staging);
  assert(path.dirname(root) === await fs.realpath(os.tmpdir()) && /^companion-live-chat-[a-zA-Z0-9]+$/.test(path.basename(root)));
  const dataRoot = path.join(root, 'profile', 'codex');
  const cfg = JSON.parse(await fs.readFile(path.join(dataRoot, 'setup.json')));
  assert(cfg.sandbox === 'mxc' && cfg.project === path.join(root, 'project') && cfg.vault === path.join(root, 'vault', 'Companion'));
  for (const directory of [root, dataRoot, cfg.project, cfg.vault, path.join(dataRoot, 'managed-home')]) assert(await fs.realpath(directory) === directory);
  const trace = openTrace(await fs.mkdtemp(path.join(root, 'synthetic-trace-')));
  const setup = new CodexSetup({ dataRoot });
  // This diagnostic child traces only a fixed synthetic prompt. Production processes use their ordinary allowlisted environment.
  const startServer = setup.startServer.bind(setup);
  setup.startServer = () => { setup.launch.env.CODEX_ROLLOUT_TRACE_ROOT = trace.root; return startServer(); };
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
    const toolDigest = await inspectTrace(trace, record, result.reply);
    await setup.readAccount();
    const fingerprint = await audit(setup);
    assert(setup.state.authenticated && setup.certificate === cert && cert.fingerprint === fingerprint && Date.now() < cert.expires);
    assert(setup.generation === generation && setup.rpc === rpc && !rpc.closed);
    console.log(JSON.stringify({ model: record.model, toolDigest, currentAccountConfigAndRootsVerified: true, productionReady: false }));
  } finally {
    const child = setup.rpc?.child;
    setup.close();
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Trace writer still active.')), 5000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
      retireTrace(trace);
    }
    catch {
      console.error('Trace cleanup incomplete. Inspect the disposable staging directory for ' + path.basename(trace.root) + ' or its moved contents.');
      process.exitCode = 1;
    }
  }
}
module.exports = { inspectSignedRequest, inspectTrace };
if (require.main === module) main(...process.argv.slice(2)).catch(() => { console.error('Signed-in qualification failed. Production readiness remains closed.'); process.exitCode = 1; });
