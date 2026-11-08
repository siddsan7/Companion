const $ = id => document.getElementById(id);
let selectedVault, view = 'today', state;
const status = message => { document.querySelector('[role=status]').textContent = message; };
async function action(work) { try { await work(); } catch (error) { status(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } }
function day(instant, timezone) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant)); }
async function refresh() {
  state = await window.companion.state(); $('location').textContent = state.location || 'Choose your vault and a parent folder to begin.';
  $('warnings').textContent = [...new Set(state.warnings)].join(' ');
  $('timezone').textContent = `${view === 'today' ? 'Today' : 'All captures'} · ${state.timezone} · ${day(state.now, state.timezone)}`;
  $('captures').replaceChildren();
  const query = $('search').value.toLowerCase();
  const notes = state.captures.filter(note => (view !== 'today' || day(note.capturedAt, state.timezone) === day(state.now, state.timezone)) && note.content.toLowerCase().includes(query));
  if (!notes.length) $('captures').textContent = 'No captures in this view. Try All captures or change your search.';
  for (const note of notes) {
    const article = document.createElement('article'), heading = document.createElement('h3'), details = document.createElement('p'), content = document.createElement('pre'), label = document.createElement('label'), input = document.createElement('input'), save = document.createElement('button'), open = document.createElement('button');
    heading.textContent = note.title; details.textContent = `${note.type} · ${new Date(note.capturedAt).toLocaleString(undefined, { timeZone: state.timezone })} · ${note.id}`;
    content.textContent = note.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    label.textContent = 'Display title'; input.value = note.title; label.append(input); save.textContent = 'Save title'; open.textContent = 'Open in Obsidian';
    save.onclick = () => action(async () => { await window.companion.title({ id: note.id, title: input.value }); await refresh(); status('Title saved.'); });
    open.onclick = () => action(async () => { await window.companion['open-note'](note.id); status('Requested Obsidian to open the note.'); });
    article.append(heading, details, content, label, save, open); $('captures').append(article);
  }
}
$('choose').onclick = () => action(async () => { selectedVault = await window.companion['choose-vault'](); $('vault').textContent = selectedVault || 'Selection cancelled.'; });
$('configure').onclick = () => action(async () => { await window.companion.configure({ vault: selectedVault, parent: $('parent').value }); await refresh(); status('Vault ready.'); });
$('add-excerpt').onclick = () => { $('excerpt-label').hidden = false; $('excerpt').focus(); };
$('save').onclick = () => action(async () => { await window.companion.capture({ text: $('text').value, excerpt: $('excerpt').value }); $('text').value = ''; $('excerpt').value = ''; await refresh(); status('Capture saved.'); });
$('today').onclick = () => action(async () => { view = 'today'; await refresh(); });
$('history').onclick = () => action(async () => { view = 'all'; await refresh(); });
$('search').oninput = () => action(refresh); $('refresh').onclick = () => action(refresh);
window.addEventListener('focus', () => action(refresh)); setInterval(() => action(refresh), 60000); action(refresh);
