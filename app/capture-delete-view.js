(() => {
  const section = document.createElement('section'); section.setAttribute('aria-label', 'Capture deletion preview'); section.hidden = true;
  document.getElementById('browse-section').after(section);
  window.captureDeletionView = {
    async preview(id) {
      const preview = await window.captureDeletion.preview({ id });
      section.replaceChildren(); section.hidden = false;
      const title = document.createElement('h2'); title.textContent = 'Delete capture: ' + preview.title;
      const label = document.createElement('label'), selected = document.createElement('input'); selected.type = 'checkbox'; selected.checked = true; selected.disabled = true;
      label.append(selected, 'Current capture and all snapshots');
      const scope = document.createElement('p'); scope.textContent = `${preview.revisions} revision snapshots. Automatic re-import stays suppressed until explicit restoration. Independent writing and its quotations remain with unavailable-evidence warnings. Original producer files, videos and separate exports/backups remain.`;
      section.append(title, label, scope);
      for (const file of preview.targets) { const item = document.createElement('p'); item.textContent = 'Remove: ' + file; section.append(item); }
      for (const annotation of preview.annotations) { const item = document.createElement('pre'); item.textContent = 'Preserve annotation: ' + annotation.file + '\n' + annotation.text; section.append(item); }
      const confirm = document.createElement('button'), cancel = document.createElement('button');
      confirm.textContent = 'Confirm capture deletion'; cancel.textContent = 'Cancel capture deletion';
      cancel.onclick = () => action(async () => { await window.captureDeletion.cancel({ token: preview.token }); section.hidden = true; });
      confirm.onclick = () => action(async () => { confirm.disabled = true; try { await window.captureDeletion.confirm({ token: preview.token }); section.hidden = true; await refresh(); status('Capture deleted. Independent writing remains; supporting evidence is unavailable.'); } finally { confirm.disabled = false; } });
      section.append(confirm, cancel); section.scrollIntoView();
    }
  };
})();
