(() => {
  const section = document.createElement('section'), heading = document.createElement('h2'), reviewButton = document.createElement('button'), review = document.createElement('div'), preview = document.createElement('section'), recoveryButton = document.createElement('button'), recovery = document.createElement('div');
  section.setAttribute('aria-label', 'Independent annotations'); heading.textContent = 'Independent annotations';
  reviewButton.textContent = 'Review annotations'; review.setAttribute('aria-label', 'Annotation removal review'); review.hidden = true;
  preview.setAttribute('aria-label', 'Annotation removal preview'); preview.hidden = true;
  recoveryButton.textContent = 'Review unfinished annotation removals'; recovery.setAttribute('aria-label', 'Unfinished annotation removals'); recovery.hidden = true;
  section.append(heading, reviewButton, review, preview, recoveryButton, recovery); document.getElementById('source-inspection').after(section);
  let epoch = 0;
  document.getElementById('configure').addEventListener('click', () => { epoch++; review.hidden = preview.hidden = recovery.hidden = true; });
  async function list() {
    const owner = ++epoch, notes = await window.annotationRemoval.list(); if (owner !== epoch) return;
    review.replaceChildren(); review.hidden = false;
    const grouped = new Map();
    for (const note of notes) { if (!grouped.has(note.id)) grouped.set(note.id, []); grouped.get(note.id).push(note); }
    if (!grouped.size) review.textContent = 'No retained annotations were found.';
    for (const [id, copies] of grouped) {
      const article = document.createElement('article'), title = document.createElement('h3'), button = document.createElement('button'); title.textContent = id;
      article.append(title);
      for (const note of copies) { const location = document.createElement('p'), text = document.createElement('pre'); location.textContent = note.file; text.textContent = note.text; article.append(location, text); }
      button.textContent = 'Preview annotation removal'; button.onclick = () => action(async () => {
        const selected = await window.annotationRemoval.preview(id); if (owner !== epoch) { await window.annotationRemoval.cancel(selected.token); return; }
        const scope = document.createElement('p'), paths = document.createElement('pre'), confirm = document.createElement('button'), cancel = document.createElement('button');
        scope.textContent = `Permanently remove annotation ${id} and only the exact managed writing copies listed below. Source material, other annotations, ideas, conversations and transcripts remain. They can retain quotations. External backups, exports and provider records remain outside this scope. The removal identity stays in the vault ledger; losing that entire authority can lose the protection against old recovery copies.`;
        paths.textContent = selected.targets.join('\n'); confirm.textContent = 'Confirm annotation removal'; cancel.textContent = 'Cancel annotation removal';
        cancel.onclick = () => action(async () => { await window.annotationRemoval.cancel(selected.token); preview.hidden = true; });
        confirm.onclick = () => action(async () => { confirm.disabled = cancel.disabled = true; try { await window.annotationRemoval.confirm(selected.token); preview.hidden = true; await list(); status('Annotation removed. Other writing and source material remain.'); } finally { confirm.disabled = cancel.disabled = false; } });
        preview.replaceChildren(scope, paths, confirm, cancel); preview.hidden = false;
      }); article.append(button); review.append(article);
    }
  }
  reviewButton.onclick = () => action(list);
  recoveryButton.onclick = () => action(async () => {
    const owner = epoch, pending = await window.annotationRemoval.pending(); if (owner !== epoch) return;
    recovery.replaceChildren(); recovery.hidden = false;
    if (!pending.length) recovery.textContent = 'No unfinished annotation removals.';
    for (const operation of pending) {
      const article = document.createElement('article'), scope = document.createElement('pre'), resume = document.createElement('button');
      scope.textContent = `${operation.id}\nOnly the already confirmed copies will be removed:\n${operation.targets.join('\n')}`;
      resume.textContent = 'Resume reviewed annotation removal'; resume.onclick = () => action(async () => { resume.disabled = true; try { await window.annotationRemoval.resume({ id: operation.id, operationId: operation.operationId }); article.remove(); await list(); status('Annotation removed. Confirmed removal recovered.'); } finally { resume.disabled = false; } });
      article.append(scope, resume); recovery.append(article);
    }
  });
})();
