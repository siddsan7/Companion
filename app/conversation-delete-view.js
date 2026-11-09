(() => {
  const byId = id => document.getElementById(id), section = document.createElement('section');
  section.setAttribute('aria-label', 'Local conversation deletion');
  section.innerHTML = '<h3>Delete a local conversation</h3><button id="conversation-delete-preview">Preview conversation deletion</button><section id="conversation-delete-review" aria-label="Conversation deletion review" hidden><p id="conversation-delete-summary"></p><div id="conversation-delete-pending"></div><button id="conversation-delete-confirm">Confirm conversation deletion</button><button id="conversation-delete-cancel">Cancel conversation deletion</button></section><p id="conversation-delete-status" role="alert"></p>';
  byId('conversation-section').append(section);
  const pending = document.createElement('section'); pending.setAttribute('aria-label', 'Pending conversation deletions');
  pending.innerHTML = '<h4>Pending conversation deletions</h4><p>Inspection does not remove anything. Resume only the exact previously confirmed manifest.</p><div id="conversation-delete-pending-operations"></div>';
  section.append(pending);
  let token, generation = 0, pendingGeneration = 0;
  const invalidate = () => {
    generation++; const previous = token; token = null; byId('conversation-delete-review').hidden = true; byId('conversation-delete-confirm').disabled = false;
    if (previous) window.companion['conversation-delete-cancel']({ token: previous }).catch(() => {});
  };
  byId('conversation-new').addEventListener('click', invalidate);
  byId('conversation-select').addEventListener('change', invalidate);
  byId('configure').addEventListener('click', () => { pendingGeneration++; invalidate(); byId('conversation-delete-pending-operations').replaceChildren(); });
  window.addEventListener('companion-vault-configured', () => refreshPending());
  function showReview(result) {
    token = result.token;
    byId('conversation-delete-summary').textContent = `${result.recovery ? `Resume previously confirmed deletion, generation ${result.generation}` : `Delete local conversation with ${result.requestCount} request${result.requestCount === 1 ? '' : 's'}`}: ${result.id}. Exact local files: ${result.targets.join(', ')}. Sources and captures remain. Independent saved ideas and saved writing remain. Transcript exports, journals and archives remain separate copies. Independent quotations may remain. Previous provider submissions are not erased. History has no automatic expiry. This removes only the selected app-controlled conversation and its validated pending stages; it does not rewrite independent writing.`;
    byId('conversation-delete-pending').replaceChildren();
    for (const pending of result.pending) {
      const label = document.createElement('label'), text = document.createElement('textarea'); label.textContent = `Selected pending history ${pending.name}`; text.readOnly = true; text.value = pending.text; label.append(text); byId('conversation-delete-pending').append(label);
    }
    byId('conversation-delete-review').hidden = false;
  }
  async function refreshPending() {
    const request = ++pendingGeneration;
    try {
      const result = await window.companion['conversation-delete-pending'](); if (request !== pendingGeneration) return;
      const list = byId('conversation-delete-pending-operations'); list.replaceChildren();
      for (const issue of result.issues) { const row = document.createElement('p'); row.textContent = issue; list.append(row); }
      for (const record of result.records) {
        const article = document.createElement('article'), description = document.createElement('p'), resume = document.createElement('button');
        description.textContent = `${record.id} · generation ${record.generation} · exact manifest: ${record.targets.join(', ')}. ${record.warning}`;
        resume.textContent = 'Resume conversation deletion'; resume.disabled = !record.canResume;
        resume.onclick = async () => {
          invalidate(); const current = generation; resume.disabled = true;
          try {
            const result = await window.companion['conversation-delete-resume']({ id: record.id });
            if (current !== generation) { await window.companion['conversation-delete-cancel']({ token: result.token }); return; }
            showReview(result);
          } catch (error) { if (current === generation) byId('conversation-delete-status').textContent = error.message; }
          finally { if (current === generation) resume.disabled = !record.canResume; }
        };
        article.append(description, resume); list.append(article);
      }
    } catch (error) { if (request === pendingGeneration) byId('conversation-delete-pending-operations').textContent = error.message; }
  }
  byId('conversation-delete-preview').onclick = async () => {
    invalidate(); const current = generation; byId('conversation-delete-status').textContent = '';
    try {
      const result = await window.companion['conversation-delete-preview']({ id: byId('conversation-select').value });
      if (current !== generation) { await window.companion['conversation-delete-cancel']({ token: result.token }); return; }
      showReview(result);
    } catch (error) { if (current === generation) byId('conversation-delete-status').textContent = error.message; }
  };
  byId('conversation-delete-cancel').onclick = () => { invalidate(); byId('conversation-delete-status').textContent = 'Deletion cancelled. Local history and independent writing remain unchanged.'; };
  byId('conversation-delete-confirm').onclick = async () => {
    const current = generation, approved = token; byId('conversation-delete-confirm').disabled = true;
    try {
      await window.companion['conversation-delete-confirm']({ token: approved });
      if (current !== generation) return;
      byId('conversation-new').click(); byId('conversation-delete-status').textContent = 'Conversation deleted locally. Independent writing, sources and separate copies remain.';
    } catch (error) { if (current === generation) byId('conversation-delete-status').textContent = error.message; }
    finally { if (current === generation) byId('conversation-delete-confirm').disabled = false; await refreshPending(); }
  };
  refreshPending();
})();
