(() => {
  const section = document.createElement('section'); section.id = 'comparison-section'; section.setAttribute('aria-label', 'Reasoning comparison');
  section.innerHTML = '<h2>Reasoning comparison</h2><p>Inspect three authored synthetic cases against one approved MyTune brief. Creating a comparison makes no model request.</p><label>Comparison brief version<input id="comparison-brief" type="number" min="1" value="1"></label><button id="comparison-create">Create comparison</button><label for="comparison-select">Retained comparison</label><select id="comparison-select"><option value="">Choose comparison</option></select><p id="comparison-error" role="alert"></p><p id="comparison-notice"></p><div id="comparison-cases"></div><label>Reviewed comparison package<textarea id="comparison-package" rows="12" readonly></textarea></label><p id="comparison-preview-summary"></p><button id="comparison-send" disabled>Send reviewed comparison slot</button><div id="comparison-slots"></div>';
  document.querySelector('main').append(section);
  const scoring = document.createElement('div'); scoring.id = 'comparison-score-panel'; scoring.hidden = true;
  scoring.innerHTML = '<h3>Blind scoring</h3><p id="comparison-score-notice"></p><div id="comparison-rubric"></div><div id="comparison-score"></div><button id="comparison-reveal-button" disabled>Reveal methods and effort</button><div id="comparison-reveal"></div><button id="comparison-inspect">Inspect comparison</button>';
  section.append(scoring);
  const startScoring = document.createElement('button'); startScoring.id = 'comparison-score-start'; startScoring.textContent = 'Start blind scoring';
  document.getElementById('comparison-notice').after(startScoring);
  const preserve = document.createElement('button'); preserve.id = 'comparison-preserve'; preserve.textContent = 'Save retained comparison locally'; preserve.hidden = true;
  document.getElementById('comparison-notice').after(preserve);
  const byId = id => document.getElementById(id);
  let current = null;
  let token = null, epoch = 0, sending = false;
  const records = new Map();
  const drafts = new Map();
  function scoreMode(enabled) {
    for (const id of ['comparison-brief', 'comparison-create', 'comparison-cases', 'comparison-package', 'comparison-preview-summary', 'comparison-send', 'comparison-slots']) {
      byId(id).hidden = enabled;
      if (id === 'comparison-package' || id === 'comparison-brief') byId(id).parentElement.hidden = enabled;
    }
    byId('comparison-notice').hidden = enabled; byId('comparison-score-panel').hidden = !enabled;
    byId('comparison-score-start').hidden = enabled;
    if (enabled) invalidate();
  }
  function invalidate() { token = null; byId('comparison-send').disabled = true; byId('comparison-package').value = ''; byId('comparison-preview-summary').textContent = ''; }
  function show(record) {
    invalidate(); epoch++;
    scoreMode(false);
    current = record.id; byId('comparison-select').value = current;
    byId('comparison-notice').textContent = `${record.notice} Approved brief version ${record.brief.version}; sha256 ${record.brief.digest}.${record.storageWarning ? ` ${record.storageWarning}` : ''}`;
    byId('comparison-preserve').hidden = !record.storageWarning;
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
  function renderScores(result) {
    byId('comparison-reveal').replaceChildren(); byId('comparison-reveal-button').disabled = !result.canReveal;
    byId('comparison-score-notice').textContent = `${result.notice}${result.storageWarning ? ` ${result.storageWarning}` : ''}`;
    byId('comparison-rubric').replaceChildren();
    const note = document.createElement('p'); note.textContent = result.rubric.note; byId('comparison-rubric').append(note);
    for (const dimension of result.rubric.dimensions) {
      const paragraph = document.createElement('p'); paragraph.textContent = `${dimension.label}: 1 - ${dimension.anchors[0]}; 3 - ${dimension.anchors[1]}; 5 - ${dimension.anchors[2]}. ${dimension.example}`;
      byId('comparison-rubric').append(paragraph);
    }
    byId('comparison-score').replaceChildren();
    for (const output of result.outputs) {
      const article = document.createElement('article'), heading = document.createElement('h4'), text = document.createElement('pre'), state = document.createElement('p'), feedback = document.createElement('p'), save = document.createElement('button');
      heading.textContent = output.displayId; text.textContent = output.candidate?.text || '';
      state.textContent = `${output.status}. ${output.candidate?.warning || ''} ${output.error || ''}${output.status === 'failed' || output.status === 'interrupted' ? ' Generation failure is not grounded abstention; explain that distinction in the rating reason.' : ''}`;
      article.append(heading, state, text);
      const key = `${result.id}:${output.displayId}`;
      let draft = drafts.get(key);
      if (!draft || draft.candidateDigest !== output.candidateDigest) { draft = { candidateDigest: output.candidateDigest, values: { ...output.rating } }; drafts.set(key, draft); }
      const controls = {};
      const addControl = (labelText, tag, type, field) => {
        const label = document.createElement('label'), input = document.createElement(tag);
        input.id = `comparison-rating-${output.displayIndex}-${field}`; label.htmlFor = input.id; label.textContent = `${output.displayId} ${labelText}`;
        if (type) input.type = type;
        input.disabled = !output.candidate || !['completed', 'failed', 'interrupted'].includes(output.status) || !!result.storageWarning;
        if (type === 'number') { input.min = '1'; input.max = '5'; input.step = '1'; input.value = draft.values[field] ?? ''; }
        else if (type === 'checkbox') input.checked = draft.values[field] === true;
        else { input.value = draft.values[field] || ''; input.maxLength = 2000; }
        input.oninput = () => { draft.values[field] = type === 'checkbox' ? input.checked : input.value; };
        controls[field] = input; article.append(label, input);
      };
      for (const dimension of result.rubric.dimensions) addControl(dimension.label, 'input', 'number', dimension.key);
      addControl('Rating reason', 'textarea', null, 'reason'); addControl('Material error', 'input', 'checkbox', 'materialError');
      feedback.textContent = output.rating ? 'Feedback saved' : 'Not rated'; save.textContent = `Save feedback ${output.displayId}`;
      save.disabled = controls.reason.disabled;
      save.onclick = () => perform(async () => {
        const observedEpoch = epoch, rating = {};
        for (const dimension of result.rubric.dimensions) rating[dimension.key] = Number(controls[dimension.key].value);
        rating.reason = controls.reason.value; rating.materialError = controls.materialError.checked;
        save.disabled = true;
        try {
          const saved = await window.companion['comparison-rate']({ id: result.id, displayId: output.displayId, candidateDigest: output.candidateDigest, expectedRevision: output.rating?.revision || null, rating });
          if (observedEpoch !== epoch) return;
          output.rating = saved.outputs[output.displayIndex].rating; draft.values = { ...output.rating }; feedback.textContent = 'Feedback saved'; byId('comparison-reveal-button').disabled = !saved.canReveal;
        } finally { if (observedEpoch === epoch) save.disabled = false; }
      });
      article.append(save, feedback); byId('comparison-score').append(article);
    }
  }
  byId('comparison-score-start').onclick = () => perform(async () => {
    if (!current || sending) throw Error('Choose a retained comparison after generation has settled.');
    const observedEpoch = ++epoch, id = current;
    const result = await window.companion['comparison-score-view']({ id });
    if (observedEpoch !== epoch || current !== id) return;
    scoreMode(true); renderScores(result);
  });
  byId('comparison-inspect').onclick = () => { if (current && records.has(current)) show(records.get(current)); };
  byId('comparison-preserve').onclick = () => perform(async () => {
    const observedEpoch = epoch, id = current; byId('comparison-preserve').disabled = true;
    try {
      const record = await window.companion['comparison-preserve']({ id }); records.set(record.id, record);
      if (observedEpoch === epoch && current === id) show(record);
    } finally { byId('comparison-preserve').disabled = false; }
  });
  byId('comparison-reveal-button').onclick = () => perform(async () => {
    const observedEpoch = epoch, id = current; byId('comparison-reveal-button').disabled = true;
    try {
      const result = await window.companion['comparison-reveal']({ id });
      if (observedEpoch !== epoch || current !== id) return;
      byId('comparison-reveal').replaceChildren();
      const notice = document.createElement('p'); notice.textContent = `${result.notice} First revealed: ${result.revealedAt}.`;
      byId('comparison-reveal').append(notice);
      for (const output of result.outputs) {
        const article = document.createElement('article'), heading = document.createElement('h4'), details = document.createElement('pre'), prompt = document.createElement('pre'), raw = document.createElement('pre');
        heading.textContent = output.label; prompt.textContent = output.package.text; raw.textContent = output.reply;
        const { package: packet, reply, ...metadata } = output;
        details.textContent = JSON.stringify({ ...metadata, packageIdentity: { digest: packet.digest, sharedInputDigest: packet.sharedInputDigest, count: packet.count }, brief: result.brief, capacity: result.capacity, settingsEvidence: result.settingsEvidence }, null, 2);
        article.append(heading, details, prompt, raw); byId('comparison-reveal').append(article);
      }
      byId('comparison-score-notice').textContent = result.notice;
    } finally { if (observedEpoch === epoch) byId('comparison-reveal-button').disabled = false; }
  });
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
