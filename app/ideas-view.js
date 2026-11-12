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
  const removalPreview = document.createElement('section'), removalFiles = document.createElement('div'), removalWarnings = document.createElement('p');
  const removalHeading = document.createElement('h3'), removalConfirm = document.createElement('button'), removalCancel = document.createElement('button');
  removalPreview.setAttribute('aria-label', 'Saved idea removal preview'); removalPreview.hidden = true;
  removalConfirm.textContent = 'Confirm saved idea removal'; removalCancel.textContent = 'Cancel saved idea removal';
  removalPreview.append(removalHeading, removalFiles, removalWarnings, removalConfirm, removalCancel); section.append(removalPreview);
  const removalRecovery = document.createElement('div'); removalRecovery.id = 'idea-removal-recovery'; section.append(removalRecovery);
  const editorControls = document.createElement('fieldset');
  Object.assign(editorControls.style, { border: '0', padding: '0', margin: '0', minWidth: '0' });
  editorControls.append(...byId('idea-editor').childNodes); byId('idea-editor').append(editorControls);
  let origin = null, operation = null, epoch = 0, listEpoch = 0, vaultEpoch = 0, initialSupportPending = true;
  let editorLoad = null, confirmation = null;
  let removalOperation = null, removalEpoch = 0;
  function closeRemoval() { removalEpoch++; removalOperation = null; removalPreview.hidden = true; }
  function showRemoval(preview) {
    removalOperation = preview.operation; removalHeading.textContent = `Remove saved idea ${preview.id}`;
    removalFiles.replaceChildren();
    for (const file of preview.files) {
      const line = document.createElement('p'); line.textContent = `${file.kind}: ${file.path}`; removalFiles.append(line);
      const writing = preview.writing.find(item => item.path === file.path && item.kind === file.kind);
      if (writing) {
        const body = document.createElement('pre'); body.textContent = writing.text;
        Object.assign(body.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }); removalFiles.append(body);
      }
    }
    removalWarnings.textContent = preview.warnings.join(' '); removalPreview.hidden = false;
  }
  async function previewRemoval(id) {
    closeRemoval(); const attempt = removalEpoch, selectedVault = vaultEpoch;
    try {
      const preview = await window.companion['idea-removal-preview']({ id });
      if (attempt === removalEpoch && selectedVault === vaultEpoch) showRemoval(preview);
    } catch (error) { if (attempt === removalEpoch && selectedVault === vaultEpoch) byId('idea-status').textContent = error.message; }
  }
  removalCancel.onclick = async () => {
    const approved = removalOperation; closeRemoval();
    if (approved) try { await window.companion['idea-removal-cancel']({ operation: approved }); } catch (error) { byId('idea-status').textContent = error.message; }
  };
  removalConfirm.onclick = async () => {
    const approved = removalOperation, current = removalEpoch, owner = vaultEpoch; if (!approved) return;
    removalConfirm.disabled = true;
    try {
      await window.companion['idea-removal-confirm']({ operation: approved });
      if (current !== removalEpoch || owner !== vaultEpoch) return;
      closeRemoval(); byId('idea-status').textContent = 'Saved idea removal complete. The displayed managed copies were removed; originating conversations and other writing were retained.';
      await list();
    } catch (error) {
      if (current === removalEpoch && owner === vaultEpoch) {
        closeRemoval(); byId('idea-status').textContent = `Saved idea removal held. ${error.message}`; await list();
      }
    } finally { removalConfirm.disabled = false; }
  };
  async function listRemovals(current) {
    const pending = await window.companion['idea-removal-pending'](); if (!current()) return;
    removalRecovery.replaceChildren();
    for (const removal of pending) {
      const article = document.createElement('article'), heading = document.createElement('h3'), warning = document.createElement('p');
      heading.textContent = `Confirmed saved idea removal ${removal.id}`; warning.textContent = removal.warnings.join(' '); article.append(heading, warning);
      for (const file of removal.files) { const line = document.createElement('p'); line.textContent = `${file.kind}: ${file.path}`; article.append(line); }
      if (!removal.held) {
        const recover = document.createElement('button'); recover.textContent = 'Recover confirmed saved idea removal';
        recover.onclick = async () => {
          recover.disabled = true;
          try {
            await window.companion['idea-removal-resume']({ id: removal.id }); if (!current()) return;
            byId('idea-status').textContent = 'Saved idea removal complete. Only the confirmed managed scope was removed.'; await list();
          } catch (error) { if (current()) { byId('idea-status').textContent = `Saved idea removal held. ${error.message}`; await list(); } }
          finally { recover.disabled = false; }
        }; article.append(recover);
      }
      removalRecovery.append(article);
    }
  }
  function updateConfirm() { byId('idea-confirm').disabled = !!confirmation || !operation; }
  const invalidate = () => { epoch++; operation = null; byId('idea-preview').hidden = true; updateConfirm(); };
  function beginEditorLoad() {
    invalidate(); editorLoad = { epoch, vaultEpoch }; editorControls.disabled = true; editorControls.setAttribute('aria-busy', 'true'); return editorLoad;
  }
  const ownsEditorLoad = owner => editorLoad === owner && owner.epoch === epoch && owner.vaultEpoch === vaultEpoch;
  function finishEditorLoad(owner) {
    if (editorLoad !== owner) return;
    editorLoad = null; editorControls.disabled = false; editorControls.removeAttribute('aria-busy');
  }
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
    byId('idea-warnings').textContent = preview.warnings.join('\n'); byId('idea-preview').hidden = false; updateConfirm();
  }
  async function list({ reportError = true } = {}) {
    const request = ++listEpoch, owner = vaultEpoch, view = epoch;
    const current = () => request === listEpoch && owner === vaultEpoch && view === epoch;
    supportStatus.textContent = 'Checking current saved idea support…';
    try {
      await listRemovals(current); if (!current()) return;
      const notes = await window.companion['idea-list'](); if (!current()) return;
      byId('saved-ideas').replaceChildren();
      for (const note of notes) {
        const article = document.createElement('article'), title = document.createElement('h3'), open = document.createElement('button');
        title.textContent = note.title; open.textContent = 'Open saved idea in Obsidian'; open.disabled = note.unavailable;
        open.onclick = async () => { try { await window.companion['idea-open'](note.id); } catch (error) { if (current()) byId('idea-status').textContent = error.message; } };
        article.append(title, open); byId('saved-ideas').append(article);
        const remove = document.createElement('button'); remove.textContent = 'Preview saved idea removal'; remove.disabled = note.unavailable;
        remove.onclick = () => previewRemoval(note.id); article.append(remove);
        if (note.repairLinks) {
          const repair = document.createElement('button'); repair.textContent = 'Repair saved idea links';
          repair.onclick = async () => {
            repair.disabled = true;
            try {
              const result = await window.companion['idea-repair-links'](note.id);
              if (owner === vaultEpoch) byId('idea-status').textContent = result.repaired ? 'Saved idea links repaired.' : 'No verified target moves need link repair.';
            } catch (error) { if (owner === vaultEpoch) byId('idea-status').textContent = error.message; }
            finally { repair.disabled = false; }
          };
          article.append(repair);
        }
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
        if (proposal.held) { const state = document.createElement('p'); state.textContent = 'Publication ownership is held. Resume to inspect the retained proposal.'; article.append(state); }
        else if (proposal.cleanup) { const state = document.createElement('p'); state.textContent = 'The note is already published. Resume to review and explicitly finish local staging cleanup.'; article.append(state); }
        else if (proposal.hasPublication) { const state = document.createElement('p'); state.textContent = 'The note is already published. Resume to acknowledge it and finish local staging cleanup.'; article.append(state); }
        resume.onclick = async () => {
          const owner = beginEditorLoad(); byId('idea-status').textContent = 'Loading retained proposal…';
          try {
            const retained = await window.companion['idea-resume']({ operation: proposal.operation }); if (!ownsEditorLoad(owner)) return;
            origin = { conversationId: retained.input.conversationId, requestId: retained.input.requestId };
            fillEditor(retained.input, retained.references, retained.input.referenceIds); showPreview(retained);
            byId('idea-status').textContent = retained.blocked ? 'Proposed content retained. Context changed; review a new preview before confirmation.' : retained.acknowledgement ? 'Saved note already published. Confirm explicitly to acknowledge it and finish local staging cleanup. Supporting-context eligibility remains separate.' : retained.cleanup ? 'Saved note already published. Confirm explicitly to finish local staging cleanup.' : 'Proposed content restored. Confirm explicitly to retry the save.';
          } catch (error) { if (ownsEditorLoad(owner)) byId('idea-status').textContent = error.message; }
          finally { finishEditorLoad(owner); }
        };
        const remove = document.createElement('button'); remove.textContent = 'Preview proposed idea removal';
        remove.onclick = () => previewRemoval(proposal.id);
        article.append(title, resume, remove); pendingView.append(article);
      }
      supportStatus.textContent = 'Current support inspected. Warnings do not change note ownership or independently verify claims.';
    } catch (error) {
      if (current()) {
        supportStatus.textContent = `Support inspection unavailable: ${error.message}`;
        if (reportError) byId('idea-status').textContent = error.message;
      }
    }
  }
  window.addEventListener('companion-idea-draft', async event => {
    const selectedOrigin = { ...event.detail }, owner = beginEditorLoad(); byId('idea-status').textContent = 'Loading selected reply…';
    try {
      const draft = await window.companion['idea-draft'](selectedOrigin); if (!ownsEditorLoad(owner)) return;
      origin = selectedOrigin;
      fillEditor(draft, draft.references);
      const warning = document.createElement('p'); warning.textContent = (draft.warnings || []).join('\n'); references.append(warning);
      byId('idea-status').textContent = ''; finishEditorLoad(owner); byId('idea-title').focus();
    } catch (error) { if (ownsEditorLoad(owner)) byId('idea-status').textContent = error.message; }
    finally { finishEditorLoad(owner); }
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
    const approved = operation; if (!approved || confirmation) return;
    const request = { editor: epoch, vault: vaultEpoch }, owns = () => request.editor === epoch && request.vault === vaultEpoch;
    confirmation = request; updateConfirm(); byId('idea-status').textContent = '';
    try {
      await window.companion['idea-confirm']({ operation: approved });
      if (!owns()) return;
      invalidate(); const completion = epoch;
      await list({ reportError: false });
      if (completion === epoch && request.vault === vaultEpoch) byId('idea-status').textContent = 'Saved idea. The independent Markdown note is available in the vault.';
    } catch (error) { if (owns()) byId('idea-status').textContent = `Save failed. Proposed content is retained. Retry confirmation explicitly. ${error.message}`; }
    finally { if (confirmation === request) { confirmation = null; updateConfirm(); } }
  };
  refreshSupport.onclick = () => list();
  document.getElementById('configure').addEventListener('click', () => { vaultEpoch++; listEpoch++; invalidate(); closeRemoval(); removalRecovery.replaceChildren(); editorLoad = null; editorControls.disabled = false; editorControls.removeAttribute('aria-busy'); initialSupportPending = true; refreshSupport.disabled = true; byId('saved-ideas').replaceChildren(); pendingView.replaceChildren(); supportStatus.textContent = ''; });
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
