(() => {
  const byId = id => document.getElementById(id), section = document.createElement('section');
  section.setAttribute('aria-label', 'Readable transcript export');
  section.innerHTML = '<h3>Readable transcript export</h3><p>Export a historical Markdown copy only when requested. Local deletion does not erase previous provider submissions, independent quotations, exports or backups.</p><button id="transcript-preview">Preview transcript export</button><div id="transcript-review" hidden><label>Transcript destination<input id="transcript-destination" readonly></label><label>Proposed transcript Markdown<textarea id="transcript-markdown" rows="16" readonly></textarea></label><button id="transcript-confirm">Export reviewed transcript</button><button id="transcript-cancel">Cancel transcript preview</button></div><p id="transcript-status" role="alert"></p>';
  byId('conversation-section').append(section);
  const pending = document.createElement('section'); pending.setAttribute('aria-label', 'Pending transcript exports');
  pending.innerHTML = '<h4>Pending transcript exports</h4><p>Retained proposals are never published automatically. Inspect the writing before explicitly resuming.</p><div id="transcript-pending"></div>';
  section.append(pending);
  const removal = document.createElement('section'); removal.setAttribute('aria-label', 'Selected transcript removal');
  removal.innerHTML = '<h4>Remove one transcript export</h4><p>Select a separately managed export. This removes only the displayed app-owned copies. The originating conversation, source captures, saved ideas, other exports and external backups remain independent. This does not promise automatic semantic erasure of quotations.</p><label>Retained transcript export<select id="transcript-remove-select"><option value="">Choose one export</option></select></label><button id="transcript-remove-preview">Preview transcript removal</button><section id="transcript-remove-review" aria-label="Transcript removal review" hidden><p>The originating conversation, source captures, saved ideas, other exports and external copies or backups are kept. Only these exact managed copies are selected:</p><ul id="transcript-remove-files"></ul><button id="transcript-remove-confirm">Confirm transcript removal</button><button id="transcript-remove-cancel">Cancel transcript removal</button></section><p id="transcript-remove-status" role="alert"></p><section aria-label="Pending transcript removals"><h4>Pending transcript removals</h4><div id="transcript-remove-pending"></div></section>';
  section.append(removal);
  let removalToken, removalGeneration = 0, removalListGeneration = 0;
  function invalidateRemoval() {
    removalGeneration++; const previous = removalToken; removalToken = null;
    byId('transcript-remove-review').hidden = true; byId('transcript-remove-files').replaceChildren();
    if (previous) window.companion['transcript-remove-cancel']({ token: previous }).catch(() => {});
  }
  function showRemoval(result) {
    removalToken = result.token; byId('transcript-remove-files').replaceChildren();
    for (const file of result.files) { const row = document.createElement('li'); row.textContent = file; byId('transcript-remove-files').append(row); }
    byId('transcript-remove-review').hidden = false;
  }
  async function refreshRemoval() {
    const owner = vaultEpoch, current = ++removalListGeneration;
    try {
      const result = await window.companion['transcript-remove-list']();
      if (owner !== vaultEpoch || current !== removalListGeneration) return;
      const select = byId('transcript-remove-select'), selected = select.value;
      select.replaceChildren(new Option('Choose one export', ''));
      for (const record of result.records) select.add(new Option(record.destination, record.operation));
      if (result.records.some(record => record.operation === selected)) select.value = selected;
      byId('transcript-remove-pending').replaceChildren();
      for (const issue of result.issues) { const row = document.createElement('p'); row.textContent = issue; byId('transcript-remove-pending').append(row); }
      for (const record of result.pending) {
        const article = document.createElement('article'), description = document.createElement('p'), resume = document.createElement('button');
        description.textContent = `${record.id}: ${record.warning}`; resume.textContent = 'Resume transcript removal'; resume.disabled = !record.canResume;
        resume.onclick = async () => {
          if (owner !== vaultEpoch) return;
          invalidateRemoval(); const current = removalGeneration; resume.disabled = true;
          try {
            const result = await window.companion['transcript-remove-resume']({ id: record.id });
            if (current !== removalGeneration || owner !== vaultEpoch) { await window.companion['transcript-remove-cancel']({ token: result.token }); return; }
            showRemoval(result);
          } catch (error) { if (current === removalGeneration && owner === vaultEpoch) byId('transcript-remove-status').textContent = error.message; }
          finally { if (owner === vaultEpoch) resume.disabled = !record.canResume; }
        };
        article.append(description, resume); byId('transcript-remove-pending').append(article);
      }
    } catch (error) { if (owner === vaultEpoch && current === removalListGeneration) byId('transcript-remove-status').textContent = error.message; }
  }
  byId('transcript-remove-select').onchange = invalidateRemoval;
  byId('transcript-remove-preview').onclick = async () => {
    invalidateRemoval(); const current = removalGeneration, owner = vaultEpoch;
    byId('transcript-remove-status').textContent = '';
    try {
      const result = await window.companion['transcript-remove-preview']({ operation: byId('transcript-remove-select').value });
      if (current !== removalGeneration || owner !== vaultEpoch) { await window.companion['transcript-remove-cancel']({ token: result.token }); return; }
      showRemoval(result);
    } catch (error) { if (current === removalGeneration && owner === vaultEpoch) byId('transcript-remove-status').textContent = error.message; }
  };
  byId('transcript-remove-cancel').onclick = () => { invalidateRemoval(); byId('transcript-remove-status').textContent = 'Transcript removal cancelled. No files were changed.'; };
  byId('transcript-remove-confirm').onclick = async () => {
    const current = removalGeneration, owner = vaultEpoch, approved = removalToken;
    byId('transcript-remove-confirm').disabled = true;
    try {
      await window.companion['transcript-remove-confirm']({ token: approved });
      if (current !== removalGeneration || owner !== vaultEpoch) return;
      invalidateRemoval(); byId('transcript-remove-status').textContent = 'Transcript removed locally. The originating conversation and independent copies are kept.';
    } catch (error) { if (current === removalGeneration && owner === vaultEpoch) byId('transcript-remove-status').textContent = error.message; }
    finally { byId('transcript-remove-confirm').disabled = false; if (owner === vaultEpoch) { await refreshRemoval(); await refreshPending(); } }
  };
  let token, generation = 0, vaultEpoch = 0, pendingGeneration = 0;
  function invalidateView() {
    generation++; const previous = token; token = null;
    byId('transcript-review').hidden = true; byId('transcript-markdown').value = ''; byId('transcript-destination').value = '';
    byId('transcript-confirm').disabled = false;
    byId('transcript-status').textContent = 'Preview required. Conversation changed; earlier transcript results are ignored. Already-authorized publications remain recoverable.';
    if (previous) window.companion['transcript-cancel']({ token: previous }).catch(() => {});
  }
  byId('conversation-new').addEventListener('click', invalidateView);
  byId('conversation-select').addEventListener('change', invalidateView);
  byId('configure').addEventListener('click', () => {
    vaultEpoch++; pendingGeneration++; removalListGeneration++; invalidateView(); invalidateRemoval(); byId('transcript-pending').replaceChildren(); byId('transcript-remove-pending').replaceChildren(); byId('transcript-remove-select').replaceChildren(new Option('Choose one export', ''));
  });
  window.addEventListener('companion-vault-configured', () => { refreshPending(); refreshRemoval(); });
  async function refreshPending() {
    const owner = vaultEpoch, current = ++pendingGeneration;
    try {
      const result = await window.companion['transcript-pending']();
      if (owner !== vaultEpoch || current !== pendingGeneration) return;
      byId('transcript-pending').replaceChildren();
      for (const issue of result.issues) { const row = document.createElement('p'); row.textContent = issue; byId('transcript-pending').append(row); }
      for (const record of result.records) {
        const article = document.createElement('article'), description = document.createElement('p'), details = document.createElement('details'), summary = document.createElement('summary'), label = document.createElement('label'), text = document.createElement('textarea'), resume = document.createElement('button');
        description.textContent = `${record.operation} · ${record.destination}. ${record.warning}`;
        summary.textContent = 'Inspect retained transcript'; label.textContent = 'Retained transcript Markdown'; text.readOnly = true; text.rows = 12; text.value = record.text; label.append(text); details.append(summary, label);
        resume.textContent = 'Resume transcript export'; resume.disabled = !record.canResume;
        resume.onclick = async () => {
          if (owner !== vaultEpoch) return;
          const current = ++generation; resume.disabled = true; byId('transcript-review').hidden = true;
          try {
            if (token) await window.companion['transcript-cancel']({ token }); token = null;
            const result = await window.companion['transcript-resume']({ operation: record.operation });
            if (current !== generation) { await window.companion['transcript-cancel']({ token: result.token }); return; }
            token = result.token; byId('transcript-destination').value = result.destination; byId('transcript-markdown').value = result.text; byId('transcript-review').hidden = false;
            byId('transcript-status').textContent = 'Retained transcript resumed for explicit review. Confirm to finish this operation; no model request is made.';
          } catch (error) { if (current === generation) byId('transcript-status').textContent = error.message; }
          finally { if (current === generation && owner === vaultEpoch) resume.disabled = !record.canResume; }
        };
        article.append(description, details, resume); byId('transcript-pending').append(article);
      }
    } catch (error) { if (owner === vaultEpoch && current === pendingGeneration) byId('transcript-pending').textContent = error.message; }
  }
  byId('transcript-preview').onclick = async () => {
    const current = ++generation; byId('transcript-status').textContent = ''; byId('transcript-review').hidden = true;
    try {
      if (token) await window.companion['transcript-cancel']({ token }); token = null;
      const result = await window.companion['transcript-preview']({ conversationId: byId('conversation-select').value });
      if (current !== generation) { if (result.token) await window.companion['transcript-cancel']({ token: result.token }); return; }
      if (result.canceled) { byId('transcript-status').textContent = 'Transcript export cancelled. Nothing was published.'; return; }
      token = result.token; byId('transcript-destination').value = result.destination; byId('transcript-markdown').value = result.text; byId('transcript-review').hidden = false;
      byId('transcript-status').textContent = 'Inspect the exact historical copy and destination before exporting.';
    } catch (error) { if (current === generation) byId('transcript-status').textContent = error.message; }
  };
  byId('transcript-cancel').onclick = async () => {
    const current = ++generation, previous = token; token = null; byId('transcript-review').hidden = true;
    try { await window.companion['transcript-cancel']({ token: previous }); if (current === generation) byId('transcript-status').textContent = 'Transcript preview cancelled. Nothing was published.'; }
    catch (error) { if (current === generation) byId('transcript-status').textContent = error.message; }
  };
  byId('transcript-confirm').onclick = async () => {
    const current = generation, owner = vaultEpoch, approved = token;
    byId('transcript-confirm').disabled = true;
    try {
      const result = await window.companion['transcript-confirm']({ token: approved });
      if (current !== generation || owner !== vaultEpoch) return;
      token = null; byId('transcript-review').hidden = true; byId('transcript-status').textContent = `Transcript exported: ${result.destination}`;
    } catch (error) { if (current === generation && owner === vaultEpoch) byId('transcript-status').textContent = `${error.message} Proposed writing remains available; retry explicitly or copy it before closing.`; }
    finally { if (current === generation && owner === vaultEpoch) byId('transcript-confirm').disabled = false; if (owner === vaultEpoch) { await refreshPending(); await refreshRemoval(); } }
  };
  refreshPending();
  refreshRemoval();
})();
