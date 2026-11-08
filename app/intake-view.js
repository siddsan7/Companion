window.intakeView = {
  render(intake) {
    const state = document.getElementById('intake-state'), held = document.getElementById('held-imports'); state.replaceChildren(); held.replaceChildren();
    if (!intake) { state.textContent = 'Choose a vault before connecting sources.'; return; }
    for (const source of intake.sources) { const p = document.createElement('p'); p.textContent = `${source.folder}${source.error ? ` — ${source.error}` : ''}`; state.append(p); }
    const p = document.createElement('p'); p.textContent = intake.lastCheck ? `Last check: ${intake.lastCheck.at} · ${intake.lastCheck.trigger} · ${intake.lastCheck.status}` : 'No intake check yet.'; state.append(p);
    for (const outcome of Object.values(intake.outcomes).filter(x => x.status === 'held')) { const p = document.createElement('p'); p.textContent = `${outcome.locator} — ${outcome.reason}`; held.append(p); }
    if (!held.children.length) held.textContent = 'No held imports.';
  },
  async repairs() {
    const section = document.getElementById('vault-repairs'); section.replaceChildren();
    if (!state.configured) return;
    const repairs = await window.companion['vault-repairs']();
    for (const item of repairs) {
      if (item.kind === 'missing') {
        const article = document.createElement('article'), reason = document.createElement('p'), scope = document.createElement('p'), restore = document.createElement('button'), remove = document.createElement('button');
        reason.textContent = item.reason; scope.textContent = 'Restore the last managed source revision, or confirm removal from active intake. Retain revision history and annotations, including recovery files. Removal suppresses automatic re-import; this action does not delete retained history.';
        restore.textContent = 'Restore last managed revision'; remove.textContent = 'Confirm missing capture removal from intake';
        restore.onclick = () => action(async () => { await window.companion['restore-missing']({ id: item.id, token: item.token }); await refresh(); status('Missing capture restored from its verified last managed revision.'); });
        remove.onclick = () => action(async () => { await window.companion['remove-missing']({ id: item.id, token: item.token }); await refresh(); status('Missing capture removed from active intake. History is retained and automatic re-import is suppressed.'); });
        article.append(reason, scope, restore, remove); section.append(article); continue;
      }
      if (item.kind === 'duplicate') {
        const article = document.createElement('article'), reason = document.createElement('p'); reason.textContent = item.reason; article.append(reason);
        for (const choice of item.files) {
          const choose = document.createElement('button'); choose.textContent = 'Use this file: ' + choice.file.replace(/\\/g, '/');
          choose.onclick = () => action(async () => { await window.companion['choose-identity']({ id: item.id, file: choice.file, token: item.token }); await refresh(); status('Identity selection saved. Every copy remains preserved.'); }); article.append(choose);
        }
        section.append(article); continue;
      }
      const article = document.createElement('article'), reason = document.createElement('p'), local = document.createElement('pre'), incoming = document.createElement('pre'), label = document.createElement('label'), textarea = document.createElement('textarea'), apply = document.createElement('button');
      reason.textContent = item.reason; local.textContent = 'Local writing:\n' + (item.local || 'Missing local note'); incoming.textContent = 'Incoming revision ' + item.incomingRevision + '\n' + item.incoming;
      label.textContent = 'Transfer local writing'; textarea.value = item.local || ''; label.append(textarea); apply.textContent = 'Save annotation and apply incoming';
      apply.onclick = () => action(async () => { const bytes = new TextEncoder().encode(item.local || ''); const digest = await crypto.subtle.digest('SHA-256', bytes); const localHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join(''); await window.companion['resolve-conflict']({ sourceHash: item.sourceHash, text: textarea.value, localHash }); await refresh(); status('Conflict resolved. Local writing is preserved in an independent annotation.'); });
      article.append(reason, local, incoming, label, apply); section.append(article);
    }
  },
  async inspect(id) {
    const info = await window.companion['inspect-source'](id), section = document.getElementById('source-inspection'), details = document.getElementById('source-details'); details.replaceChildren(); section.hidden = false;
    for (const revision of info.revisions) {
      const article = document.createElement('article'), heading = document.createElement('h3'), status = document.createElement('p'), provenance = document.createElement('p'), text = document.createElement('pre'), evidence = document.createElement('pre');
      heading.textContent = `${revision.target.title} · ${revision.id}${revision.id === info.capture.currentRevision ? ' · current' : ''}`;
      status.textContent = `Extraction: ${revision.extraction} · Human review: ${revision.humanReview} · Validation: ${revision.run.validation}`;
      provenance.textContent = `Source bytes: ${revision.sourceHash}\nAttempt: ${revision.run.attempt_id}\nInput: ${revision.run.input_kind}\nSource time: ${revision.run.started_utc}\nImported: ${revision.importedAt}\nFirst captured: ${info.capture.capturedAt}\nLocator: ${revision.locator}\nNo source URL supplied. Source hashes group equal bytes, not semantic identities.`;
      text.textContent = revision.text;
      evidence.textContent = JSON.stringify({ uncertainty: revision.uncertainty, evidence: revision.evidence }, null, 2); article.append(heading, status, provenance, text, evidence); details.append(article);
    }
    const annotations = document.createElement('div');
    for (const annotation of info.annotations) { const text = document.createElement('pre'); text.textContent = annotation.content; annotations.append(text); }
    const label = document.createElement('label'), input = document.createElement('textarea'), save = document.createElement('button'), annotationId = crypto.randomUUID();
    label.textContent = 'New annotation'; label.append(input); save.textContent = 'Save annotation';
    save.onclick = () => action(async () => { await window.companion['add-annotation']({ id: annotationId, captureId: id, text: input.value }); await window.intakeView.inspect(id); status('Annotation saved. Source content remains managed separately.'); });
    details.append(annotations, label, save);
    section.scrollIntoView();
  }
};
