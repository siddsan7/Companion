window.intakeView = {
  render(intake) {
    const state = document.getElementById('intake-state'), held = document.getElementById('held-imports'); state.replaceChildren(); held.replaceChildren();
    if (!intake) { state.textContent = 'Choose a vault before connecting sources.'; return; }
    for (const source of intake.sources) { const p = document.createElement('p'); p.textContent = `${source.kind === 'review' ? 'Finalized reviews' : 'Drafts'}: ${source.folder}${source.error ? ` — ${source.error}` : ''}`; state.append(p); }
    const p = document.createElement('p'); p.textContent = intake.lastCheck ? `Last check: ${intake.lastCheck.at} · ${intake.lastCheck.trigger} · ${intake.lastCheck.status}` : 'No intake check yet.'; state.append(p);
    for (const outcome of Object.values(intake.outcomes).filter(x => x.status === 'held')) { const p = document.createElement('p'); p.textContent = `${outcome.locator} — ${outcome.reason}`; held.append(p); }
    for (const capture of Object.values(intake.captures).filter(item => item.reviewChoices?.length)) { const p = document.createElement('p'); p.textContent = `${capture.title} — Choose the current reviewed revision in Inspect source. All revisions are retained; supporting evidence is paused until this choice.`; held.append(p); }
    if (!held.children.length) held.textContent = 'No held imports.';
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
    section.scrollIntoView();
  }
};
