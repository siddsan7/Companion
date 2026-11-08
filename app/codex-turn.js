const { PROFILE, INSTRUCTIONS, samePath } = require('./codex-policy');
function failureMessage(info) {
  if (['usageLimitExceeded', 'sessionBudgetExceeded', 'rateLimitExceeded'].includes(info)) return 'Codex usage limit reached. Check your account limits, then retry explicitly.';
  if (info === 'unauthorized') return 'Codex sign-in expired or was rejected. Sign in again, verify isolation, then retry explicitly.';
  if (info && typeof info === 'object' && ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected'].some(key => Object.hasOwn(info, key))) return 'Codex is offline or its connection failed. Check your connection, then retry explicitly.';
  if (info === 'sandboxError') return 'Codex isolation failed. Check Windows setup and verify isolation again.';
  if (['serverOverloaded', 'flexUnavailable'].includes(info)) return 'Codex is temporarily unavailable. Retry explicitly when the service is available.';
  return 'Codex turn failed. The partial reply is incomplete. Check setup and retry explicitly.';
}
async function runTurn(setup, text) {
  const rpc = setup.rpc;
  const started = await rpc.request('thread/start', { cwd: setup.work, runtimeWorkspaceRoots: [setup.work], permissions: PROFILE, approvalPolicy: 'never', ephemeral: true, environments: [], selectedCapabilityRoots: [], dynamicTools: [], baseInstructions: INSTRUCTIONS, developerInstructions: '' });
  if (!samePath(started.cwd, setup.work) || started.approvalPolicy !== 'never' || started.activePermissionProfile?.id !== PROFILE || started.activePermissionProfile.extends || !Array.isArray(started.runtimeWorkspaceRoots) || started.runtimeWorkspaceRoots.length !== 1 || !samePath(started.runtimeWorkspaceRoots[0], setup.work) || !Array.isArray(started.instructionSources) || started.instructionSources.length) throw Error('Codex thread widened the controlled context boundary.');
  const threadId = started.thread?.id;
  if (!threadId || setup.threads.has(threadId)) throw Error('Codex did not create a fresh thread.');
  setup.threads.add(threadId);
  setup.state.reply = ''; setup.state.turnActive = true; setup.state.status = 'running';
  const record = { threadId, turnId: null, status: 'inProgress', model: started.model, completedAt: null };
  setup.turnHistory.push(record);
  let turnId, terminal, unexpected = false, resolveTerminal, fatalFailure, historySaved = false;
  const completed = new Promise(resolve => { resolveTerminal = resolve; });
  setup.settleTurn = status => { terminal = status; resolveTerminal(status); };
  const handler = (method, params) => {
    if (params?.threadId !== threadId) return;
    if (method === 'turn/started' && params.turn?.id) turnId = params.turn.id;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      setup.state.reply += params.delta;
      if (!setup.replySaveTimer) setup.replySaveTimer = setTimeout(() => { setup.replySaveTimer = null; setup.persist().catch(() => rpc.close('Cannot preserve the incomplete Codex reply.')); }, 50);
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!['userMessage', 'agentMessage', 'reasoning'].includes(params.item?.type)) {
        unexpected = true; rpc.close('An unselected tool or context item appeared.');
      }
      if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') setup.state.reply = params.item.text;
    }
    if (method === 'turn/completed') { turnId = params.turn?.id || turnId; setup.settleTurn(params.turn?.status || 'failed'); }
    if (method === 'error' && params.willRetry !== true) {
      fatalFailure = failureMessage(params.error?.codexErrorInfo);
      setup.state.message = fatalFailure;
      if (params.error?.codexErrorInfo === 'unauthorized') setup.state.authenticated = false;
      // The error notification is not a terminal event. Wait for turn/completed or bounded timeout.
    }
  };
  rpc.on('notification', handler);
  const timeout = setTimeout(() => { rpc.close('Codex turn timed out.'); setup.settleTurn?.('interrupted'); }, 90000);
  try {
    await setup.persist();
    historySaved = true;
    const response = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }], environments: [] });
    turnId = response.turn?.id || turnId;
    if (!turnId) throw Error('Codex did not identify the active turn.');
    setup.activeTurn = { threadId, turnId };
    record.turnId = turnId; await setup.persist();
    if (setup.cancelRequested) await rpc.request('turn/interrupt', setup.activeTurn);
    const reported = terminal || await completed;
    const status = fatalFailure && reported === 'completed' ? 'failed' : reported;
    Object.assign(record, { turnId, status, completedAt: new Date().toISOString() });
    if (unexpected) throw Error('Unselected tool or context item prevented completion.');
    if (status !== 'completed') {
      const error = Error(status === 'interrupted' ? 'Codex turn interrupted. The partial reply is incomplete. Retry explicitly.' : fatalFailure || 'Codex turn failed. The partial reply is incomplete. Retry explicitly.');
      error.terminalStatus = status === 'interrupted' ? 'interrupted' : 'failed'; throw error;
    }
    if (!setup.state.reply.trim()) throw Error('Codex completed without an assistant reply.');
    return setup.state.reply;
  } catch (error) {
    // Once turn/start can have reached the server, a lost acknowledgement is ambiguous.
    // Preserve an interrupted local terminal; never call it completed or replay it.
    const interrupted = historySaved && (record.status === 'interrupted' || rpc.closed);
    Object.assign(record, { turnId: turnId || null, status: interrupted ? 'interrupted' : 'failed', completedAt: new Date().toISOString() });
    if (!error.terminalStatus) error.terminalStatus = record.status;
    if (!historySaved) error.message = 'Codex history could not be saved. No model request was sent. Check application-data access and retry explicitly.';
    else if (rpc.closed) error.message = 'Codex turn interrupted because the App Server connection closed. The partial reply is incomplete. Retry explicitly.';
    throw error;
  } finally {
    clearTimeout(timeout); clearTimeout(setup.interruptTimer);
    clearTimeout(setup.replySaveTimer); setup.replySaveTimer = null;
    rpc.off('notification', handler); setup.activeTurn = null; setup.settleTurn = null; setup.cancelRequested = false; setup.state.turnActive = false;
  }
}
module.exports = { runTurn };
