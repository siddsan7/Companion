(() => {
  const byId = id => document.getElementById(id), section = document.createElement('section');
  section.setAttribute('aria-label', 'Readable transcript export');
  section.innerHTML = '<h3>Readable transcript export</h3><p>Export a historical Markdown copy only when requested. Local deletion does not erase previous provider submissions, independent quotations, exports or backups.</p><button id="transcript-preview">Preview transcript export</button><div id="transcript-review" hidden><label>Transcript destination<input id="transcript-destination" readonly></label><label>Proposed transcript Markdown<textarea id="transcript-markdown" rows="16" readonly></textarea></label><button id="transcript-confirm">Export reviewed transcript</button><button id="transcript-cancel">Cancel transcript preview</button></div><p id="transcript-status" role="alert"></p>';
  byId('conversation-section').append(section);
  const pending = document.createElement('section'); pending.setAttribute('aria-label', 'Pending transcript exports');
  pending.innerHTML = '<h4>Pending transcript exports</h4><p>Retained proposals are never published automatically. Inspect the writing before explicitly resuming.</p><div id="transcript-pending"></div>';
  section.append(pending);
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
    vaultEpoch++; pendingGeneration++; invalidateView(); byId('transcript-pending').replaceChildren();
  });
  window.addEventListener('companion-vault-configured', () => refreshPending());
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
    finally { if (current === generation && owner === vaultEpoch) byId('transcript-confirm').disabled = false; if (owner === vaultEpoch) await refreshPending(); }
  };
  refreshPending();
})();
