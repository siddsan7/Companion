const { PROFILE, INSTRUCTIONS, samePath } = require('./codex-policy');
const USAGE_UNAVAILABLE = 'Usage unavailable: no valid matching provider update was observed while this turn listener was active.';
const USAGE_OBSERVED = 'Observed provider token counters while this turn listener was active. Updates may be incomplete; not complete billing, account usage, or capacity evidence.';
function parseUsage(value) {
  const fields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.modelContextWindow !== null && (!Number.isSafeInteger(value.modelContextWindow) || value.modelContextWindow < 0)) return null;
  const read = part => part && typeof part === 'object' && !Array.isArray(part) && fields.every(key => Number.isSafeInteger(part[key]) && part[key] >= 0) ? Object.fromEntries(fields.map(key => [key, part[key]])) : null;
  const total = read(value.total), last = read(value.last);
  return total && last ? { total, last, modelContextWindow: value.modelContextWindow } : null;
}
function failureMessage(info) {
  if (['usageLimitExceeded', 'sessionBudgetExceeded', 'rateLimitExceeded'].includes(info)) return 'Codex usage limit reached. Check your account limits, then retry explicitly.';
  if (info === 'unauthorized') return 'Codex sign-in expired or was rejected. Sign in again, verify isolation, then retry explicitly.';
  if (info && typeof info === 'object' && ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected'].some(key => Object.hasOwn(info, key))) return 'Codex is offline or its connection failed. Check your connection, then retry explicitly.';
  if (info === 'sandboxError') return 'Codex isolation failed. Check Windows setup and verify isolation again.';
  if (['serverOverloaded', 'flexUnavailable'].includes(info)) return 'Codex is temporarily unavailable. Retry explicitly when the service is available.';
  return 'Codex turn failed. The partial reply is incomplete. Check setup and retry explicitly.';
}
async function runTurn(setup, text, options = {}) {
  if (setup.turnLease) throw Error('Codex is still finishing a reply. Wait for it to finish, then retry explicitly.');
  const lease = { generation: setup.generation }; setup.turnLease = lease;
  let reply, failure;
  try {
    reply = await runOwnedTurn(setup, text, options);
    if (setup.generation === lease.generation) Object.assign(setup.state, { status: 'completed', message: 'Codex turn completed. Chat readiness is checked separately.' });
  } catch (error) {
    failure = error;
    if (setup.generation === lease.generation) setup.fail(error.message, error.terminalStatus || 'failed');
  } finally {
    try {
      if (setup.generation === lease.generation) await setup.persist();
    } catch {
      if (setup.generation === lease.generation) {
        setup.certificate = null; setup.state.ready = false; setup.state.isolationPassed = false;
        if (!failure) {
          failure = Object.assign(Error('Codex setup history could not be saved. The retained reply is incomplete. Check setup and retry explicitly.'), { terminalStatus: 'interrupted' });
          setup.fail(failure.message, failure.terminalStatus);
        }
      }
    } finally { if (setup.turnLease === lease) setup.turnLease = null; }
  }
  if (failure) throw failure;
  return reply;
}
async function runOwnedTurn(setup, text, { beforeStart = async () => {}, onState = async () => {} } = {}) {
  const rpc = setup.rpc;
  const started = await rpc.request('thread/start', { cwd: setup.work, runtimeWorkspaceRoots: [setup.work], permissions: PROFILE, approvalPolicy: 'never', ephemeral: true, environments: [], selectedCapabilityRoots: [], dynamicTools: [], baseInstructions: INSTRUCTIONS, developerInstructions: '' });
  if (!samePath(started.cwd, setup.work) || started.approvalPolicy !== 'never' || started.activePermissionProfile?.id !== PROFILE || started.activePermissionProfile.extends || !Array.isArray(started.runtimeWorkspaceRoots) || started.runtimeWorkspaceRoots.length !== 1 || !samePath(started.runtimeWorkspaceRoots[0], setup.work) || !Array.isArray(started.instructionSources) || started.instructionSources.length) throw Error('Codex thread widened the controlled context boundary.');
  const threadId = started.thread?.id;
  if (typeof threadId !== 'string' || !threadId.trim() || setup.threads.has(threadId)) throw Error('Codex did not create a fresh thread.');
  setup.threads.add(threadId);
  setup.state.reply = ''; setup.state.turnActive = true; setup.state.status = 'running';
  const record = { threadId, turnId: null, status: 'inProgress', model: started.model, completedAt: null, usage: null, usageEvidence: USAGE_UNAVAILABLE };
  setup.turnHistory.push(record);
  let turnId, terminal, unexpected, resolveTerminal, fatalFailure, historySaved = false, startAttempted = false;
  const messages = new Map();
  let sinkTail = Promise.resolve(), sinkFailure;
  const preserve = () => {
    const snapshot = { threadId, turnId: turnId || null, model: started.model, reply: setup.state.reply, messages: [...messages.values()].map(message => ({ ...message })), usage: record.usage === null ? null : structuredClone(record.usage), usageEvidence: record.usageEvidence };
    sinkTail = sinkTail.then(() => onState(snapshot)).catch(error => {
      sinkFailure = error;
      rpc.close('Cannot preserve the incomplete conversation reply.'); setup.settleTurn?.('interrupted');
    });
    return sinkTail;
  };
  const completed = new Promise(resolve => { resolveTerminal = resolve; });
  setup.settleTurn = status => { terminal = status; resolveTerminal(status); };
  const validId = id => typeof id === 'string' && id.trim().length > 0;
  const rejectContext = message => { unexpected = message; rpc.close(message); setup.settleTurn?.('interrupted'); return false; };
  const bindTurn = id => {
    if (!validId(id) || turnId && turnId !== id) return rejectContext('Codex returned a malformed or mismatched turn identity. The reply is incomplete.');
    turnId = id; return true;
  };
  const preserveMessages = () => { setup.state.reply = [...messages.values()].map(message => message.text).join('\n\n'); preserve(); };
  const validateItem = item => {
    if (!item || !validId(item.id) || !['userMessage', 'agentMessage', 'reasoning'].includes(item.type)) return rejectContext('An unselected tool or malformed context item appeared. The reply is incomplete.');
    if (item.type !== 'agentMessage') return true;
    if (item.memoryCitation !== null) {
      messages.delete(item.id); preserveMessages();
      return rejectContext('Codex cited unselected memory. The retained text is incomplete. Check setup and retry explicitly.');
    }
    if (typeof item.text !== 'string' || item.phase !== null && !['commentary', 'partial_answer', 'final_answer'].includes(item.phase)) return rejectContext('Codex returned a malformed assistant message. The reply is incomplete.');
    return true;
  };
  const acceptItem = (item, done) => {
    if (!validateItem(item)) return false;
    if (item.type !== 'agentMessage') return true;
    const previous = messages.get(item.id);
    if (previous?.completed && (!done || previous.text !== item.text || previous.phase !== item.phase)) return rejectContext('Codex changed an already completed assistant item. The reply is incomplete.');
    messages.set(item.id, { id: item.id, text: done ? item.text : previous?.text || item.text, phase: item.phase, completed: done });
    preserveMessages(); return true;
  };
  const handler = (method, params) => {
    if (unexpected || rpc.closed) return;
    if (method === 'thread/tokenUsage/updated') {
      if (!startAttempted || !validId(turnId) || params?.threadId !== threadId || params?.turnId !== turnId) return;
      const usage = parseUsage(params.tokenUsage);
      if (usage) { record.usage = usage; record.usageEvidence = USAGE_OBSERVED; preserve(); }
      return;
    }
    if (!['turn/started', 'item/agentMessage/delta', 'item/started', 'item/completed', 'turn/completed', 'error'].includes(method)) return;
    if (!validId(params?.threadId)) { rejectContext('Codex returned a malformed thread identity. The reply is incomplete.'); return; }
    if (params?.threadId !== threadId) return;
    if (!bindTurn(method.startsWith('turn/') ? params.turn?.id : params.turnId)) return;
    if (method === 'item/agentMessage/delta') {
      if (!validId(params.itemId) || typeof params.delta !== 'string' || messages.get(params.itemId)?.completed) { rejectContext('Codex returned a malformed assistant delta or changed a completed item. The reply is incomplete.'); return; }
      const message = messages.get(params.itemId) || { id: params.itemId, text: '', phase: null, completed: false };
      message.text += params.delta; messages.set(params.itemId, message); preserveMessages();
      if (!setup.replySaveTimer) setup.replySaveTimer = setTimeout(() => { setup.replySaveTimer = null; setup.persist().catch(() => rpc.close('Cannot preserve the incomplete Codex reply.')); }, 50);
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!acceptItem(params.item, method === 'item/completed')) return;
    }
    if (method === 'turn/completed') {
      if (!['completed', 'interrupted', 'failed'].includes(params.turn.status)) { rejectContext('Codex did not report a terminal turn state. The reply is incomplete.'); return; }
      // Terminal snapshots can expose context even if its individual event was omitted.
      if (!Array.isArray(params.turn.items) || !['full', 'summary', 'notLoaded'].includes(params.turn.itemsView)) { rejectContext('Codex terminal items are unavailable. The reply is incomplete.'); return; }
      if (params.turn.itemsView === 'full') {
        const itemIds = new Set(), agentIds = [];
        for (const item of params.turn.items) {
          if (!validateItem(item)) return;
          if (itemIds.has(item.id)) { rejectContext('Codex full terminal items repeat an identity. The reply is incomplete.'); return; }
          itemIds.add(item.id); if (item.type === 'agentMessage') agentIds.push(item.id);
        }
        if ([...messages.keys()].some(id => !agentIds.includes(id))) { rejectContext('Codex turn interrupted: full terminal items omitted an observed assistant message. The retained text is incomplete.'); return; }
        for (const item of params.turn.items) if (!acceptItem(item, true)) return;
        const ordered = agentIds.map(id => messages.get(id));
        messages.clear(); for (const message of ordered) messages.set(message.id, message);
        preserveMessages();
      } else for (const item of params.turn.items) if (!validateItem(item)) return;
      if (params.turn.status === 'completed' && [...messages.values()].some(message => !message.completed)) {
        rejectContext('Codex did not supply a complete final reply. The retained text is incomplete. Check setup and retry explicitly.'); return;
      }
      setup.settleTurn(params.turn.status);
    }
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
    await preserve();
    if (sinkFailure) throw Error('Conversation history could not be saved. No model request was sent.');
    historySaved = true;
    await beforeStart({ threadId, model: started.model });
    startAttempted = true;
    const response = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }], environments: [] });
    if (!bindTurn(response.turn?.id)) throw Error(unexpected);
    setup.activeTurn = { threadId, turnId };
    record.turnId = turnId; await setup.persist();
    await preserve();
    if (setup.cancelRequested) await rpc.request('turn/interrupt', setup.activeTurn);
    const reported = terminal || await completed;
    await sinkTail;
    if (sinkFailure) throw Error('Conversation history could not preserve the complete reply. The retained reply is incomplete.');
    const status = fatalFailure && reported === 'completed' ? 'failed' : reported;
    Object.assign(record, { turnId, status, completedAt: new Date().toISOString() });
    if (unexpected) throw Error(unexpected);
    if (status !== 'completed') {
      const error = Error(status === 'interrupted' ? 'Codex turn interrupted. The partial reply is incomplete. Retry explicitly.' : fatalFailure || 'Codex turn failed. The partial reply is incomplete. Retry explicitly.');
      error.terminalStatus = status === 'interrupted' ? 'interrupted' : 'failed'; throw error;
    }
    if (!setup.state.reply.trim()) throw Error('Codex completed without an assistant reply.');
    return setup.state.reply;
  } catch (error) {
    // Once turn/start can have reached the server, a lost acknowledgement is ambiguous.
    // Preserve an interrupted local terminal; never call it completed or replay it.
    const interrupted = startAttempted && (record.status === 'interrupted' || rpc.closed);
    Object.assign(record, { turnId: turnId || null, status: interrupted ? 'interrupted' : 'failed', completedAt: new Date().toISOString() });
    if (!error.terminalStatus) error.terminalStatus = record.status;
    if (!historySaved) error.message = 'Codex history could not be saved. No model request was sent. Check application-data access and retry explicitly.';
    else if (unexpected) error.message = unexpected;
    else if (startAttempted && rpc.closed) error.message = 'Codex turn interrupted because the App Server connection closed. The partial reply is incomplete. Retry explicitly.';
    throw error;
  } finally {
    clearTimeout(timeout); clearTimeout(setup.interruptTimer);
    clearTimeout(setup.replySaveTimer); setup.replySaveTimer = null;
    rpc.off('notification', handler); setup.activeTurn = null; setup.settleTurn = null; setup.cancelRequested = false; setup.state.turnActive = false;
    await sinkTail;
  }
}
module.exports = { runTurn };
