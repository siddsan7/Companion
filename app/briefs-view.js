(() => {
  const view = document.getElementById('brief-view'); let state;
  function element(tag, text) { const e = document.createElement(tag); e.textContent = text; return e; }
  async function act(work) {
    try { await work(); }
    catch (error) { document.getElementById('brief-error').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  }
  function showRecord(record, target, edit) {
    const sourceDetails = document.createElement('details');
    sourceDetails.append(element('summary', 'Inspect complete selected source snapshots'));
    record.sources.forEach((s, i) => {
      const passage = element('pre', s.text.split(/\r?\n/).map((line, n) => `${n + 1} | ${line}`).join('\n'));
      passage.id = `${target.id}-source-${i + 1}`; passage.tabIndex = -1;
      sourceDetails.append(element('p', `Source ${i + 1}: ${s.path} | sha256 ${s.sha256}`), passage);
    });
    target.append(element('p', `${record.kind} | ${record.id}${record.version ? ` | Approved version ${record.version}` : ''}`));
    for (const section of record.sections) {
      if (edit) {
        const label = element('label', section.title), input = document.createElement('textarea');
        input.value = section.text; input.rows = 4; label.append(input); target.append(label);
        const refLabel = element('label', `${section.title} references`), refs = document.createElement('input');
        refs.dataset.references = section.title;
        refs.value = section.references.map(r => `${r.source + 1}:${r.start}-${r.end}`).join(', ');
        refs.placeholder = 'source:start-end, e.g. 1:3-5; blank requires Gap:';
        refLabel.append(refs); target.append(refLabel);
      } else target.append(element('h4', section.title), element('pre', section.text));
      for (const ref of section.references) {
        const link = element('a', `${record.sources[ref.source].path.split(/[\\/]/).pop()}:L${ref.start}-L${ref.end}`);
        link.href = `#${target.id}-source-${ref.source + 1}`;
        link.onclick = event => {
          event.preventDefault(); sourceDetails.open = true;
          const snapshot = sourceDetails.querySelector(`[id="${target.id}-source-${ref.source + 1}"]`);
          snapshot.scrollIntoView(); snapshot.focus();
        };
        target.append(link, element('span', ` | source ${ref.source + 1} `));
      }
    }
    target.append(sourceDetails);
  }
  async function refresh() {
    state = await window.companion['brief-state'](); view.replaceChildren();
    view.append(element('p', 'Offline source extraction. Review every section and its passages. Edits are user writing, not independent verification. A section needs passage references or an explicit Gap:. No Codex setup required.'));
    view.append(element('p', `Selected documents: ${state.selected.join('; ') || 'none'}`));
    view.append(element('p', state.approved.length ? `Approved version ${state.approved[0].version} available for pinning by conversations.` : 'No approved brief'));
    if (state.failure) view.append(element('p', `Refresh failed: ${state.failure}. Prior approved versions are preserved and marked outdated until a successful refresh. Resolve the source issue and propose again.`));
    if (state.issues.length) view.append(element('p', `Outdated approved brief. ${state.issues.join(' ')} Propose a refresh, or continue inspecting the preserved version.`));
    if (state.proposalIssues.length) view.append(element('p', `Refresh approval blocked. ${state.proposalIssues.join(' ')}`));
    if (state.proposed) {
      const proposed = document.createElement('article'); proposed.id = 'brief-proposal';
      proposed.append(element('h3', 'Proposed brief')); showRecord(state.proposed, proposed, true);
      const approve = element('button', 'Approve proposed brief');
      approve.onclick = () => act(async () => {
        await window.companion['brief-approve']({ id: state.proposed.id, digest: state.proposed.digest, sections: [...proposed.querySelectorAll('textarea')].map(e => e.value), references: [...proposed.querySelectorAll('input[data-references]')].map(e => e.value) });
        await refresh();
      });
      proposed.append(approve); view.append(proposed);
    }
    for (const record of state.approved) {
      const details = document.createElement('details'); details.id = `brief-approved-${record.version}`;
      details.append(element('summary', `Approved version ${record.version} | pin ${record.version}`));
      showRecord(record, details, false); view.append(details);
    }
  }
  document.getElementById('brief-readme').onclick = () => act(async () => { await window.companion['brief-select']('readme'); await refresh(); });
  document.getElementById('brief-add').onclick = () => act(async () => { await window.companion['brief-select']('additional'); await refresh(); });
  document.getElementById('brief-propose').onclick = () => act(async () => { document.getElementById('brief-error').textContent = ''; await window.companion['brief-propose'](); await refresh(); });
  document.getElementById('brief-check').onclick = () => act(refresh);
  document.getElementById('configure').addEventListener('click', () => setTimeout(() => act(refresh), 150));
  window.addEventListener('focus', () => act(refresh)); act(refresh);
})();
