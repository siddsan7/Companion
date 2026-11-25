const { test, expect } = require('@playwright/test');
const { INSTRUCTIONS } = require('../app/codex-policy');
const { SYNTHETIC_PROMPT } = require('../app/codex');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openTrace, retireTrace } = require('../scripts/chat-trace-retirement.cjs');
const { inspectSignedRequest, inspectTrace } = require('../scripts/check-signed-chat-request.cjs');
const tools = require('./fixtures/codex/request-user-input.json');

function sample() {
  const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const record = { threadId: id(1), turnId: id(2), model: 'gpt-6.2-sol' };
  const { threadId, turnId, model } = record, windowId = threadId + ':0';
  const metadata = {
    installation_id: id(3), session_id: threadId, thread_id: threadId, agent_name: '/root', turn_id: turnId,
    window_id: windowId, window_number: 0, context_window_id: id(4), request_kind: 'turn', history_initialization: 'new',
    root_turn_id: turnId, sandbox: 'windows_mxc', sandbox_mode: 'read-only', auto_review_enabled: false,
    node_repl_auto_review_required: false, node_repl_disabled: false, turn_started_at_unix_ms: 101,
    analytics_enabled: true, model, reasoning_effort: 'low'
  };
  const body = {
    model, stream: true, input: [{ type: 'additional_tools', role: 'developer', id: 'at_' + id(5), tools }],
    tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'low', context: 'all_turns' },
    store: false, include: ['reasoning.encrypted_content'], text: { verbosity: 'low' }, prompt_cache_key: threadId,
    client_metadata: { turn_id: turnId, 'x-codex-turn-metadata': JSON.stringify(metadata), session_id: threadId,
      mcp_attribution: '{"status":"none"}', 'x-codex-window-id': windowId, 'x-codex-installation-id': id(3),
      thread_id: threadId, root_turn_id: turnId }
  };
  for (const [role, text, kind, provenance] of [
    ['developer', INSTRUCTIONS, 'model.base_instructions', { type: 'harness', hook: false }],
    ['user', SYNTHETIC_PROMPT, 'user.text', { type: 'user' }]
  ]) {
    body.input.push({ type: 'message', id: 'msg_' + id(body.input.length + 5), role, content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: 100, content_item_kinds: [kind],
        content_item_metadata: [{ provenance }] } });
  }
  return { body, record, metadata, id };
}

test('signed-in qualification checks the exact turn, tool, messages and metadata', () => {
  const { body, record, metadata, id } = sample();
  expect(inspectSignedRequest(body, record, SYNTHETIC_PROMPT)).toBe('bea3af5e12e25a7cc6033838fa1c1af998e8d91fc32a61cc51211410c8f0cb8a');
  for (const mutate of [
    b => { b.client_metadata.path = 'unreviewed'; },
    b => { b.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ ...metadata, sandbox: 'changed' }); },
    b => { b.input[2].internal_chat_message_metadata_passthrough.content_item_metadata[0].provenance.note = 'unreviewed'; },
    b => { b.input[2].content[0].text += 'unreviewed'; }, b => { b.input[0].tools[0].description += 'changed'; },
    b => { b.reasoning.effort = 'high'; }, b => { b.model = 'changed'; }, b => { b.client_metadata.turn_id = id(9); }
  ]) {
    const changed = structuredClone(body);
    mutate(changed);
    expect(() => inspectSignedRequest(changed, record, SYNTHETIC_PROMPT)).toThrow();
  }
});

