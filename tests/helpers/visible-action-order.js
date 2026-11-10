const fs = require('node:fs/promises');

// Temporary, test-only observation. Exact names deliberately exclude every other test.
const titles = new Set([
  'moved annotations enter context only through the canonical copy and preserve independent header and footer text',
  'a missing canonical annotation keeps its recorded excluded copy outside context and relationship repair',
  'approved brief versions and saved-idea dependencies stay exact while proposals, unknown dependencies and damaged pins remain unavailable',
  'ranked matching paragraphs expose exact line anchors and explicit passage selection preserves the inspected text',
  'source inspection reads changed capture bytes after a Refresh wait and requires fresh review without a turn',
  'same-byte manual restoration preserves the literal hash while excluding its earlier conversation from the next package',
]);

async function observationRead(read, label) {
  let timer;
  // Promise.race handles a late rejection from the original read after timeout.
  const pending = Promise.resolve().then(read);
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} unavailable after 2000ms observation deadline`)), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function visibleActionOrder() {
  let sessions = [];
  return {
    reset() { sessions = []; },
    async install(app, page, testInfo) {
      if (!titles.has(testInfo.title)) return;
      const session = { ordinal: sessions.length + 1, app, page, renderer: [], errors: [] };
      sessions.push(session);
      session.quitPath = testInfo.outputPath(`visible-action-order-main-${session.ordinal}.json`);
      try { await fs.mkdir(require('node:path').dirname(session.quitPath), { recursive: true }); }
      catch (error) { session.errors.push(`evidence directory: ${error.message}`); }
      try {
        session.installation = await app.evaluate(({ ipcMain, app: mainApp }, quitPath) => {
          const diagnosticRequire = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
          const fs = diagnosticRequire('node:fs');
          const hash = value => diagnosticRequire('node:crypto').createHash('sha256').update(String(value)).digest('hex');
          const fingerprint = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
          if (!process.env.COMPANION_TEST_ROOT) throw Error('Visible-action observation requires the disposable fixture.');
          const channels = ['state', 'vault-repairs', 'choose-identity', 'context-find', 'context-passage', 'context-preview', 'conversation-list', 'conversation-preview', 'brief-propose', 'brief-state', 'brief-approve', 'idea-list', 'check-intake', 'connect-reviews', 'add-annotation'];
          const ownershipOnly = new Set(['idea-list', 'check-intake', 'connect-reviews', 'add-annotation']);
          const scalar = new Set(['id', 'key', 'digest', 'sha256', 'hash', 'token', 'approval', 'captureId', 'generation', 'sourceGeneration', 'conversationGeneration', 'version', 'briefVersion', 'conversationId', 'requestId', 'packageId', 'historyDigest', 'status', 'kind', 'start', 'end', 'count', 'limit', 'blocked', 'sourceHash', 'revisionId']);
          const nested = new Set(['all', 'matches', 'selections', 'sourceGenerations', 'sources', 'files', 'copies', 'proposed', 'approved', 'conversations', 'requests', 'package', 'brief', 'issues', 'proposalIssues', 'identityIssues', 'repairs', 'excludedSources', 'excludedHistory', 'historyExclusions', 'historyRefs', 'dependencies', 'scope']);
          // No full source, request, reply, body, settings, or directory is retained.
          function summary(value, depth = 0, field = '') {
            if (depth > 12) return { truncated: true };
            if (typeof value === 'string') {
              if (field === 'file' || field === 'path') return { length: value.length, sha256: hash(value) };
              if (scalar.has(field) || field === 'excludedSources' || field === 'excludedHistory') return value.slice(0, 256);
              return { length: value.length, sha256: hash(value), fnv1a: fingerprint(value) };
            }
            if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
            if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 48).map(item => summary(item, depth + 1, field)) };
            if (!value || typeof value !== 'object') return null;
            const result = {};
            if (Array.isArray(value.requests)) {
              const revision = JSON.stringify({ requests: value.requests, storageWarning: value.storageWarning });
              result.historyRevision = { length: revision.length, sha256: hash(revision), fnv1a: fingerprint(revision) };
            }
            for (const [key, item] of Object.entries(value)) {
              if (scalar.has(key) || nested.has(key) || ['text', 'title', 'question', 'reply', 'sections', 'references', 'file', 'path', 'storageWarning', 'error'].includes(key)) result[key] = summary(item, depth + 1, key);
            }
            if (field === 'identityIssues') for (const [key, item] of Object.entries(value).slice(0, 48)) result[key] = summary(item, depth + 1);
            return result;
          }
          const state = globalThis.__visibleActionOrder = { events: [], dropped: 0, errors: [], installed: [], missing: [], origin: { wall: Date.now(), monotonic: performance.now() } };
          const errorFields = error => ({ error: String(error?.message ?? error).slice(0, 512), code: typeof error?.code === 'string' ? error.code.slice(0, 64) : null });
          let sequence = 0, operation = 0;
          const record = event => {
            try {
              state.events.push({ sequence: ++sequence, at: performance.now(), wall: Date.now(), ...event });
              if (state.events.length > 512) { state.events.shift(); state.dropped++; }
            } catch (error) { if (state.errors.length < 8) state.errors.push(String(error.message).slice(0, 256)); }
          };
          for (const channel of channels) {
            const original = ipcMain._invokeHandlers.get(channel);
            if (!original) { state.missing.push(channel); continue; }
            ipcMain._invokeHandlers.set(channel, function (...args) {
              const id = ++operation;
              try { record({ phase: 'start', channel, operation: id, ...(ownershipOnly.has(channel) ? {} : { input: summary(args[1]) }) }); } catch {}
              let returned;
              try { returned = Reflect.apply(original, this, args); }
              catch (error) { record({ phase: 'throw', channel, operation: id, ...errorFields(error) }); throw error; }
              // Return the original value/promise. Observation cannot replace its result or error.
              const probe = phase => {
                // A queued renderer snapshot, not a claimed synchronous bridge-return timestamp.
                // Never await this probe or change delivery of the original IPC result.
                try { args[0].sender.executeJavaScript(`window.__visibleActionOrderSnapshot?.(${JSON.stringify({ phase: 'ipc-result-probe', channel, operation: id, resultPhase: phase })})`).catch(() => {}); } catch {}
              };
              const done = result => { try { record({ phase: 'return', channel, operation: id, ...(ownershipOnly.has(channel) ? {} : { output: summary(result) }) }); probe('return'); } catch {} };
              const failed = error => { record({ phase: 'reject', channel, operation: id, ...errorFields(error) }); probe('reject'); };
              if (returned && typeof returned.then === 'function') returned.then(done, failed);
              else done(returned);
              return returned;
            });
            state.installed.push(channel);
          }
          mainApp.once('before-quit', () => {
            try { fs.writeFileSync(quitPath, JSON.stringify(state)); } catch (error) { state.errors.push(String(error.message).slice(0, 256)); }
          });
          return { installed: state.installed, missing: state.missing, origin: state.origin };
        }, session.quitPath);
      } catch (error) { session.errors.push(`main installation: ${error.message}`); }
      page.on('console', message => {
        const text = message.text();
        if (!text.startsWith('__visibleActionOrder:')) return;
        try {
          session.renderer.push(JSON.parse(text.slice('__visibleActionOrder:'.length)));
          if (session.renderer.length > 256) { session.renderer.shift(); session.rendererDropped = (session.rendererDropped || 0) + 1; }
        } catch (error) { if (session.errors.length < 8) session.errors.push(`renderer transport: ${error.message}`); }
      });
      try { await page.evaluate(installRenderer); }
      catch (error) { session.errors.push(`renderer installation: ${error.message}`); }
    },
    async save(testInfo) {
      if (!titles.has(testInfo.title)) return;
      const evidence = { schema: 1, title: testInfo.title, status: testInfo.status, sessions: [] };
      for (const session of sessions) {
        let main;
        try { main = await observationRead(() => session.app.evaluate(() => globalThis.__visibleActionOrder), 'live main evidence'); }
        catch (error) {
          session.errors.push(`main evidence read: ${error.message}`);
          try { main = JSON.parse(await observationRead(() => fs.readFile(session.quitPath, 'utf8'), 'quit snapshot')); }
          catch (fallbackError) { main = { unavailable: error.message, quitSnapshotUnavailable: fallbackError.message }; }
        }
        evidence.sessions.push({ ordinal: session.ordinal, installation: session.installation, main, renderer: session.renderer, rendererDropped: session.rendererDropped || 0, observerErrors: session.errors });
      }
      // Called before each suite's existing cleanup, even when the original test fails.
      try { await fs.writeFile(testInfo.outputPath('visible-action-order.json'), JSON.stringify(evidence, null, 2)); }
      catch (error) { console.error(`Visible-action evidence could not be saved: ${error.message}`); }
    },
  };
}

function installRenderer() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installRenderer, { once: true });
    return;
  }
  if (window.__visibleActionRenderer) return;
  const state = window.__visibleActionRenderer = { sequence: 0, dropped: 0, events: [] };
  const identities = new WeakMap(); let nextIdentity = 0, action = 0;
  const identity = node => { if (!identities.has(node)) identities.set(node, ++nextIdentity); return identities.get(node); };
  // Small deterministic fingerprint, deliberately labelled rather than called SHA-256.
  const fingerprint = text => { text = String(text || ''); let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return { length: text.length, fnv1a: (h >>> 0).toString(16) }; };
  const selectors = ['#context-results', '#context-selected', '#context-manual', '#vault-repairs', '#brief-proposal', '#conversation-history'];
  const statusIds = ['context-error', 'context-summary', 'conversation-error', 'conversation-summary', 'brief-error'];
  function snapshot() {
    const result = { status: document.querySelector('[role="status"]')?.textContent.slice(0, 768), sendEnabled: !document.getElementById('conversation-send')?.disabled };
    for (const id of statusIds) result[id] = document.getElementById(id)?.textContent.slice(0, 768);
    for (const id of ['context-package', 'conversation-package', 'context-question']) result[id] = fingerprint(document.getElementById(id)?.value);
    for (const id of ['context-manual', 'conversation-select', 'conversation-brief']) result[id] = document.getElementById(id)?.value.slice(0, 256);
    for (const selector of selectors) {
      const parent = document.querySelector(selector);
      result[selector] = parent ? { node: identity(parent), ...fingerprint(parent.textContent), children: [...parent.children].slice(0, 24).map(node => ({ node: identity(node), tag: node.tagName, id: node.id, ...fingerprint(node.textContent), title: fingerprint(node.querySelector('h3,:scope > p')?.textContent), texts: [...node.querySelectorAll('pre')].slice(0, 8).map(p => fingerprint(p.textContent)), values: [...node.querySelectorAll('textarea,input')].slice(0, 8).map(e => fingerprint(e.value)), anchors: [...node.querySelectorAll('.context-passage > p')].slice(0, 8).map(p => p.textContent.slice(0, 256)), requestId: node.dataset.requestId })) } : null;
    }
    const proposal = document.getElementById('brief-proposal');
    result.proposalIdentity = proposal?.querySelector(':scope > p')?.textContent.slice(0, 256);
    result.proposalValues = proposal ? [...proposal.querySelectorAll('textarea,input')].slice(0, 24).map(node => ({ node: identity(node), value: fingerprint(node.value) })) : [];
    result.approvedVersions = [...document.querySelectorAll('[id^="brief-approved-"]')].slice(0, 24).map(node => node.id);
    return result;
  }
  function record(event) {
    try {
      const item = { sequence: ++state.sequence, at: performance.now(), wall: Date.now(), ...event, snapshot: snapshot() };
      state.events.push(item); if (state.events.length > 256) { state.events.shift(); state.dropped++; }
      console.debug('__visibleActionOrder:' + JSON.stringify(item));
    } catch { /* Observation must never change an application action. */ }
  }
  window.__visibleActionOrderSnapshot = record;
  const region = '#context-section,#conversation-section,#brief-view,#vault-repairs';
  const wrapped = new WeakSet();
  function wrapHandlers() {
    for (const node of document.querySelectorAll(`${region.split(',').map(selector => `${selector} button`).join(',')},#context-find,#context-preview,#conversation-preview,#brief-propose,#refresh`)) {
      if (!node.onclick || wrapped.has(node.onclick)) continue;
      const original = node.onclick;
      const wrapper = function (...args) {
        const id = ++action;
        record({ phase: 'handler-start', action: id, node: identity(node), control: node.id || node.textContent.slice(0, 128) });
        let returned;
        try { returned = Reflect.apply(original, this, args); }
        catch (error) { record({ phase: 'handler-throw', action: id, error: String(error?.message ?? error).slice(0, 512) }); throw error; }
        const done = () => record({ phase: 'handler-return', action: id });
        const failed = error => record({ phase: 'handler-reject', action: id, error: String(error?.message ?? error).slice(0, 512) });
        if (returned && typeof returned.then === 'function') returned.then(done, failed); else done();
        return returned;
      };
      wrapped.add(wrapper); node.onclick = wrapper;
    }
  }
  for (const event of ['click', 'input', 'change']) document.addEventListener(event, e => {
    if (!e.isTrusted) return;
    const node = e.target.closest('button,input,textarea,select'); if (!node) return;
    record({ phase: event, trusted: true, node: identity(node), control: node.id || node.textContent.slice(0, 128), value: 'value' in node ? fingerprint(node.value) : undefined });
  }, true);
  // Observe property writes at the real invalidation/publication boundary; no polling.
  const value = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  for (const id of ['context-package', 'conversation-package']) {
    const node = document.getElementById(id); if (!node) continue;
    Object.defineProperty(node, 'value', { configurable: true, enumerable: value.enumerable, get() { return value.get.call(this); }, set(next) {
      value.set.call(this, next);
      record({ phase: 'package-value-write', control: id, value: fingerprint(value.get.call(this)), stack: new Error().stack?.split('\n').slice(1, 8).map(line => line.replace(/file:\/\/\/[^\s)]+\//g, 'file:///fixture/')) });
    } });
  }
  const observer = new MutationObserver(() => { wrapHandlers(); record({ phase: 'dom' }); });
  for (const selector of [...selectors, ...statusIds.map(id => '#' + id), '[role="status"]', '#brief-view']) {
    const node = document.querySelector(selector); if (node) observer.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  }
  wrapHandlers(); record({ phase: 'installed' });
}

module.exports = { visibleActionOrder };
