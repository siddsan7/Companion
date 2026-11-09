(() => {
  const section = document.createElement('section'); section.id = 'ideas-section'; section.setAttribute('aria-label', 'Saved ideas');
  section.innerHTML = '<h2>Saved ideas</h2><p>Keep useful observations and failed analogies explicitly. A conversation does not create a note automatically.</p><div id="idea-editor" hidden><label>Idea title<input id="idea-title"></label><label>Idea explanation<textarea id="idea-explanation" rows="8"></textarea></label><label>Idea limitations<textarea id="idea-limitations" rows="3"></textarea></label><button id="idea-preview-button">Preview saved idea</button><div id="idea-preview" hidden><label>Proposed idea destination<input id="idea-destination" readonly></label><label>Proposed idea Markdown<textarea id="idea-markdown" rows="16" readonly></textarea></label><p id="idea-warnings"></p><button id="idea-confirm">Confirm saved idea</button><button id="idea-cancel">Cancel saved idea preview</button></div></div><p id="idea-status" aria-live="polite"></p><div id="saved-ideas"></div>';
  document.getElementById('conversation-section').after(section);
  const byId = id => document.getElementById(id);
  let origin = null, operation = null, epoch = 0;
  const invalidate = () => { epoch++; operation = null; byId('idea-preview').hidden = true; };
  for (const field of ['title', 'explanation', 'limitations']) byId(`idea-${field}`).oninput = invalidate;
  async function list() {
    try {
      const notes = await window.companion['idea-list'](); byId('saved-ideas').replaceChildren();
      for (const note of notes) {
        const article = document.createElement('article'), title = document.createElement('h3'), open = document.createElement('button');
        title.textContent = note.title; open.textContent = 'Open saved idea in Obsidian'; open.disabled = note.unavailable;
        open.onclick = async () => { try { await window.companion['idea-open'](note.id); } catch (error) { byId('idea-status').textContent = error.message; } };
        article.append(title, open); byId('saved-ideas').append(article);
      }
    } catch (error) { byId('idea-status').textContent = error.message; }
  }
  window.addEventListener('companion-idea-draft', async event => {
    invalidate(); const current = epoch; origin = event.detail; byId('idea-status').textContent = '';
    try {
      const draft = await window.companion['idea-draft'](origin); if (current !== epoch) return;
      byId('idea-editor').hidden = false; byId('idea-title').value = ''; byId('idea-explanation').value = draft.explanation; byId('idea-limitations').value = draft.limitations;
      byId('idea-title').focus();
    } catch (error) { if (current === epoch) byId('idea-status').textContent = error.message; }
  });
  byId('idea-preview-button').onclick = async () => {
    invalidate(); const current = epoch; byId('idea-status').textContent = '';
    try {
      const preview = await window.companion['idea-preview']({ ...origin, title: byId('idea-title').value, explanation: byId('idea-explanation').value, limitations: byId('idea-limitations').value });
      if (current !== epoch) return;
      operation = preview.operation; byId('idea-destination').value = preview.destination; byId('idea-markdown').value = preview.text;
      byId('idea-warnings').textContent = preview.warnings.join('\n'); byId('idea-preview').hidden = false;
    } catch (error) { if (current === epoch) byId('idea-status').textContent = error.message; }
  };
  byId('idea-cancel').onclick = invalidate;
  byId('idea-confirm').onclick = async () => {
    const current = epoch, approved = operation; if (!approved) return;
    byId('idea-confirm').disabled = true;
    try {
      await window.companion['idea-confirm']({ operation: approved });
      if (current !== epoch) return;
      invalidate(); byId('idea-status').textContent = 'Saved idea. The independent Markdown note is available in the vault.'; await list();
    } catch (error) { if (current === epoch) byId('idea-status').textContent = `Save failed. Proposed content is retained. Retry confirmation explicitly. ${error.message}`; }
    finally { byId('idea-confirm').disabled = false; }
  };
  document.getElementById('configure').addEventListener('click', () => setTimeout(list, 500));
  list();
})();
