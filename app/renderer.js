const $ = id => document.getElementById(id);
let selectedVault, view = 'today', state;
const status = message => { document.querySelector('[role=status]').textContent = message; };
async function action(work) { try { await work(); } catch (error) { status(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } }
function day(instant, timezone) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant)); }
async function refresh() {
  state = await window.companion.state(); $('location').textContent = state.location || 'Choose your vault and a parent folder to begin.';
  $('warnings').textContent = [...new Set(state.warnings)].join(' ');
  if (state.vaultError) status(state.vaultError);
  window.intakeView.render(state.intake);
  $('schedule-state').textContent = state.schedule ? `${state.schedule.mode} | Next scheduled check: ${state.schedule.next} | Anchor: ${state.schedule.anchor} | Last success: ${state.intake?.lastSuccess?.at || state.schedule.lastSuccess?.at || 'None'} | Worker: ${state.schedule.worker?.status || 'Not run'}${state.schedule.taskError || state.schedule.workerError || state.schedule.inspectionError ? ` | Error: ${state.schedule.taskError || state.schedule.workerError || state.schedule.inspectionError}` : ''}${!state.schedule.effective && state.schedule.mode !== 'disabled' ? ' | Task missing: use Repair daily intake.' : ''}${state.schedule.taskMismatch ? ' | Task state differs: use Repair daily intake.' : ''}${state.schedule.policyMismatch ? ' | Task schedule differs: use Repair daily intake.' : ''}` : 'Daily intake is not configured.';
  await window.intakeView.repairs();
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
    open.onclick = () => action(async () => { await window.companion['open-note'](note.id); status('Requested Obsidian to open the note.'); });
    article.append(heading, details, content, label, save, open); $('captures').append(article);
    if (note.type === 'reel_import') { const inspect = document.createElement('button'); inspect.textContent = 'Inspect source'; inspect.onclick = () => action(() => window.intakeView.inspect(note.id)); article.append(inspect); }
  }
}
const scheduleControls = ['enable', 'pause', 'resume', 'disable', 'repair'].map(operation => $('schedule-' + operation));
for (const [operation, result] of Object.entries({ enable: 'enabled', pause: 'paused', resume: 'resumed', disable: 'disabled', repair: 'repaired' })) $('schedule-' + operation).onclick = () => action(async () => {
  scheduleControls.forEach(control => { control.disabled = true; }); status('Updating daily intake...');
  try { await window.companion['schedule-' + operation](); status('Daily intake ' + result + '.'); }
  finally { try { await refresh(); } finally { scheduleControls.forEach(control => { control.disabled = false; }); } }
});
$('choose').onclick = () => action(async () => { selectedVault = await window.companion['choose-vault'](); $('vault').textContent = selectedVault || 'Selection cancelled.'; });
$('configure').onclick = () => action(async () => { try { await window.companion.configure({ vault: selectedVault, parent: $('parent').value }); await refresh(); status('Vault ready.'); } finally { window.dispatchEvent(new Event('companion-vault-configured')); } });
$('add-excerpt').onclick = () => { $('excerpt-label').hidden = false; $('excerpt').focus(); };
$('save').onclick = () => action(async () => { await window.companion.capture({ text: $('text').value, excerpt: $('excerpt').value }); $('text').value = ''; $('excerpt').value = ''; await refresh(); status('Capture saved.'); });
$('today').onclick = () => action(async () => { view = 'today'; await refresh(); });
$('history').onclick = () => action(async () => { view = 'all'; await refresh(); });
$('search').oninput = () => action(refresh); $('refresh').onclick = () => action(refresh);
$('connect-drafts').onclick = () => action(async () => { const scan = $('first-scan').checked; await window.companion['connect-drafts']({ folder: $('draft-source').value, scan }); await refresh(); status(scan ? 'Intake check complete.' : 'Source connected. Use Check now when ready.'); });
$('check-intake').onclick = () => action(async () => { await window.companion['check-intake'](); await refresh(); status('Intake check complete. Inspect held imports and source errors.'); });
$('connect-reviews').onclick = () => action(async () => { await window.companion['connect-reviews']({ folder: $('review-source').value, scan: false }); await refresh(); status('Source connected. Use Check now when ready.'); });
window.addEventListener('focus', () => action(refresh)); setInterval(() => action(refresh), 60000); action(refresh);
