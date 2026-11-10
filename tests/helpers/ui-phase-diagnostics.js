// Temporary, opt-in evidence for the two historical ticket 13 UI failures.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const enabled = process.env.COMPANION_UI_PHASE_DIAGNOSTICS === '1';
const limit = 256;
const append = (buffer, event) => { buffer.push(event); if (buffer.length > limit) buffer.shift(); };
const bounded = async work => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Diagnostic collection exceeded 2s')), 2000); })]); }
  finally { clearTimeout(timer); }
};
function createDiagnostics(testInfo, kind) {
  if (!enabled) return null;
  const requestedRenderControl = process.env.COMPANION_UI_RENDER_CONTROL;
  const renderControl = ['unthrottled', 'visible-unthrottled'].includes(requestedRenderControl) ? requestedRenderControl : 'baseline';
  const started = performance.now(), timeline = [], sessions = [];
  const clockStart = { at: Date.now(), monotonicMs: started, boundary: kind === 'repair' ? 'test body begins; excludes beforeEach' : 'after restoration preview; excludes all prior setup', frameworkDeadlineKnown: false };
  const mark = label => append(timeline, { label, at: Date.now(), elapsedSinceObserverMs: performance.now() - started, estimatedRemainingFromObserverMs: testInfo.timeout - (performance.now() - started) });
  return {
    mark,
    async install(app, page) {
      mark('install observers');
      await app.evaluate(({ app: mainApp, BrowserWindow }, { kind, renderControl }) => {
        const req = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
        const { Intake } = req('./intake'), { CaptureDeletion } = req('./capture-deletion');
        const { IntakeLedger } = req('./intake-ledger');
        const events = [], emit = (name, detail = {}) => {
          events.push({ name, at: Date.now(), monotonicMs: performance.now(), ...detail });
          if (events.length > 256) events.shift();
        };
        globalThis.__ticket13UI = events;
        const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
        if (windows.length !== 1) throw Error('Expected one owned diagnostic fixture window');
        const ownedWindow = windows[0], contents = ownedWindow.webContents;
        const backgroundThrottlingBefore = contents.getBackgroundThrottling();
        const visibleBefore = ownedWindow.isVisible(), focusedBefore = ownedWindow.isFocused();
        // B and C share this policy; only C changes native visibility without focus.
        if (renderControl === 'unthrottled' || renderControl === 'visible-unthrottled') contents.setBackgroundThrottling(false);
        if (renderControl === 'visible-unthrottled') ownedWindow.showInactive();
        emit('native-window', { renderControl, windowId: ownedWindow.id, webContentsId: contents.id,
          visibleBefore, focusedBefore,
          visible: ownedWindow.isVisible(), focused: ownedWindow.isFocused(),
          backgroundThrottlingBefore, backgroundThrottling: contents.getBackgroundThrottling() });
        let sequence = 0;
        const summarize = ledger => ({
          captures: Object.values(ledger.captures || {}).map(c => ({ id: c.id, revision: c.currentRevision })),
          authority: Object.entries(ledger.sourceAuthority || {}).map(([id, a]) => ({ id, phase: a.phase, generation: a.generation, operationId: a.operationId, published: a.restoration?.published, revision: a.restoration?.revision })),
          pendingCount: Object.keys(ledger.pending || {}).length, blockCount: Object.keys(ledger.blocks || {}).length
        });
        // Observe settlement of the actual promise; return that same promise to its caller.
        const wrap = (object, method, detail = () => ({}), admit = () => true) => {
          const original = object[method];
          if (typeof original !== 'function') throw Error('Missing diagnostic seam: ' + method);
          object[method] = function (...args) {
            if (!admit(args)) return original.apply(this, args);
            attachVault(this.vault || this.getVault?.());
            const call = ++sequence, info = detail(args), name = method;
            emit(name + ':start', { call, ...info });
            let result;
            try { result = original.apply(this, args); }
            catch (error) { emit(name + ':error', { call, message: error.message, stack: error.stack }); throw error; }
            if (result?.then) result.then(() => emit(name + ':return', { call, ...info }), error => emit(name + ':error', { call, message: error.message, stack: error.stack }));
            else emit(name + ':return', { call, ...info });
            return result;
          };
        };
        const seen = new WeakSet();
        const attachVault = vault => {
          if (!vault || typeof vault !== 'object' || seen.has(vault)) return;
          seen.add(vault);
          // checkpoint is assigned by the constructor, so intercept the real instance.
          wrap(vault, 'checkpoint', args => ({ checkpoint: args[0] }));
        };
        wrap(CaptureDeletion.prototype, 'confirmRestoration');
        wrap(Intake.prototype, 'load'); // captures the configured instance before repair work
        wrap(Intake.prototype, 'finish', ([tx]) => ({ operation: tx.restoreOperation, generation: tx.sourceGeneration, revision: tx.revision?.id }), ([tx]) => kind === 'repair' || !!tx.restoreOperation);
        wrap(Intake.prototype, 'resolveConflict');
        wrap(Intake.prototype, 'finishRepair');
        wrap(IntakeLedger.prototype, 'replace', ([text]) => ({ sha256: req('node:crypto').createHash('sha256').update(text).digest('hex'), ...summarize(JSON.parse(text)) }));
        emit('installed', { kind, pid: process.pid });
      }, { kind, renderControl });
      await page.evaluate(() => {
        const events = [], emit = (name, detail = {}) => {
          events.push({ name, at: Date.now(), monotonicMs: performance.now(), ...detail });
          if (events.length > 256) events.shift();
        };
        window.__ticket13UI = events;
        window.__ticket13Record = emit;
        const original = window.refresh;
        if (typeof original !== 'function') throw Error('Missing renderer refresh seam');
        let sequence = 0;
        window.refresh = function (...args) {
          const call = ++sequence;
          emit('refresh:start', { call, caller: new Error().stack });
          let result;
          try { result = original.apply(this, args); }
          catch (error) { emit('refresh:error', { call, message: error.message, stack: error.stack }); throw error; }
          result.then(() => emit('refresh:return', { call }), error => emit('refresh:error', { call, message: error.message, stack: error.stack }));
          return result;
        };
        let replacements = 0;
        const snapshot = () => ({ status: document.querySelector('[role=status]')?.textContent,
          visibility: document.visibilityState, focused: document.hasFocus(), replacements,
          restorationArticles: document.querySelectorAll('[aria-label="Source restoration"] article').length,
          captureCount: document.querySelectorAll('#captures article').length,
          apply: [...document.querySelectorAll('#vault-repairs button')].filter(b => b.textContent === 'Save annotation and apply incoming').map(b => ({ attached: b.isConnected, disabled: b.disabled, hidden: b.hidden })) });
        window.__ticket13Snapshot = snapshot;
        const observer = new MutationObserver(records => {
          const repairsReplaced = records.some(r => r.target.id === 'vault-repairs' && r.type === 'childList');
          if (repairsReplaced) replacements++;
          emit('dom', { ...snapshot(), repairsReplaced, restorationRemoved: records.some(r => r.target.closest?.('[aria-label="Source restoration"]') && [...r.removedNodes].some(n => n.nodeType === 1 && n.matches('article'))) });
        });
        for (const selector of ['[role=status]', '[aria-label="Source restoration"]', '#captures', '#vault-repairs']) {
          const target = document.querySelector(selector);
          if (target) observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
        }
        document.addEventListener('click', event => {
          const button = event.target.closest('button');
          if (button) emit('click:dispatch', { text: button.textContent, trusted: event.isTrusted, ...snapshot() });
        }, true);
        window.addEventListener('focus', () => emit('focus'));
        window.addEventListener('blur', () => emit('blur'));
        document.addEventListener('visibilitychange', () => emit('visibility', snapshot()));
        window.addEventListener('companion-base-refreshed', () => emit('base-refreshed', snapshot()));
        emit('installed', snapshot());
      });
    },
    async actionState(page, label) {
      mark(label);
      try {
        const state = await bounded(page.evaluate(() => {
          const buttons = [...document.querySelectorAll('button')].filter(b => ['Confirm source restoration', 'Save annotation and apply incoming'].includes(b.textContent));
          // Five passive callbacks run beside the original action; no frame is awaited.
          let remaining = 5, previousActual = null;
          const schedule = () => {
            const requestedAt = Date.now(), requestedMonotonicMs = performance.now();
            requestAnimationFrame(frameTimestamp => {
              const actualAt = Date.now(), actualMonotonicMs = performance.now();
              window.__ticket13Record('critical-frame', { sample: 6 - remaining, requestedAt, actualAt,
                requestedMonotonicMs, actualMonotonicMs, frameTimestamp,
                requestDeltaMs: actualMonotonicMs - requestedMonotonicMs,
                frameDeltaMs: previousActual === null ? null : actualMonotonicMs - previousActual,
                buttons: buttons.map(button => {
                  const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                  return { connected: button.isConnected, disabled: button.disabled,
                    rectangle: { x: r.x, y: r.y, width: r.width, height: r.height },
                    hit: { tag: hit?.tagName || null, id: hit?.id || null, targetBoolean: !!hit && (hit === button || button.contains(hit)) } };
                }) });
              previousActual = actualMonotonicMs;
              if (--remaining > 0) schedule();
            });
          };
          schedule();
          return { ...window.__ticket13Snapshot(), buttons: buttons.map(b => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent, connected: b.isConnected, disabled: b.disabled, hidden: b.hidden, rectangle: { x: r.x, y: r.y, width: r.width, height: r.height } };
          }) };
        }));
        append(timeline, { label, at: Date.now(), state });
      } catch (error) { mark(label + ':observation error: ' + error.message); }
    },
    async capture(app, page, label) {
      const session = { label, at: Date.now() };
      // Separate collection errors retain any available half of the observation.
      try { session.main = await bounded(app.evaluate(() => globalThis.__ticket13UI || [])); } catch (error) { session.mainError = error.message; }
      try { session.renderer = await bounded(page.evaluate(() => window.__ticket13UI || [])); } catch (error) { session.rendererError = error.message; }
      append(sessions, session);
    },
    async tail(app, page, label) {
      mark(label + ':evidence-only-tail-start');
      // No action is replayed and no assertion is retried. Observe the running operation.
      // Reserve up to 4s of the 10s tail for the two bounded buffer reads.
      await new Promise(resolve => setTimeout(resolve, 6000));
      await this.capture(app, page, label + ':after-tail');
      mark(label + ':evidence-only-tail-end');
    },
    async save(app, page, root) {
      if (app) await this.capture(app, page, 'before cleanup');
      const persisted = {};
      const intake = path.join(root, 'vault', 'Companion', '.intake');
      for (const [name, file] of [['ledger', path.join(intake, 'ledger.json')], ['faults', path.join(root, 'faults.json')], ['checkpoint', path.join(root, 'checkpoint.txt')], ['repairIntent', path.join(intake, 'repair-intent.json')]]) {
        try {
          const bytes = await bounded(fs.readFile(file));
          persisted[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
          if (name === 'checkpoint') persisted[name].value = bytes.toString();
          if (name === 'ledger') {
            const ledger = JSON.parse(bytes);
            persisted[name].authority = Object.entries(ledger.sourceAuthority || {}).map(([id, a]) => ({ id, phase: a.phase, generation: a.generation, operationId: a.operationId, published: a.restoration?.published, revision: a.restoration?.revision }));
            persisted[name].counts = Object.fromEntries(['captures', 'attempts', 'admissions', 'pending', 'blocks'].map(k => [k, Object.keys(ledger[k] || {}).length]));
          }
          if (name === 'faults') persisted[name].value = JSON.parse(bytes);
        } catch (error) { persisted[name] = { error: error.code || error.message }; }
      }
      await fs.writeFile(testInfo.outputPath('ticket13-ui-phase-diagnostics.json'), JSON.stringify({ kind, renderControl, clockStart, originalStatus: testInfo.status, originalErrors: testInfo.errors.map(e => ({ message: e.message, stack: e.stack })), timeline, sessions, persisted }, null, 2));
    }
  };
}
module.exports = { createDiagnostics };
