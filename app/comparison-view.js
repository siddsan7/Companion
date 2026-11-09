(() => {
  const section = document.createElement('section'); section.id = 'comparison-section'; section.setAttribute('aria-label', 'Reasoning comparison');
  section.innerHTML = '<h2>Reasoning comparison</h2><p>Inspect three authored synthetic cases against one approved MyTune brief. Creating a comparison makes no model request.</p><label>Comparison brief version<input id="comparison-brief" type="number" min="1" value="1"></label><button id="comparison-create">Create comparison</button><label>Retained comparison<select id="comparison-select"><option value="">Choose comparison</option></select></label><p id="comparison-error" role="alert"></p><p id="comparison-notice"></p><div id="comparison-cases"></div><div id="comparison-slots"></div>';
  document.querySelector('main').append(section);
  const byId = id => document.getElementById(id);
  let current = null;
  const records = new Map();
  function show(record) {
    current = record.id; byId('comparison-select').value = current;
    byId('comparison-notice').textContent = `${record.notice} Approved brief version ${record.brief.version}; sha256 ${record.brief.digest}.`;
    byId('comparison-cases').replaceChildren();
    for (const fixture of record.fixtures) {
      const article = document.createElement('article'), heading = document.createElement('h3'), text = document.createElement('pre'), limits = document.createElement('p');
      heading.textContent = `Synthetic ${fixture.fit} case: ${fixture.id}, version ${fixture.version}`;
      text.textContent = fixture.passages.map(passage => `[${passage.id}] ${passage.text}`).join('\n\n'); limits.textContent = `Limitations: ${fixture.limitations}`;
      article.append(heading, text, limits); byId('comparison-cases').append(article);
    }
    byId('comparison-slots').replaceChildren();
    for (const slot of record.slots) {
      const article = document.createElement('article'), heading = document.createElement('h3'), state = document.createElement('p');
      heading.textContent = slot.displayId; state.textContent = slot.status; article.append(heading, state); byId('comparison-slots').append(article);
    }
  }
  function choices() {
    byId('comparison-select').replaceChildren(new Option('Choose comparison', ''), ...[...records.values()].map(record => new Option(`Brief ${record.brief.version} · ${record.id.slice(0, 8)}`, record.id)));
  }
  async function perform(work) {
    try { await work(); byId('comparison-error').textContent = ''; }
    catch (error) { byId('comparison-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  }
  byId('comparison-create').onclick = () => perform(async () => {
    byId('comparison-create').disabled = true;
    try { const record = await window.companion['comparison-create']({ briefVersion: Number(byId('comparison-brief').value) }); records.set(record.id, record); choices(); show(record); }
    finally { byId('comparison-create').disabled = false; }
  });
  byId('comparison-select').onchange = () => { const record = records.get(byId('comparison-select').value); if (record) show(record); };
  perform(async () => {
    const result = await window.companion['comparison-list']();
    for (const record of result.comparisons) records.set(record.id, record);
    choices(); if (!current && result.comparisons[0]) show(result.comparisons[0]);
  });
})();
