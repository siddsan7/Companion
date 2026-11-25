const { test, expect } = require('@playwright/test');
const { INSTRUCTIONS } = require('../app/codex-policy');
const { SYNTHETIC_PROMPT } = require('../app/codex');
const { inspectSignedRequest } = require('../scripts/check-signed-chat-request.cjs');
const tools = require('./fixtures/codex/request-user-input.json');

test('signed-in qualification checks the exact turn, tool, messages and metadata', () => {
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
