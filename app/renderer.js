const $ = id => document.getElementById(id);
let selectedVault, view = 'today', state, configurationEpoch = 0, configurationBusy = false, refreshEpoch = 0;
let checkingIntake = false, connectingIntake = false, savingCapture = false, configuringVault = false;
let scheduleView, updatingSchedule = false;
const status = message => { document.querySelector('[role=status]').textContent = message; };
function scopeError(error, owned) {
  const earlier = error.canReport;
  return Object.assign(error, { canReport: () => owned() && (typeof earlier !== 'function' || earlier()) });
}
async function action(work) { try { await work(); } catch (error) { if (typeof error.canReport === 'function' && !error.canReport()) return; status(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } }
function day(instant, timezone) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant)); }
function retireCaptureLinks() {
  for (const open of $('captures').querySelectorAll('[data-open-capture]')) open.disabled = true;
}
async function refresh() {
  const owner = configurationEpoch; if (configurationBusy) return;
  const request = ++refreshEpoch, owned = () => request === refreshEpoch && owner === configurationEpoch && !configurationBusy;
  retireCaptureLinks();
  window.intakeView.retireRepairs();
  try {
    const snapshot = await window.companion.state();
    if (!owned()) return;
    state = snapshot; $('location').textContent = state.location || 'Choose your vault and a parent folder to begin.';
    $('warnings').textContent = [...new Set(state.warnings)].join(' ');
    const sourceHold = state.warnings.find(warning => warning.startsWith('Source restoration held:'));
    if (state.vaultError || sourceHold) status(state.vaultError || sourceHold);
    window.intakeView.render(state.intake, state.location);
    updateIntakeControls();
    $('schedule-state').textContent = state.schedule ? `${state.schedule.mode} | Next scheduled check: ${state.schedule.next} | Anchor: ${state.schedule.anchor} | Last success: ${state.intake?.lastSuccess?.at || state.schedule.lastSuccess?.at || 'None'} | Worker: ${state.schedule.worker?.status || 'Not run'}${state.schedule.taskError || state.schedule.workerError || state.schedule.inspectionError ? ` | Error: ${state.schedule.taskError || state.schedule.workerError || state.schedule.inspectionError}` : ''}${!state.schedule.effective && state.schedule.mode !== 'disabled' ? ' | Task missing: use Repair daily intake.' : ''}${state.schedule.taskMismatch ? ' | Task state differs: use Repair daily intake.' : ''}${state.schedule.policyMismatch ? ' | Task schedule differs: use Repair daily intake.' : ''}` : 'Daily intake is not configured.';
    scheduleView = state.location ? { location: state.location, scheduleId: state.scheduleRecordId } : null;
    updateScheduleControls();
    await window.intakeView.repairs(owned);
    if (!owned()) return;
    $('timezone').textContent = `${view === 'today' ? 'Today' : 'All captures'} · ${state.timezone} · ${day(state.now, state.timezone)}`;
    $('captures').replaceChildren();
    const query = $('search').value.toLowerCase();
    const notes = state.captures.filter(note => (view !== 'today' || day(note.capturedAt, state.timezone) === day(state.now, state.timezone)) && note.content.toLowerCase().includes(query));
    if (!notes.length) $('captures').textContent = 'No captures in this view. Try All captures or change your search.';
    for (const note of notes) {
      const article = document.createElement('article'), heading = document.createElement('h3'), details = document.createElement('p'), content = document.createElement('pre'), label = document.createElement('label'), input = document.createElement('input'), save = document.createElement('button'), open = document.createElement('button');
      heading.textContent = note.title; details.textContent = `${note.type} · ${new Date(note.capturedAt).toLocaleString(undefined, { timeZone: state.timezone })} · ${note.id}`;
      const imported = state.intake && Object.values(state.intake.captures).find(capture => capture.id === note.id);
      if (imported?.revisions.length > 1) details.textContent += ` · Updated source ${imported.updatedAt} · ${imported.revisions.length} revisions`;
      if (imported?.conflict) details.textContent += ` · Update paused: ${imported.conflict}`;
      content.textContent = note.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
      label.textContent = 'Display title'; input.value = note.title; label.append(input); save.textContent = 'Save title'; open.textContent = 'Open in Obsidian';
      save.onclick = () => action(async () => { await window.companion.title({ id: note.id, title: input.value }); await refresh(); status('Title saved.'); });
      open.dataset.openCapture = '';
      open.onclick = () => action(async () => {
        const current = () => owned() && open.isConnected && !open.disabled;
        if (!current()) return;
        try {
          await window.companion['open-note'](note.id);
          if (current()) status('Requested Obsidian to open the note.');
        } catch (error) { if (current()) throw scopeError(error, current); }
      });
      article.append(heading, details, content, label, save, open); $('captures').append(article);
      if (['thought', 'link', 'reel_import'].includes(note.type)) {
        const remove = document.createElement('button'); remove.textContent = 'Delete capture';
        remove.onclick = () => action(() => window.captureDeletionView.preview(note.id)); article.append(remove);
      }
      if (note.type === 'reel_import') { const inspect = document.createElement('button'); inspect.textContent = 'Inspect source'; inspect.onclick = () => action(() => window.intakeView.inspect(note.id)); article.append(inspect); }
    }
    window.dispatchEvent(new CustomEvent('companion-base-refreshed', { detail: { configurationEpoch: owner, location: state.location } }));
  } catch (error) { if (owned()) throw scopeError(error, owned); }
  finally { if (owned()) window.intakeView.settleRepairs(); }
}
const scheduleControls = ['enable', 'pause', 'resume', 'disable', 'repair'].map(operation => $('schedule-' + operation));
function updateScheduleControls() {
  for (const control of scheduleControls) control.disabled = configuringVault || updatingSchedule || !scheduleView;
}
for (const [operation, result] of Object.entries({ enable: 'enabled', pause: 'paused', resume: 'resumed', disable: 'disabled', repair: 'repaired' })) {
  const control = $('schedule-' + operation);
  control.onclick = () => {
    if (control.disabled || !scheduleView) return;
    const selection = scheduleView, owner = configurationEpoch;
    const owned = () => owner === configurationEpoch && !configurationBusy;
    updatingSchedule = true; updateScheduleControls(); status('Updating daily intake...');
    return action(async () => {
      try {
        await window.companion['schedule-' + operation](selection);
        if (owned()) status('Daily intake ' + result + '.');
      } catch (error) { if (owned()) throw scopeError(error, owned); }
      finally {
        try { if (owned()) await refresh(); }
        finally { updatingSchedule = false; updateScheduleControls(); }
      }
    });
  };
}
function updateCaptureControl() { $('save').disabled = $('configure').disabled = savingCapture || configuringVault; }
function updateIntakeControls() {
  const pending = checkingIntake || connectingIntake || configuringVault;
  for (const id of ['check-intake', 'connect-drafts', 'connect-reviews']) $(id).disabled = pending;
  $('reconnect-source').disabled = pending || !$('reconnect-selection').value;
}
$('choose').onclick = () => action(async () => { selectedVault = await window.companion['choose-vault'](); $('vault').textContent = selectedVault || 'Selection cancelled.'; });
$('configure').onclick = () => {
  if ($('configure').disabled) return;
  const owner = ++configurationEpoch; configurationBusy = true; configuringVault = true; $('vault-repairs').replaceChildren();
  scheduleView = null;
  updateCaptureControl(); updateIntakeControls(); updateScheduleControls();
  retireCaptureLinks();
  return action(async () => {
    try {
      await window.companion.configure({ vault: selectedVault, parent: $('parent').value });
      if (owner !== configurationEpoch) return;
      configurationBusy = false; await refresh(); if (owner === configurationEpoch) status('Vault ready.');
    } catch (error) {
      if (owner !== configurationEpoch) return;
      if (configurationBusy) { configurationBusy = false; await refresh().catch(() => {}); }
      throw error;
    } finally {
      if (owner === configurationEpoch) {
        configurationBusy = false; configuringVault = false;
        updateCaptureControl(); updateIntakeControls(); updateScheduleControls();
        window.dispatchEvent(new Event('companion-vault-configured'));
      }
    }
  });
};
$('add-excerpt').onclick = () => { $('excerpt-label').hidden = false; $('excerpt').focus(); };
$('save').onclick = () => {
  if ($('save').disabled) return;
  const owner = configurationEpoch, owned = () => owner === configurationEpoch && !configurationBusy;
  const input = { text: $('text').value, excerpt: $('excerpt').value };
  savingCapture = true; updateCaptureControl();
  return action(async () => {
    try {
      await window.companion.capture(input);
      if (!owned()) return;
      if ($('text').value === input.text && $('excerpt').value === input.excerpt) { $('text').value = ''; $('excerpt').value = ''; }
      try { await refresh(); }
      catch (error) {
        if (owned() && (typeof error.canReport !== 'function' || error.canReport())) status('Capture saved. Refresh Browse to update the list.');
        return;
      }
      if (owned()) status('Capture saved.');
    } catch (error) { if (owned()) throw scopeError(error, owned); }
    finally { savingCapture = false; updateCaptureControl(); }
  });
};
$('today').onclick = () => action(async () => { view = 'today'; await refresh(); });
$('history').onclick = () => action(async () => { view = 'all'; await refresh(); });
$('search').oninput = () => action(refresh); $('refresh').onclick = () => action(refresh);
function connectSource(channel, input) {
  if ($(channel).disabled) return;
  const owner = configurationEpoch, owned = () => owner === configurationEpoch && !configurationBusy;
  connectingIntake = true; updateIntakeControls(); status('Connecting source...');
  return action(async () => {
    try {
      await window.companion[channel](input);
      if (!owned()) return;
      await refresh();
      if (owned()) status(channel === 'reconnect-source' ? 'Source reconnected. Use Check now when ready.' : input.scan ? 'Intake check complete.' : 'Source connected. Use Check now when ready.');
    } catch (error) { if (owned()) throw scopeError(error, owned); }
    finally { connectingIntake = false; updateIntakeControls(); }
  });
}
$('connect-drafts').onclick = () => connectSource('connect-drafts', { folder: $('draft-source').value, scan: $('first-scan').checked });
$('check-intake').onclick = () => {
  if (checkingIntake || configurationBusy || $('check-intake').disabled) return;
  const owner = configurationEpoch, owned = () => owner === configurationEpoch && !configurationBusy;
  checkingIntake = true; updateIntakeControls(); status('Checking intake...');
  return action(async () => {
    try {
      await window.companion['check-intake']();
      if (!owned()) return;
      await refresh();
      if (owned()) status('Intake check complete. Inspect held imports and source errors.');
    } catch (error) { if (owned()) throw scopeError(error, owned); }
    finally { checkingIntake = false; updateIntakeControls(); }
  });
};
$('connect-reviews').onclick = () => connectSource('connect-reviews', { folder: $('review-source').value, scan: false });
$('reconnect-selection').onchange = updateIntakeControls;
$('reconnect-source').onclick = () => {
  const source = state?.intake?.sources.find(item => item.id === $('reconnect-selection').value);
  if (!source) return;
  const { id, folder, kind = 'draft', identity, epoch } = source;
  return connectSource('reconnect-source', { location: state.location, id, folder, kind, identity, epoch, replacement: $('reconnect-folder').value });
};
window.addEventListener('companion-schedule-changed', () => action(refresh));
updateScheduleControls();
window.addEventListener('focus', () => action(refresh)); setInterval(() => action(refresh), 60000); action(refresh);
