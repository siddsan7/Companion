(() => {
  const section = document.createElement('section'); section.setAttribute('aria-label', 'Capture deletion preview'); section.hidden = true;
  document.getElementById('browse-section').after(section);
  const recovery = document.createElement('section'); recovery.setAttribute('aria-label', 'Capture deletion recovery'); recovery.hidden = true;
  const review = document.createElement('button'); review.textContent = 'Review capture deletion recovery'; section.after(review, recovery);
  review.onclick = () => action(async () => {
    const pending = await window.captureDeletion.pending(); recovery.replaceChildren(); recovery.hidden = false;
    if (!pending.length) recovery.textContent = 'No unfinished confirmed capture deletions.';
    for (const item of pending) {
      const article = document.createElement('article'), scope = document.createElement('p'), resume = document.createElement('button');
      scope.textContent = `${item.id} — ${item.reason} Only the original confirmed files can be removed. Suppression remains in effect.\n${item.targets.join('\n')}`;
      resume.textContent = 'Resume confirmed capture deletion';
      resume.onclick = () => action(async () => { resume.disabled = true; status('Resuming confirmed capture deletion...'); try { await window.captureDeletion.resume({ id: item.id, operationId: item.operationId }); await refresh(); article.remove(); status('Capture deletion complete. Automatic re-import remains suppressed.'); } finally { resume.disabled = false; } });
      article.append(scope, resume); recovery.append(article);
    }
  });
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
