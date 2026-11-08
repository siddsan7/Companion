(() => {
  const panel = document.createElement('section'); panel.setAttribute('aria-label', 'Codex setup');
  panel.innerHTML = '<h2>Codex setup</h2><p>Selected context is sent to hosted Codex inference. Sign-in is managed by Codex in a separate Companion profile.</p><label>Codex executable<input id="codex-executable" placeholder="Full path to codex.exe"></label><label>Project folder to protect<input id="codex-project" placeholder="Full path to your project"></label><label>Windows isolation<select id="codex-sandbox"><option value="mxc">MXC</option><option value="elevated">Elevated sandbox (already configured)</option></select></label><button id="codex-connect">Check Codex setup</button><button id="codex-login" disabled>Sign in with ChatGPT</button><button id="codex-cancel-login" disabled>Cancel sign-in</button><button id="codex-verify" disabled>Verify isolation</button><p id="codex-status" aria-live="polite"></p><p id="codex-login-info"></p><button id="codex-synthetic" disabled>Send synthetic turn</button><button id="codex-interrupt" disabled>Interrupt turn</button><pre id="codex-reply"></pre>';
  document.querySelector('main').append(panel);
  const el = id => document.getElementById(`codex-${id}`);
  function render(state) {
    el('status').textContent = `${state.status}: ${state.message}`;
    el('connect').disabled = !!state.busy;
    el('login').disabled = !state.connected || !!state.busy || state.authenticated;
    el('cancel-login').disabled = !state.loginPending;
    el('verify').disabled = !state.authenticated || !!state.busy;
    el('synthetic').disabled = !state.isolationPassed || !!state.busy;
    el('interrupt').disabled = !state.turnActive;
    for (const id of ['executable', 'project', 'sandbox']) el(id).disabled = !!state.busy || !!state.loginPending;
    el('reply').textContent = state.reply || '';
    el('login-info').textContent = state.verificationUrl ? `Open ${state.verificationUrl} and enter ${state.userCode}. Sign-in expires after 5 minutes.` : '';
  }
  async function run(action) {
    if (!['cancel-login', 'interrupt', 'invalidate'].includes(action)) {
      for (const id of ['connect', 'login', 'verify', 'synthetic']) el(id).disabled = true;
    }
    try { render(await window.companion['codex-action']({ action, executable: el('executable').value, project: el('project').value, sandbox: el('sandbox').value })); }
    catch { el('status').textContent = 'Setup incomplete. Check the local paths and retry.'; }
  }
  for (const [id, action] of [['connect', 'connect'], ['login', 'login'], ['cancel-login', 'cancel-login'], ['verify', 'verify'], ['synthetic', 'synthetic'], ['interrupt', 'interrupt']]) el(id).onclick = () => run(action);
  for (const id of ['executable', 'project', 'sandbox']) el(id).onchange = () => run('invalidate');
  const poll = async () => { try { render(await window.companion['codex-state']()); } catch {} };
  poll(); setInterval(poll, 500);
})();
