(() => {
  const byId = id => document.getElementById(id), section = document.createElement('section');
  section.setAttribute('aria-label', 'Local conversation deletion');
  section.innerHTML = '<h3>Delete a local conversation</h3><button id="conversation-delete-preview">Preview conversation deletion</button><section id="conversation-delete-review" aria-label="Conversation deletion review" hidden><p id="conversation-delete-summary"></p><div id="conversation-delete-pending"></div><button id="conversation-delete-confirm">Confirm conversation deletion</button><button id="conversation-delete-cancel">Cancel conversation deletion</button></section><p id="conversation-delete-status" role="alert"></p>';
  byId('conversation-section').append(section);
  let token, generation = 0;
  const invalidate = () => {
    generation++; const previous = token; token = null; byId('conversation-delete-review').hidden = true;
    if (previous) window.companion['conversation-delete-cancel']({ token: previous }).catch(() => {});
  };
  byId('conversation-new').addEventListener('click', invalidate);
  byId('conversation-select').addEventListener('change', invalidate);
  byId('configure').addEventListener('click', invalidate);
  byId('conversation-delete-preview').onclick = async () => {
    invalidate(); const current = generation; byId('conversation-delete-status').textContent = '';
    try {
      const result = await window.companion['conversation-delete-preview']({ id: byId('conversation-select').value });
      if (current !== generation) { await window.companion['conversation-delete-cancel']({ token: result.token }); return; }
      token = result.token;
      byId('conversation-delete-summary').textContent = `Delete local conversation ${result.id}: ${result.requestCount} request${result.requestCount === 1 ? '' : 's'}. Exact local files: ${result.targets.join(', ')}. Sources and captures remain. Independent saved ideas and saved writing remain. Transcript exports, journals and archives remain separate copies. Independent quotations may remain. Previous provider submissions are not erased. History has no automatic expiry. This removes only the selected app-controlled conversation and its validated pending stages; it does not rewrite independent writing.`;
      byId('conversation-delete-pending').replaceChildren();
      for (const pending of result.pending) {
        const label = document.createElement('label'), text = document.createElement('textarea'); label.textContent = `Selected pending history ${pending.name}`; text.readOnly = true; text.value = pending.text; label.append(text); byId('conversation-delete-pending').append(label);
      }
      byId('conversation-delete-review').hidden = false;
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
    finally { byId('conversation-delete-confirm').disabled = false; }
  };
})();
