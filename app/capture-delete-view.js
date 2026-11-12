(() => {
  const section = document.createElement('section'); section.setAttribute('aria-label', 'Capture deletion preview'); section.hidden = true;
  document.getElementById('browse-section').after(section);
  const recovery = document.createElement('section'); recovery.setAttribute('aria-label', 'Capture deletion recovery'); recovery.hidden = true;
  const recoveryControls = document.createElement('fieldset'); Object.assign(recoveryControls.style, { border: '0', padding: '0', margin: '0', minWidth: '0' }); recovery.append(recoveryControls);
  let recoveryEpoch = 0;
  const review = document.createElement('button'); review.textContent = 'Review capture deletion recovery'; section.after(review, recovery);
  function recoveryFolders(item, article, afterReview) {
    const inspect = document.createElement('button'), details = document.createElement('div'); inspect.textContent = 'Review recovery folders';
    inspect.onclick = () => action(async () => {
      const selected = await window.captureDeletion['scope-preview']({ id: item.id, operationId: item.operationId });
      const paths = document.createElement('p'), confirm = document.createElement('button'), cancel = document.createElement('button');
      paths.textContent = 'Older recovery metadata did not record all shared folders. Review these ordinary folders explicitly. Existing recorded identities must still match. This does not restore source content.\n' + selected.directories.join('\n');
      confirm.textContent = 'Confirm reviewed recovery folders'; cancel.textContent = 'Cancel recovery folder review';
      cancel.onclick = () => action(async () => { await window.captureDeletion['scope-cancel']({ token: selected.token }); details.replaceChildren(); });
      confirm.onclick = () => action(async () => { await window.captureDeletion['scope-confirm']({ token: selected.token }); await afterReview(); status('Recovery folders reviewed. Inspect the exact operation before resuming.'); });
      details.replaceChildren(paths, confirm, cancel);
    });
    article.append(inspect, details);
  }
  review.onclick = () => action(async () => {
    const owner = ++recoveryEpoch, configuration = configurationEpoch; recoveryControls.disabled = true; recovery.setAttribute('aria-busy', 'true');
    try {
    const pending = await window.captureDeletion.pending();
    if (owner !== recoveryEpoch || configuration !== configurationEpoch) return;
    recoveryControls.replaceChildren(); recovery.hidden = false;
    if (!pending.length) recoveryControls.textContent = 'No unfinished confirmed source operations.';
    for (const item of pending) {
      const article = document.createElement('article'), scope = document.createElement('p'), resume = document.createElement('button');
      scope.textContent = `${item.id} — ${item.reason} Only the original confirmed scope is authorized. Source evidence stays unavailable until verified restoration.\n${item.targets.join('\n')}`;
      resume.textContent = item.phase === 'restoring' ? 'Resume verified source restoration' : 'Resume confirmed capture deletion'; resume.disabled = item.blockedByScope;
      resume.onclick = () => action(async () => { resume.disabled = true; status(item.phase === 'restoring' ? 'Resuming verified source restoration...' : 'Resuming confirmed capture deletion...'); try { await window.captureDeletion.resume({ id: item.id, operationId: item.operationId }); await refresh(); article.remove(); status(item.phase === 'restoring' ? 'Source restored from the exact authorized operation.' : 'Capture deletion complete. Automatic re-import remains suppressed.'); } finally { resume.disabled = item.blockedByScope; } });
      article.append(scope, resume); recoveryControls.append(article);
      if (item.needsScopeReview) recoveryFolders(item, article, () => review.onclick());
      if (item.phase === 'restoring' && item.manual && !item.blockedByScope) {
        const label = document.createElement('label'), file = document.createElement('input'), preview = document.createElement('button'), details = document.createElement('div');
        label.textContent = 'Selected recovery backup file'; label.append(file); preview.textContent = 'Preview a new source restoration';
        details.setAttribute('aria-label', 'New source restoration preview'); details.hidden = true;
        preview.onclick = () => action(async () => {
          const selected = await window.captureDeletion['retry-preview']({ id: item.id, operationId: item.operationId, file: file.value });
          const scope = document.createElement('p'), text = document.createElement('pre'), confirm = document.createElement('button'), cancel = document.createElement('button');
          scope.textContent = 'This is a new explicitly selected restoration, with a fresh source generation. The earlier operation cannot recreate its missing publication. Only these reviewed old copies will be retired before new publication. Previously absent slots must remain absent. No existing destination or edited writing will be overwritten.\n' + selected.targets.map(target => `${target.absent ? 'Must stay absent' : 'Retire exact reviewed copy'}: ${target.file}`).join('\n');
          text.textContent = selected.text; confirm.textContent = 'Confirm new source restoration'; cancel.textContent = 'Cancel new source restoration';
          cancel.onclick = () => action(async () => { await window.captureDeletion['retry-cancel']({ token: selected.token }); details.hidden = true; });
          confirm.onclick = () => action(async () => { confirm.disabled = true; status('Restoring newly reviewed source...'); try { await window.captureDeletion['retry-confirm']({ token: selected.token }); await refresh(); article.remove(); status('Source restored from a newly reviewed operation. Earlier references remain unavailable.'); } finally { confirm.disabled = false; } });
          details.replaceChildren(scope, text, confirm, cancel); details.hidden = false;
        });
        article.append(label, preview, details);
      }
    }
    } finally { if (owner === recoveryEpoch) { recoveryControls.disabled = false; recovery.removeAttribute('aria-busy'); } }
  });
  const restoreReview = document.createElement('button'); restoreReview.textContent = 'Review suppressed captures';
  const restoration = document.createElement('section'); restoration.setAttribute('aria-label', 'Source restoration'); restoration.hidden = true;
  recovery.after(restoreReview, restoration);
  document.getElementById('configure').addEventListener('click', () => { recoveryEpoch++; recoveryControls.disabled = false; recovery.removeAttribute('aria-busy'); recovery.hidden = true; restoration.hidden = true; section.hidden = true; });
  restoreReview.onclick = () => action(async () => {
    const captures = await window.captureDeletion.suppressed(); restoration.replaceChildren(); restoration.hidden = false;
    if (!captures.length) restoration.textContent = 'No deliberately deleted sources.';
    for (const capture of captures) {
      const article = document.createElement('article'), title = document.createElement('h3'), label = document.createElement('label'), folder = document.createElement('input'), kindLabel = document.createElement('label'), kind = document.createElement('select'), preview = document.createElement('button'), details = document.createElement('div');
      title.textContent = capture.title + ' · ' + capture.id; label.textContent = capture.manual ? 'Selected manual capture file' : 'Selected producer artifact folder'; label.append(folder);
      kindLabel.textContent = 'Selected producer artifact kind';
      for (const [value, text] of [['draft', 'Validated draft'], ['review', 'Finalized review']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; kind.append(option); }
      kindLabel.append(kind); preview.textContent = 'Preview source restoration';
      kindLabel.hidden = capture.manual;
      preview.onclick = () => action(async () => {
        details.replaceChildren();
        const selected = await window.captureDeletion['restoration-preview'](capture.manual ? { id: capture.id, file: folder.value } : { id: capture.id, folder: folder.value, kind: kind.value });
        const scope = document.createElement('p'), text = document.createElement('pre'), confirm = document.createElement('button');
        scope.textContent = capture.manual ? 'Only this exact selected manual capture backup will be restored, with its original identity, capture instant and content checksum. A fresh source generation keeps earlier references unavailable.' : `Only this selected producer artifact will be restored as a fresh revision and source generation. Earlier unselected attempts remain deleted. Original producer acceptance stays unchanged. Independent writing keeps its original attribution. ${selected.identity} · ${selected.fingerprint} · ${selected.review}`;
        text.textContent = selected.text; confirm.textContent = 'Confirm source restoration';
        confirm.onclick = () => action(async () => { confirm.disabled = true; status('Restoring selected source...'); try { await window.captureDeletion['restoration-confirm']({ token: selected.token }); article.remove(); await refresh(); status('Source restored from the selected artifact. Earlier references remain unavailable.'); } finally { confirm.disabled = false; } });
        details.append(scope, text, confirm);
      });
      article.append(title, label, kindLabel, preview, details); restoration.append(article);
      if (capture.needsScopeReview) recoveryFolders(capture, article, () => restoreReview.onclick());
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
      for (const writing of preview.retainedWriting || []) {
        const item = document.createElement('article'), heading = document.createElement('h3'), disclosure = document.createElement('p'), text = document.createElement('pre');
        heading.textContent = `Retain ${writing.title}: ${writing.id} · ${writing.file}`;
        disclosure.textContent = 'These retained copies still contain source quotations. Supporting source evidence becomes unavailable. The complete retained text follows.';
        text.textContent = writing.text; item.append(heading, disclosure, text); section.append(item);
      }
      for (const dependent of preview.dependents || preview.annotations.map(annotation => ({ ...annotation, kind: 'annotation', attribution: 'affected' }))) {
        const item = document.createElement('article'), heading = document.createElement('h3'), state = document.createElement('p'), text = document.createElement('pre');
        heading.textContent = 'Preserve ' + dependent.kind + ': ' + dependent.file;
        state.textContent = `${dependent.id || ''}${dependent.requestId ? ' · request ' + dependent.requestId : ''}. ${dependent.attribution === 'unknown' ? 'Dependency attribution is unknown. Preserve and inspect this writing; no removal is authorized.' : 'Independent writing and its quotations remain. Supporting evidence becomes unavailable for future context.'}`;
        text.textContent = dependent.text; item.append(heading, state, text); section.append(item);
        if (dependent.requestId && dependent.storage === 'durable' && dependent.file === `Local history/${dependent.id}.json`) {
          const request = document.createElement('button'); request.textContent = 'Review this request for local removal';
          request.onclick = () => window.dispatchEvent(new CustomEvent('companion-review-stored-request', { detail: { id: dependent.id, requestId: dependent.requestId } }));
          item.append(request);
        }
      }
      const further = document.createElement('p'); further.textContent = 'Further removal needs separate review and confirmation. In Project conversations, preview local request removal to select one stored request. Saved ideas, annotations and readable transcripts have their own removal controls. Whole conversation deletion includes every request. Local history archives, comparison records, separate exports, backups and previous provider submissions may retain copies.'; section.append(further);
      const confirm = document.createElement('button'), cancel = document.createElement('button');
      confirm.textContent = 'Confirm capture deletion'; cancel.textContent = 'Cancel capture deletion';
      cancel.onclick = () => action(async () => { await window.captureDeletion.cancel({ token: preview.token }); section.hidden = true; });
      confirm.onclick = () => action(async () => { confirm.disabled = true; try { await window.captureDeletion.confirm({ token: preview.token }); section.hidden = true; await refresh(); status('Capture deleted. Independent writing remains; supporting evidence is unavailable.'); } finally { confirm.disabled = false; } });
      section.append(confirm, cancel); section.scrollIntoView();
    }
  };
})();
