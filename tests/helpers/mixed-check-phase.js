const fs = require('node:fs/promises');

const title = 'mixed retention holds a missing receipted output before first native source unlink without republication';
const prefix = '__mixedCheckPhase:';

async function observationRead(read) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Observation unavailable after 2000ms')), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function mixedCheckPhase() {
  let sessions = [], setupSaved = false;
  async function snapshot(session) {
    const result = { ordinal: session.ordinal, installation: session.installation, errors: [...session.errors], rendererOrigin: 'bounded host console stream', renderer: { events: [...session.renderer], dropped: session.rendererDropped } };
    try {
      result.main = await observationRead(() => session.app.evaluate(() => {
        const state = globalThis.__mixedCheckPhase;
        return state ? { origin: 'live main memory', sequence: state.sequence, dropped: state.dropped, events: state.events } : { unavailable: 'observer not installed' };
      }));
    } catch (error) { result.main = { unavailable: String(error.message).slice(0, 256), origin: 'live main read failed; no quit-file fallback' }; }
    return result;
  }
  async function write(testInfo, name, phase) {
    if (testInfo.title !== title) return;
    try {
      const records = [];
      for (const session of sessions) records.push(await snapshot(session));
      await fs.mkdir(require('node:path').dirname(testInfo.outputPath(name)), { recursive: true });
      await fs.writeFile(testInfo.outputPath(name), JSON.stringify({ phase, clocks: 'Main hrtime and renderer performance have separate origins; wall is Date.now().', sessions: records }, null, 2));
    } catch (error) { for (const session of sessions) session.errors.push(`save: ${String(error.message).slice(0, 256)}`); }
  }
  return {
    reset() { sessions = []; setupSaved = false; },
    async install(app, page, testInfo) {
      if (testInfo.title !== title) return;
      const session = { app, ordinal: sessions.length + 1, renderer: [], rendererDropped: 0, errors: [] };
      sessions.push(session);
      page.on('console', message => {
        try {
          const text = message.text();
          if (!text.startsWith(prefix)) return;
          session.renderer.push(JSON.parse(text.slice(prefix.length)));
          if (session.renderer.length > 256) { session.renderer.shift(); session.rendererDropped++; }
        } catch { /* Console observation cannot affect the test or renderer. */ }
      });
      try {
        session.installation = await app.evaluate(({ ipcMain, app: mainApp }) => {
          const diagnosticRequire = process.getBuiltinModule('module').createRequire(mainApp.getAppPath() + '/app/main.js');
          if (!process.env.COMPANION_TEST_ROOT) throw Error('Mixed check observation requires a disposable fixture.');
          const net = diagnosticRequire('node:net');
          const { AsyncLocalStorage } = diagnosticRequire('node:async_hooks');
          const labels = new AsyncLocalStorage(); // Diagnostic context only; never a lock or application state.
          const state = globalThis.__mixedCheckPhase = { events: [], sequence: 0, dropped: 0 };
          const start = process.hrtime.bigint();
          const scalar = value => typeof value === 'string' ? value.slice(0, 256) : typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
          const errorSummary = error => ({ code: scalar(error?.code), error: scalar(error?.message) });
          function record(event) {
            try {
              state.events.push({ sequence: ++state.sequence, at: Number(process.hrtime.bigint() - start) / 1e6, wall: Date.now(), ...event });
              if (state.events.length > 256) { state.events.shift(); state.dropped++; }
            } catch { /* Never replace an application result or error. */ }
          }
          function resultSummary(value) {
            const check = value?.lastCheck || value?.intake?.lastCheck;
            return { status: scalar(value?.status), lastCheckAt: scalar(check?.at), lastCheckStatus: scalar(check?.status), lastCheckTrigger: scalar(check?.trigger), vaultError: scalar(value?.vaultError) };
          }
          let call = 0, server = 0;
          const nativeListen = net.Server.prototype.listen;
          net.Server.prototype.listen = function (...args) {
            // Inspect only the documented path forms, never supplied callback/options bodies.
            let address;
            try { address = typeof args[0] === 'string' ? args[0] : args[0] && typeof args[0] === 'object' ? args[0].path : undefined; } catch {}
            if (typeof address !== 'string' || !address.includes('companion-intake-')) return Reflect.apply(nativeListen, this, args);
            const owner = labels.getStore(), id = ++server;
            const pipeSuffix = address.slice(address.indexOf('companion-intake-') + 'companion-intake-'.length, address.indexOf('companion-intake-') + 'companion-intake-'.length + 64);
            const event = phase => ({ phase, server: id, pipeSuffix, channel: owner?.channel, call: owner?.call });
            record(event('pipe-listen'));
            // Intake installs its error listener before listen; these observers do not handle or replace it.
            try {
              this.once('listening', () => record(event('pipe-listening')));
              this.once('error', error => { try { record({ ...event('pipe-error'), ...errorSummary(error) }); } catch {} });
              this.once('close', () => record(event('pipe-close')));
            } catch { /* Listener observation is best effort. */ }
            try { return Reflect.apply(nativeListen, this, args); }
            catch (error) { try { record({ ...event('pipe-throw'), ...errorSummary(error) }); } catch {} throw error; }
          };
          const channels = ['check-intake', 'state', 'vault-repairs', 'idea-list', 'connect-reviews'];
          const missing = [];
          for (const channel of channels) {
            const original = ipcMain._invokeHandlers.get(channel);
            if (typeof original !== 'function') { missing.push(channel); continue; }
            ipcMain._invokeHandlers.set(channel, function (...args) {
              const label = { channel, call: ++call };
              record({ phase: 'rpc-start', ...label });
              let returned;
              try { returned = labels.run(label, () => Reflect.apply(original, this, args)); }
              catch (error) { try { record({ phase: 'rpc-throw', ...label, ...errorSummary(error) }); } catch {} throw error; }
              const done = value => { try { record({ phase: 'rpc-return', ...label, ...resultSummary(value) }); } catch {} };
              const failed = error => { try { record({ phase: 'rpc-reject', ...label, ...errorSummary(error) }); } catch {} };
              // Side observation preserves the original return/promise and its rejection.
              try { if (returned && typeof returned.then === 'function') returned.then(done, failed); else done(returned); } catch {}
              return returned;
            });
          }
          record({ phase: 'installed' });
          return { channels, missing, pipe: 'actual net.Server.listen; Companion Intake paths only', attribution: 'separate diagnostic AsyncLocalStorage; absent tag means unattributed' };
        });
      } catch (error) { session.errors.push(`main install: ${String(error.message).slice(0, 256)}`); }
      try { await page.evaluate(installRenderer); }
      catch (error) { session.errors.push(`renderer install: ${String(error.message).slice(0, 256)}`); }
    },
    async saveSetup(testInfo) {
      if (testInfo.title !== title || setupSaved) return;
      setupSaved = true;
      await write(testInfo, 'mixed-check-phase-setup.json', 'after existing second Check assertion; before deliberate main exits');
    },
    async save(testInfo) { await write(testInfo, 'mixed-check-phase-final.json', 'afterEach before existing cleanup; setup file is separate and unchanged'); },
  };
}

