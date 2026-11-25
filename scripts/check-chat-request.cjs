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

function inspect(headers, body, root) {
  assert(!['authorization', 'cookie', 'chatgpt-account-id', 'openai-organization', 'x-api-key'].some(key => Object.hasOwn(headers, key)), 'Unexpected credential header.');
  assert(!JSON.stringify(body).includes(path.basename(root)), 'Request includes a disposable local path.');
  const { input, client_metadata, prompt_cache_key, ...parameters } = body;
  const reviewed = { model: 'gpt-6.2-sol', stream: true, tool_choice: 'auto', parallel_tool_calls: false,
    reasoning: { effort: 'low', context: 'all_turns' }, store: false, include: ['reasoning.encrypted_content'], text: { verbosity: 'low' } };
  assert(canonical(parameters) === canonical(reviewed), 'Unexpected request parameters.');
  assert(Array.isArray(input) && input.length === 3, 'Unexpected input item count.');
  assert(input.every(item => /^(at|msg)_[0-9a-f-]{36}$/i.test(item.id)), 'Unexpected input item identifier.');
  const [inventory, ...messages] = input;
  assert(Object.keys(inventory).sort().join(',') === 'id,role,tools,type' && inventory.type === 'additional_tools' && inventory.role === 'developer', 'Unexpected inventory message.');
  assert.equal(hash({ tools: body.tools ?? [], additional: inventory.tools }), toolDigest, 'Model-visible tool definitions changed.');
  const expected = [['developer', INSTRUCTIONS], ['user', prompt]];
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
  let refusal;
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
      observed.push(inspect(request.headers, JSON.parse(Buffer.concat(chunks)), root));
    } catch (error) { refusal = error; }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"Local request inspection complete."}}');
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
    await assert.rejects(runTurn(setup, prompt));
    if (refusal) throw refusal;
    assert.equal(observed.length, 1, 'Expected exactly one local model request.');
    console.log(JSON.stringify({ target: 'unsigned-loopback', hostedInference: false, ...observed[0] }));
  } finally {
    setup.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
