window.intakeView = {
  render(intake) {
    const state = document.getElementById('intake-state'), held = document.getElementById('held-imports'); state.replaceChildren(); held.replaceChildren();
    if (!intake) { state.textContent = 'Choose a vault before connecting sources.'; return; }
    for (const source of intake.sources) { const p = document.createElement('p'); p.textContent = `${source.folder}${source.error ? ` — ${source.error}` : ''}`; state.append(p); }
    const p = document.createElement('p'); p.textContent = intake.lastCheck ? `Last check: ${intake.lastCheck.at} · ${intake.lastCheck.trigger} · ${intake.lastCheck.status}` : 'No intake check yet.'; state.append(p);
    for (const outcome of Object.values(intake.outcomes).filter(x => x.status === 'held')) { const p = document.createElement('p'); p.textContent = `${outcome.locator} — ${outcome.reason}`; held.append(p); }
    if (!held.children.length) held.textContent = 'No held imports.';
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
    section.scrollIntoView();
  }
};