function installRenderer() {
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', installRenderer, { once: true }); return; }
  const state = { sequence: 0, events: [], dropped: 0 };
  let action = 0;
  const status = document.querySelector('[role="status"]'), intake = document.getElementById('intake-state');
  function record(event) {
    try {
      // The current renderer appends Last check after its source paragraphs.
      const item = { sequence: ++state.sequence, at: performance.now(), wall: Date.now(), ...event,
        status: status?.textContent.slice(0, 256), intakeLastCheck: intake?.lastElementChild?.textContent.slice(0, 256) };
      state.events.push(item);
      if (state.events.length > 256) { state.events.shift(); state.dropped++; }
      console.debug('__mixedCheckPhase:' + JSON.stringify(item));
    } catch { /* No observer may change the application action. */ }
  }
  const button = document.getElementById('check-intake'), original = button?.onclick;
  if (typeof original === 'function') button.onclick = function (...args) {
    const id = ++action;
    record({ phase: 'handler-start', action: id });
    let returned;
    try { returned = Reflect.apply(original, this, args); }
    catch (error) { record({ phase: 'handler-throw', action: id, error: String(error?.message).slice(0, 256) }); throw error; }
    const done = () => record({ phase: 'handler-return', action: id });
    const failed = error => record({ phase: 'handler-reject', action: id, error: String(error?.message).slice(0, 256) });
    try { if (returned && typeof returned.then === 'function') returned.then(done, failed); else done(); } catch {}
    return returned;
  };
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target.closest('#check-intake')) record({ phase: 'trusted-check-click' });
  }, true);
  const observer = new MutationObserver(() => record({ phase: 'status-or-intake-change' }));
  for (const node of [status, intake]) if (node) observer.observe(node, { childList: true, characterData: true, subtree: true });
  record({ phase: 'installed', checkHandlerWrapped: typeof original === 'function' });
}

module.exports = { mixedCheckPhase };
