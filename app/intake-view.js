window.intakeView = {
  retireRepairs() {
    const section = document.getElementById('vault-repairs');
    section.setAttribute('aria-busy', 'true');
    for (const button of section.querySelectorAll('button')) button.disabled = true;
  },
  settleRepairs() { document.getElementById('vault-repairs').setAttribute('aria-busy', 'false'); },
  render(intake, location) {
    const state = document.getElementById('intake-state'), held = document.getElementById('held-imports'); state.replaceChildren(); held.replaceChildren();
    const selection = document.getElementById('reconnect-selection');
    const previous = this.location === location ? selection.value : '';
    if (this.location !== location) document.getElementById('reconnect-folder').value = '';
    this.location = location;
    selection.replaceChildren(new Option('Choose a connected source', ''));
    if (!intake) { state.textContent = 'Choose a vault before connecting sources.'; return; }
    for (const source of intake.sources) {
      const label = `${source.kind === 'review' ? 'Finalized reviews' : 'Drafts'}: ${source.folder}`;
      const p = document.createElement('p');
      p.textContent = label + (source.error ? ` — ${source.error}` : '');
      state.append(p);
      selection.add(new Option(label, source.id));
    }
    if (intake.sources.some(source => source.id === previous)) selection.value = previous;
    const p = document.createElement('p'); p.textContent = intake.lastCheck ? `Last check: ${intake.lastCheck.at} · ${intake.lastCheck.trigger} · ${intake.lastCheck.status}` : 'No intake check yet.'; state.append(p);
    for (const outcome of Object.values(intake.outcomes).filter(x => x.status === 'held')) { const p = document.createElement('p'); p.textContent = `${outcome.locator} — ${outcome.reason}`; held.append(p); }
    for (const capture of Object.values(intake.captures).filter(item => item.reviewChoices?.length)) { const p = document.createElement('p'); p.textContent = `${capture.title} — Choose the current reviewed revision in Inspect source. All revisions are retained; supporting evidence is paused until this choice.`; held.append(p); }
    if (!held.children.length) held.textContent = 'No held imports.';
  },
  async repairs(owned = () => true) {
    const section = document.getElementById('vault-repairs'), location = state.location;
    if (!owned()) return;
    if (this.repairsLocation !== location) { section.replaceChildren(); this.repairsLocation = location; }
    if (!state.configured || !state.intake) return;
    let repairs;
    try { repairs = await window.companion['vault-repairs'](); }
    catch (error) { if (!owned() || state.location !== location) return; throw error; }
    if (!owned() || state.location !== location) return;
    // A transient busy/error response must not erase the last successful same-vault view.
    section.replaceChildren();
    for (const item of repairs) {
      if (item.kind === 'annotation-link') {
        const article = document.createElement('article'), reason = document.createElement('p'), retry = document.createElement('button');
        reason.textContent = 'Annotation relationship paused: ' + item.file + ' — ' + item.reason + ' Current writing and relationship recovery versions are preserved. Retry changes only the current generated link; independent source intake can continue.';
        retry.textContent = 'Retry annotation relationship';
        retry.onclick = () => action(async () => { if (!owned()) return; const result = await window.companion['retry-annotation-link']({ id: item.id, token: item.token }); await refresh(); status(result.held ? 'Annotation relationship remains paused. Inspect the preserved writing before retrying.' : 'Annotation relationship retry complete. Independent writing and recovery versions are preserved.'); });
        article.append(reason, retry); section.append(article); continue;
      }
      if (item.kind === 'missing') {
        const article = document.createElement('article'), reason = document.createElement('p'), scope = document.createElement('p'), restore = document.createElement('button'), remove = document.createElement('button');
        reason.textContent = item.reason; scope.textContent = 'Restore the last managed source revision, or confirm removal from active intake. Retain revision history and annotations, including recovery files. Removal suppresses automatic re-import; this action does not delete retained history.';
        restore.textContent = 'Restore last managed revision'; remove.textContent = 'Confirm missing capture removal from intake';
        restore.onclick = () => action(async () => { if (!owned()) return; await window.companion['restore-missing']({ id: item.id, token: item.token }); await refresh(); status('Missing capture restored from its verified last managed revision.'); });
        remove.onclick = () => action(async () => { if (!owned()) return; await window.companion['remove-missing']({ id: item.id, token: item.token }); await refresh(); status('Missing capture removed from active intake. History is retained and automatic re-import is suppressed.'); });
        article.append(reason, scope, restore, remove); section.append(article); continue;
      }
      if (item.kind === 'duplicate') {
        const article = document.createElement('article'), reason = document.createElement('p'); reason.textContent = item.reason; article.append(reason);
        for (const choice of item.files) {
          const choose = document.createElement('button'); choose.textContent = 'Use this file: ' + choice.file.replace(/\\/g, '/');
          choose.onclick = () => action(async () => { if (!owned()) return; await window.companion['choose-identity']({ id: item.id, file: choice.file, token: item.token }); await refresh(); status('Identity selection saved. Every copy remains preserved.'); }); article.append(choose);
        }
        section.append(article); continue;
      }
      const article = document.createElement('article'), reason = document.createElement('p'), local = document.createElement('pre'), incoming = document.createElement('pre'), label = document.createElement('label'), textarea = document.createElement('textarea'), apply = document.createElement('button');
      reason.textContent = item.reason; local.textContent = 'Local writing:\n' + (item.local || 'Missing local note'); incoming.textContent = 'Incoming revision ' + item.incomingRevision + '\n' + item.incoming;
      label.textContent = 'Transfer local writing'; textarea.value = item.local || ''; label.append(textarea); apply.textContent = 'Save annotation and apply incoming';
      apply.onclick = () => action(async () => { if (!owned()) return; const text = textarea.value, bytes = new TextEncoder().encode(item.local || ''); const digest = await crypto.subtle.digest('SHA-256', bytes); if (!owned()) return; const localHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join(''); await window.companion['resolve-conflict']({ sourceHash: item.sourceHash, text, localHash }); await refresh(); status('Conflict resolved. Local writing is preserved in an independent annotation.'); });
      article.append(reason, local, incoming, label, apply); section.append(article);
    }
  },
  async inspect(id) {
    const info = await window.companion['inspect-source'](id), section = document.getElementById('source-inspection'), details = document.getElementById('source-details'); details.replaceChildren(); section.hidden = false;
    const eligibility = document.createElement('p');
    eligibility.textContent = info.capture.rejected ? 'Supporting evidence: excluded by rejection. Historical material remains inspectable.' : info.capture.reviewChoices?.length ? 'Supporting evidence: paused pending an explicit current reviewed revision choice.' : 'Supporting evidence: eligible with the recorded extraction limits and human findings. Acceptance does not verify every claim.';
    details.append(eligibility);
    for (const link of info.links) {
      const relation = document.createElement('p'); relation.textContent = `User-linked source: ${link.related?.title || 'Missing linked capture'} · ${link.related?.id || link.captureIds.find(item => item !== id)} · ${link.linkedAt}. Captures and revision histories remain separate.`; details.append(relation);
    }
    if (info.related.length) {
      const label = document.createElement('label'), select = document.createElement('select'), placeholder = document.createElement('option'), link = document.createElement('button');
      label.textContent = 'Related changed-byte capture'; placeholder.value = ''; placeholder.textContent = 'Choose a separate capture'; select.append(placeholder);
      for (const candidate of info.related) { const option = document.createElement('option'); option.value = candidate.id; option.textContent = `${candidate.title} · ${candidate.sourceHash}`; select.append(option); }
      label.append(select); link.textContent = 'Link sources';
      link.onclick = () => action(async () => { await window.companion['link-sources']({ id, related: select.value }); await refresh(); await window.intakeView.inspect(id); status('Sources linked. Captures and revision histories remain separate.'); });
      details.append(label, link);
    }
    for (const revision of info.revisions) {
      const article = document.createElement('article'), heading = document.createElement('h3'), reviewState = document.createElement('p'), provenance = document.createElement('p'), text = document.createElement('pre'), evidence = document.createElement('pre');
      heading.textContent = `${(revision.target?.title || 'Rejected source')} · ${revision.id}${revision.id === info.capture.currentRevision ? ' · current' : ''}`;
      reviewState.textContent = `Processing: ${revision.processing || revision.run.state || 'unknown'} · Extraction: ${revision.extraction} · Human review: ${revision.humanReview} · Validation: ${revision.run.validation}`;
      provenance.textContent = `Source bytes: ${revision.sourceHash}\nAttempt: ${revision.run.attempt_id}\nInput: ${revision.run.input_kind}\nSource time: ${revision.run.started_utc}\nImported: ${revision.importedAt}\nFirst captured: ${info.capture.capturedAt}\nLocator: ${revision.locator}\nNo source URL supplied. Source hashes group equal bytes, not semantic identities.`;
      if (revision.review) {
        const choose = document.createElement('button'); choose.textContent = 'Make current';
        choose.onclick = () => action(async () => { await window.companion['select-review']({ id, revision: revision.id }); await refresh(); await window.intakeView.inspect(id); status('Current revision selected.'); }); article.append(choose);
      }
      text.textContent = revision.text;
      evidence.textContent = JSON.stringify({ uncertainty: revision.uncertainty, evidence: revision.evidence, review: revision.review, metrics: revision.metrics }, null, 2); if (revision.review) { const warning = document.createElement('p'); warning.textContent = 'Acceptance does not verify every claim. Findings refer to the original output; edits are retained separately. Synthetic fixtures are not real reviewed source evidence.'; article.append(warning); } article.append(heading, reviewState, provenance, text, evidence); details.append(article);
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
