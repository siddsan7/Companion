// Inspect the installed App Server's request to an unsigned local stand-in. No hosted inference.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { CodexSetup } = require('../app/codex');
const { INSTRUCTIONS, toToml, canonical } = require('../app/codex-policy');
const { audit, probeIsolation } = require('../app/codex-isolation');
const { runTurn } = require('../app/codex-turn');

const provider = 'companion-inventory';
const prompt = 'Companion inventory probe. No reply is needed.';
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
// Full reviewed namespace, function description and parameter schema. Per-request item IDs vary.
const toolDigest = 'bea3af5e12e25a7cc6033838fa1c1af998e8d91fc32a61cc51211410c8f0cb8a';
const toolCall = { type: 'function_call', id: 'fc_local', call_id: 'call_local', status: 'completed', namespace: 'functions', name: 'request_user_input',
  arguments: JSON.stringify({ questions: [{ id: 'color', header: 'Color', question: 'Choose a fixture color.', options: [
    { label: 'Blue', description: 'Blue fixture' }, { label: 'Red', description: 'Red fixture' }
  ] }] }) };

function sendToolCall(response) {
  const metadata = { id: 'resp_local', object: 'response', created_at: 1795636800, model: 'gpt-6.2-sol' };
  const events = [
    { type: 'response.created', response: { ...metadata, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: toolCall.id, output_index: 0, delta: toolCall.arguments },
    { type: 'response.function_call_arguments.done', item_id: toolCall.id, output_index: 0, arguments: toolCall.arguments },
    { type: 'response.output_item.done', output_index: 0, item: toolCall },
    { type: 'response.completed', response: { ...metadata, status: 'completed', output: [toolCall] } }
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
}

function inspect(headers, body, root) {
  assert(!['authorization', 'cookie', 'chatgpt-account-id', 'openai-organization', 'x-api-key'].some(key => Object.hasOwn(headers, key)), 'Unexpected credential header.');
  assert(!JSON.stringify(body).includes(path.basename(root)), 'Request includes a disposable local path.');
  return inspectModelInput(body, prompt);
}

function inspectModelInput(body, expectedText) {
  const { input, client_metadata, prompt_cache_key, ...parameters } = body;
  const reviewed = { model: 'gpt-6.2-sol', stream: true, tool_choice: 'auto', parallel_tool_calls: false,
    reasoning: { effort: 'low', context: 'all_turns' }, store: false, include: ['reasoning.encrypted_content'], text: { verbosity: 'low' } };
  assert(canonical(parameters) === canonical(reviewed), 'Unexpected request parameters.');
  assert(Array.isArray(input) && input.length === 3, 'Unexpected input item count.');
  assert(input.every(item => /^(at|msg)_[0-9a-f-]{36}$/i.test(item.id)), 'Unexpected input item identifier.');
  const [inventory, ...messages] = input;
  assert(Object.keys(inventory).sort().join(',') === 'id,role,tools,type' && inventory.type === 'additional_tools' && inventory.role === 'developer', 'Unexpected inventory message.');
  assert.equal(hash({ tools: body.tools ?? [], additional: inventory.tools }), toolDigest, 'Model-visible tool definitions changed.');
  const expected = [['developer', INSTRUCTIONS], ['user', expectedText]];
  for (const [index, item] of messages.entries()) {
    const { id, ...visible } = item;
    const [role, text] = expected[index];
    assert(canonical(visible) === canonical({ type: 'message', role, content: [{ type: 'input_text', text }] }), 'Model-visible message differs from reviewed text.');
  }
  return { model: body.model, inputSha256: hash(body.input), toolDefinitionsSha256: toolDigest };
}

async function main(executable) {
  assert(executable && path.isAbsolute(executable), 'Supply an absolute Codex executable path.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-chat-request-'));
  const setup = new CodexSetup({ dataRoot: path.join(root, 'data') });
  const observed = [];
  let refusal, responseStatus, expectToolResult = false;
  const server = http.createServer(async (request, response) => {
    try {
      assert(request.method === 'POST' && request.url === '/v1/responses', 'Unexpected local request.');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= 1024 * 1024, 'Request exceeds diagnostic limit.');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      if (expectToolResult) {
        assert(body.input.length === 5 && canonical(body.input[3]) === canonical(toolCall), 'Follow-up differs from the local tool call.');
        const { id, ...result } = body.input[4];
        assert(/^fco_[0-9a-f-]{36}$/i.test(id) && canonical(result) === canonical({ type: 'function_call_output', call_id: toolCall.call_id, output: 'request_user_input is unavailable in Default mode' }), 'Unexpected response to the request for user input.');
        body.input = body.input.slice(0, 3);
        expectToolResult = false;
      }
      observed.push(inspect(request.headers, body, root));
      if (responseStatus === 'disconnect') { response.destroy(); return; }
      if (responseStatus === 200) {
        expectToolResult = true;
        responseStatus = 503;
        sendToolCall(response);
        return;
      }
    } catch (error) { refusal = error; }
    response.writeHead(refusal ? 400 : responseStatus, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"PRIVATE_LOCAL_PROVIDER_DETAIL"}}');
  });
  try {
    const vault = path.join(root, 'vault'), project = path.join(root, 'project');
    await Promise.all([vault, project].map(folder => fs.mkdir(folder)));
    const initial = await setup.action({ action: 'connect', executable, project, sandbox: 'mxc' }, { vault });
    assert(initial.connected && !initial.authenticated, 'Expected a new unsigned managed profile.');
    setup.close();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    setup.policy.model_provider = provider;
    setup.policy.model_providers = { [provider]: { name: provider, base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', request_max_retries: 0, stream_max_retries: 0 } };
    setup.configText = toToml(setup.policy);
    await fs.writeFile(path.join(setup.home, 'config.toml'), setup.configText);
    await setup.startServer();
    assert.equal((await setup.readAccount()).account, null);
    await audit(setup);
    await probeIsolation(setup);
    // The ordinary turn path checks the returned provider before writing turn/start.
    for (const [status, expected] of [[401, /sign-in expired or was rejected/], [429, /usage limit reached/], [503, /temporarily unavailable/]]) {
      responseStatus = status;
      const before = observed.length;
      await assert.rejects(runTurn(setup, prompt), expected);
      if (refusal) throw refusal;
      assert.equal(observed.length, before + 1, 'Expected exactly one local request per explicit turn.');
      assert.equal(setup.turnHistory.at(-1).status, 'failed');
      assert(!setup.state.message.includes('PRIVATE_LOCAL_PROVIDER_DETAIL') && !setup.snapshot().ready);
    }
    responseStatus = 200;
    await assert.rejects(runTurn(setup, prompt), /temporarily unavailable/);
    if (refusal) throw refusal;
    assert(!expectToolResult && observed.length === 5, 'Expected one automatic follow-up containing only the known tool refusal.');
    responseStatus = 'disconnect';
    await assert.rejects(runTurn(setup, prompt), /Check your connection/);
    if (refusal) throw refusal;
    assert(observed.length === 6 && setup.turnHistory.at(-1).status === 'failed' && !setup.snapshot().ready);
    console.log(JSON.stringify({ disconnectedSocket: true, target: 'unsigned-loopback', hostedInference: false, checkedStatus: [401, 429, 503], refusedTool: toolCall.name, ...observed[0] }));
  } finally {
    setup.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
module.exports = { inspectModelInput };
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
