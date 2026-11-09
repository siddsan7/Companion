(() => {
  const section = document.createElement('section'); section.id = 'comparison-section'; section.setAttribute('aria-label', 'Reasoning comparison');
  section.innerHTML = '<h2>Reasoning comparison</h2><p>Inspect three authored synthetic cases against one approved MyTune brief. Creating a comparison makes no model request.</p><label>Comparison brief version<input id="comparison-brief" type="number" min="1" value="1"></label><button id="comparison-create">Create comparison</button><label for="comparison-select">Retained comparison</label><select id="comparison-select"><option value="">Choose comparison</option></select><p id="comparison-error" role="alert"></p><p id="comparison-notice"></p><div id="comparison-cases"></div><label>Reviewed comparison package<textarea id="comparison-package" rows="12" readonly></textarea></label><p id="comparison-preview-summary"></p><button id="comparison-send" disabled>Send reviewed comparison slot</button><div id="comparison-slots"></div>';
  document.querySelector('main').append(section);
  const byId = id => document.getElementById(id);
  let current = null;
  let token = null, epoch = 0, sending = false;
  const records = new Map();
  function invalidate() { token = null; byId('comparison-send').disabled = true; byId('comparison-package').value = ''; byId('comparison-preview-summary').textContent = ''; }
  function show(record) {
    invalidate(); epoch++;
    current = record.id; byId('comparison-select').value = current;
    byId('comparison-notice').textContent = `${record.notice} Approved brief version ${record.brief.version}; sha256 ${record.brief.digest}.${record.storageWarning ? ` ${record.storageWarning}` : ''}`;
    byId('comparison-cases').replaceChildren();
    for (const fixture of record.fixtures) {
      const article = document.createElement('article'), heading = document.createElement('h3'), text = document.createElement('pre'), limits = document.createElement('p');
      heading.textContent = `Synthetic ${fixture.fit} case: ${fixture.id}, version ${fixture.version}`;
      text.textContent = fixture.passages.map(passage => `[${passage.id}] ${passage.text}`).join('\n\n'); limits.textContent = `Limitations: ${fixture.limitations}`;
      article.append(heading, text, limits); byId('comparison-cases').append(article);
    }
    byId('comparison-slots').replaceChildren();
    for (const [displayIndex, slot] of record.slots.entries()) {
      const article = document.createElement('article'), heading = document.createElement('h3'), state = document.createElement('p'), preview = document.createElement('button');
      heading.textContent = slot.displayId; state.textContent = slot.status;
      preview.textContent = `Preview ${slot.displayId}`; preview.disabled = sending || slot.status !== 'pending' || !!record.storageWarning;
      preview.onclick = () => perform(async () => {
        invalidate(); const observedEpoch = epoch;
        const result = await window.companion['comparison-preview']({ id: current, displayIndex });
        if (observedEpoch !== epoch) return;
        token = result.packageId; byId('comparison-package').value = result.text;
        byId('comparison-preview-summary').textContent = `${result.notice} ${result.count} Unicode code points. Model/settings: ${JSON.stringify(result.requested)}. Evidence: ${result.evidence.settings.evidence}.`;
        byId('comparison-send').disabled = false;
      });
      article.append(heading, state, preview);
      if (slot.candidate) {
        const output = document.createElement('pre'), details = document.createElement('p'); output.textContent = slot.candidate.text;
        details.textContent = `${slot.candidate.warning || 'One completed final-answer item.'} ${slot.candidate.wordCount} words${slot.candidate.overRequestedLimit ? '; exceeds requested 600 words; full output retained' : ''}. ${slot.error || ''} Elapsed: ${slot.elapsedMs === null ? 'unavailable' : `${Math.round(slot.elapsedMs)} ms`}. ${slot.elapsedBoundary || ''} ${slot.usageEvidence}`;
        article.append(output, details);
      }
      byId('comparison-slots').append(article);
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
  byId('comparison-send').onclick = () => perform(async () => {
    const packageId = token, observedEpoch = epoch; invalidate(); sending = true;
    byId('comparison-create').disabled = true; byId('comparison-select').disabled = true;
    for (const button of byId('comparison-slots').querySelectorAll('button')) button.disabled = true;
    try {
      const record = await window.companion['comparison-send']({ packageId }); records.set(record.id, record);
      if (observedEpoch === epoch) { sending = false; show(record); }
    } finally {
      sending = false; byId('comparison-create').disabled = false; byId('comparison-select').disabled = false;
      if (current && records.has(current) && observedEpoch === epoch) show(records.get(current));
    }
  });
  perform(async () => {
    const result = await window.companion['comparison-list']();
    for (const record of result.comparisons) records.set(record.id, record);
    choices(); if (!current && result.comparisons[0]) show(result.comparisons[0]);
  });
})();
