(() => {
  const section = document.createElement('section'); section.id = 'ideas-section'; section.setAttribute('aria-label', 'Saved ideas');
  section.innerHTML = '<h2>Saved ideas</h2><p>Keep useful observations and failed analogies explicitly. A conversation does not create a note automatically.</p><div id="idea-editor" hidden><label>Idea title<input id="idea-title"></label><label>Idea explanation<textarea id="idea-explanation" rows="8"></textarea></label><label>Idea limitations<textarea id="idea-limitations" rows="3"></textarea></label><button id="idea-preview-button">Preview saved idea</button><div id="idea-preview" hidden><label>Proposed idea destination<input id="idea-destination" readonly></label><label>Proposed idea Markdown<textarea id="idea-markdown" rows="16" readonly></textarea></label><p id="idea-warnings"></p><button id="idea-confirm">Confirm saved idea</button><button id="idea-cancel">Cancel saved idea preview</button></div></div><p id="idea-status" aria-live="polite"></p><div id="saved-ideas"></div>';
  document.getElementById('conversation-section').after(section);
  const byId = id => document.getElementById(id);
  const refreshSupport = document.createElement('button'), supportStatus = document.createElement('p');
  refreshSupport.textContent = 'Refresh saved idea support'; refreshSupport.disabled = true; supportStatus.id = 'idea-support-status';
  byId('saved-ideas').before(refreshSupport, supportStatus);
  const kindLabel = document.createElement('label'), kind = document.createElement('select');
  kindLabel.htmlFor = 'idea-kind'; kindLabel.textContent = 'Saved idea kind'; kind.id = 'idea-kind';
  for (const [value, label] of [['observation', 'Observation'], ['failed_analogy', 'Failed analogy'], ['experiment_proposal', 'Experiment Proposal']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; kind.append(option);
  }
  const experiments = document.createElement('div'); experiments.id = 'idea-experiment-fields'; experiments.hidden = true;
  const experimentFields = [['hypothesis', 'Hypothesis'], ['borrowed_mechanism', 'Borrowed mechanism'], ['project_application', 'Project application'], ['smallest_test', 'Smallest test'], ['observable_result', 'Observable result']];
  for (const [key, title] of experimentFields) {
    const label = document.createElement('label'), field = document.createElement('textarea');
    field.id = `idea-experiment-${key}`; field.rows = 3; label.htmlFor = field.id; label.textContent = title; experiments.append(label, field);
  }
  byId('idea-preview-button').before(kindLabel, kind, experiments);
  const references = document.createElement('div'); references.id = 'idea-references';
  byId('idea-preview-button').before(references);
  const evidenceView = document.createElement('div'); evidenceView.id = 'idea-evidence'; section.append(evidenceView);
  const pendingView = document.createElement('div'); pendingView.id = 'pending-ideas'; section.append(pendingView);
  let origin = null, operation = null, epoch = 0, listEpoch = 0, vaultEpoch = 0, initialSupportPending = true;
  const invalidate = () => { epoch++; operation = null; byId('idea-preview').hidden = true; };
  for (const field of ['title', 'explanation', 'limitations']) byId(`idea-${field}`).oninput = invalidate;
  for (const [key] of experimentFields) byId(`idea-experiment-${key}`).oninput = invalidate;
  kind.onchange = () => { invalidate(); experiments.hidden = kind.value !== 'experiment_proposal'; };
  function fillEditor(input, offered = [], checked = []) {
    byId('idea-editor').hidden = false;
    for (const key of ['title', 'explanation', 'limitations']) byId(`idea-${key}`).value = input[key] || '';
    kind.value = input.kind || 'observation'; experiments.hidden = kind.value !== 'experiment_proposal';
    for (const [key] of experimentFields) byId(`idea-experiment-${key}`).value = input.experiment?.[key] || '';
    references.replaceChildren();
    for (const reference of offered) {
      const label = document.createElement('label'), checkbox = document.createElement('input'), excerpt = document.createElement('pre');
      checkbox.type = 'checkbox'; checkbox.id = `idea-reference-${reference.referenceId}`; checkbox.value = reference.referenceId; checkbox.checked = checked.includes(reference.referenceId); checkbox.onchange = invalidate;
      label.htmlFor = checkbox.id; label.textContent = reference.label; excerpt.textContent = reference.excerpt; references.append(label, checkbox, excerpt);
    }
  }
  function showPreview(preview) {
    operation = preview.blocked ? null : preview.operation; byId('idea-destination').value = preview.destination; byId('idea-markdown').value = preview.text;
    byId('idea-warnings').textContent = preview.warnings.join('\n'); byId('idea-preview').hidden = false; byId('idea-confirm').disabled = !!preview.blocked;
  }
  async function list() {
    const request = ++listEpoch, owner = vaultEpoch, view = epoch;
    const current = () => request === listEpoch && owner === vaultEpoch && view === epoch;
    supportStatus.textContent = 'Checking current saved idea support…';
    try {
      const notes = await window.companion['idea-list'](); if (!current()) return;
      byId('saved-ideas').replaceChildren();
      for (const note of notes) {
        const article = document.createElement('article'), title = document.createElement('h3'), open = document.createElement('button');
        title.textContent = note.title; open.textContent = 'Open saved idea in Obsidian'; open.disabled = note.unavailable;
        open.onclick = async () => { try { await window.companion['idea-open'](note.id); } catch (error) { if (current()) byId('idea-status').textContent = error.message; } };
        article.append(title, open); byId('saved-ideas').append(article);
        if (note.reviewSupport) {
          const warning = document.createElement('p'); warning.textContent = `Review support. ${note.supportWarnings.join(' ')} Independent writing remains available; this inspection does not rewrite it.`; article.append(warning);
        }
        for (let index = 0; index < note.citationCount; index++) {
          const inspect = document.createElement('button'); inspect.textContent = 'Inspect cited evidence';
          inspect.onclick = async () => {
            try {
              const evidence = await window.companion['idea-evidence']({ id: note.id, index }); if (!current()) return;
              evidenceView.replaceChildren();
              const heading = document.createElement('h3'), warnings = document.createElement('p');
              heading.textContent = `Cited revision ${evidence.anchor.revision_id}; evidence ${evidence.anchor.evidence_id}`; warnings.textContent = evidence.warnings.join('\n'); evidenceView.append(heading, warnings);
              if (evidence.available) {
                const details = document.createElement('p'), excerpt = document.createElement('pre'), label = document.createElement('label'), snapshot = document.createElement('textarea');
                details.textContent = `Human review: ${evidence.humanReview}; extraction: ${evidence.extraction}; processing: ${evidence.processing}. Claims are not independently verified. Uncertainty: ${JSON.stringify(evidence.uncertainty || {})}`;
                excerpt.textContent = evidence.anchor.excerpt; label.htmlFor = 'idea-evidence-snapshot'; label.textContent = 'Cited revision snapshot'; snapshot.id = 'idea-evidence-snapshot'; snapshot.readOnly = true; snapshot.rows = 14; snapshot.value = evidence.text;
                evidenceView.append(details, excerpt, label, snapshot);
              }
            } catch (error) { if (current()) byId('idea-status').textContent = error.message; }
          }; article.append(inspect);
        }
      }
      const proposals = await window.companion['idea-pending'](); if (!current()) return;
      pendingView.replaceChildren();
      for (const proposal of proposals) {
        const article = document.createElement('article'), title = document.createElement('h3'), resume = document.createElement('button');
        title.textContent = proposal.title; resume.textContent = 'Resume proposed idea';
        if (proposal.cleanup) { const state = document.createElement('p'); state.textContent = 'The note is already published. Resume to review and explicitly finish local staging cleanup.'; article.append(state); }
        else if (proposal.hasPublication) { const state = document.createElement('p'); state.textContent = 'The note is already published. Resume to acknowledge it and finish local staging cleanup.'; article.append(state); }
        resume.onclick = async () => {
          invalidate(); const current = epoch;
          try {
            const retained = await window.companion['idea-resume']({ operation: proposal.operation }); if (current !== epoch) return;
            origin = { conversationId: retained.input.conversationId, requestId: retained.input.requestId };
            fillEditor(retained.input, retained.references, retained.input.referenceIds); showPreview(retained);
            byId('idea-status').textContent = retained.blocked ? 'Proposed content retained. Context changed; review a new preview before confirmation.' : retained.acknowledgement ? 'Saved note already published. Confirm explicitly to acknowledge it and finish local staging cleanup. Supporting-context eligibility remains separate.' : retained.cleanup ? 'Saved note already published. Confirm explicitly to finish local staging cleanup.' : 'Proposed content restored. Confirm explicitly to retry the save.';
          } catch (error) { if (current === epoch) byId('idea-status').textContent = error.message; }
        };
        article.append(title, resume); pendingView.append(article);
      }
      supportStatus.textContent = 'Current support inspected. Warnings do not change note ownership or independently verify claims.';
    } catch (error) {
      if (current()) {
        supportStatus.textContent = `Support inspection unavailable: ${error.message}`;
        byId('idea-status').textContent = error.message;
      }
    }
  }
  window.addEventListener('companion-idea-draft', async event => {
    invalidate(); const current = epoch; origin = event.detail; byId('idea-status').textContent = '';
    try {
      const draft = await window.companion['idea-draft'](origin); if (current !== epoch) return;
      fillEditor(draft, draft.references);
      const warning = document.createElement('p'); warning.textContent = (draft.warnings || []).join('\n'); references.append(warning);
      byId('idea-title').focus();
    } catch (error) { if (current === epoch) byId('idea-status').textContent = error.message; }
  });
  byId('idea-preview-button').onclick = async () => {
    invalidate(); const current = epoch; byId('idea-status').textContent = '';
    try {
      const preview = await window.companion['idea-preview']({ ...origin, title: byId('idea-title').value, explanation: byId('idea-explanation').value, limitations: byId('idea-limitations').value, kind: kind.value, experiment: Object.fromEntries(experimentFields.map(([key]) => [key, byId(`idea-experiment-${key}`).value])), referenceIds: [...references.querySelectorAll('input:checked')].map(checkbox => checkbox.value) });
      if (current !== epoch) return;
      showPreview(preview);
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
  refreshSupport.onclick = () => list();
  document.getElementById('configure').addEventListener('click', () => { vaultEpoch++; listEpoch++; initialSupportPending = true; refreshSupport.disabled = true; byId('saved-ideas').replaceChildren(); pendingView.replaceChildren(); supportStatus.textContent = ''; });
  function inspectInitialSupport(event) {
    if (configurationBusy || event?.detail && event.detail.configurationEpoch !== configurationEpoch) return;
    refreshSupport.disabled = false;
    if (!initialSupportPending) return;
    initialSupportPending = false; list();
  }
  // Support inspection can reconcile intake. Start it only after the real base
  // refresh (including repairs) succeeds, rather than competing with startup.
  window.addEventListener('companion-base-refreshed', inspectInitialSupport);
  for (const [id, event] of [['conversation-new', 'click'], ['conversation-select', 'change']]) document.getElementById(id).addEventListener(event, () => { listEpoch++; supportStatus.textContent = ''; });
  if (byId('timezone').textContent) inspectInitialSupport();
})();