test('only a validated synthetic trace authorizes retirement of its referenced payloads', async () => {
  const { body, record, id } = sample();
  const temp = await fs.realpath(os.tmpdir());
  const staging = await fs.mkdtemp(path.join(temp, 'companion-live-chat-'));
  const root = await fs.mkdtemp(path.join(staging, 'synthetic-trace-'));
  const trace = openTrace(root);
  const { threadId, turnId } = record;
  const bundle = path.join(root, 'trace-' + id(9) + '-' + threadId), payloads = path.join(bundle, 'payloads');
  const ref = (ordinal, type) => ({ raw_payload_id: 'raw_payload:' + ordinal, path: 'payloads/' + ordinal + '.json', kind: { type } });
  try {
    await fs.mkdir(payloads, { recursive: true });
    await fs.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ schema_version: 2, trace_id: id(9), root_thread_id: threadId,
      rollout_id: threadId, raw_event_log: 'trace.jsonl', payloads_dir: 'payloads' }));
    const reply = 'Synthetic retained reply.';
    Object.assign(record, { status: 'completed', usage: { last: { totalTokens: 20 } } });
    const events = [
      { type: 'inference_started', inference_call_id: id(8), thread_id: threadId, codex_turn_id: turnId, model: record.model,
        provider_name: 'OpenAI', request_payload: ref(1, 'inference_request') },
      { type: 'inference_completed', inference_call_id: id(8), response_id: 'fixture-response', upstream_request_id: null, response_payload: ref(2, 'inference_response') }
    ].map(payload => ({ thread_id: threadId, codex_turn_id: turnId, rollout_id: threadId, payload }));
    const response = { response_id: 'fixture-response', upstream_request_id: null, token_usage: { total_tokens: 20 },
      output_items: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: reply }] }] };
    const requestFile = path.join(payloads, '1.json'), responseFile = path.join(payloads, '2.json');
    async function write(eventsToWrite, request, result) {
      await fs.writeFile(path.join(bundle, 'trace.jsonl'), eventsToWrite.map(event => JSON.stringify(event)).join('\n'));
      await fs.writeFile(requestFile, JSON.stringify(request));
      if (result) await fs.writeFile(responseFile, JSON.stringify(result));
      else await fs.rm(responseFile, { force: true });
    }
    const changed = [
      ['missing completion', s => s.events.pop()],
      ['missing start', s => s.events.shift()],
      ['reversed events', s => s.events.reverse()],
      ['duplicate completion', s => s.events.push(s.events[1])],
      ['duplicate request', s => s.events.unshift(s.events[0])],
      ['absent call IDs', s => s.events.forEach(e => delete e.payload.inference_call_id)],
      ['empty call IDs', s => s.events.forEach(e => { e.payload.inference_call_id = ''; })],
      ['unrelated inference call', s => { s.events[1].payload.inference_call_id = id(4); }],
      ['unrelated completion thread', s => { s.events[1].thread_id = id(4); }],
      ['unrelated completion turn', s => { s.events[1].codex_turn_id = id(4); }],
      ['wrong nested request turn', s => { s.events[0].payload.codex_turn_id = id(4); }],
      ['missing response reference', s => delete s.events[1].payload.response_payload],
      ['missing response file', s => { s.result = null; }],
      ['wrong request field', s => { const p = s.events[0].payload; p.metadata_payload = p.request_payload; delete p.request_payload; }],
      ['wrong response field', s => { const p = s.events[1].payload; p.other_payload = p.response_payload; delete p.response_payload; }],
      ['extra response field', s => { s.events[1].payload.other_payload = s.events[1].payload.response_payload; }],
      ['swapped references', s => { const [a,b] = s.events.map(e => e.payload); [a.request_payload,b.response_payload] = [b.response_payload,a.request_payload]; }],
      ['aliased response file', s => { s.events[1].payload.response_payload = ref(1, 'inference_response'); }],
      ['different response identity', s => { s.result.response_id = 'another'; }],
      ['wrong response content', s => { s.result.output_items[0].content[0].text = 'unrelated'; }],
      ['empty response', s => { s.result.output_items = []; }],
      ['wrong usage', s => { s.result.token_usage.total_tokens = 99; }],
      ['unrelated request contents', s => { s.request = { unrelated: true }; }]
    ];
    for (const [label, change] of changed) await test.step(label, async () => {
      const state = structuredClone({ events, request: body, result: response });
      change(state);
      await write(state.events, state.request, state.result);
      await expect(inspectTrace(trace, record, reply)).rejects.toThrow();
      expect(trace.entries).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(requestFile, 'utf8'))).toEqual(state.request);
    });
    expect(() => retireTrace(trace)).toThrow(/cleanup incomplete/);
    await write(events, body, response);
    expect(await inspectTrace(trace, record, reply)).toMatch(/^[a-f0-9]{64}$/);
    retireTrace(trace);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    expect(path.dirname(await fs.realpath(staging))).toBe(temp);
    await fs.rm(staging, { recursive: true, force: true });
  }
});
