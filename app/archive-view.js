const archivePreview = document.getElementById('archive-preview');
const archiveExport = document.getElementById('archive-export');
const archiveSummary = document.getElementById('archive-summary');
const archiveSavedOnly = document.getElementById('archive-saved-only');
const archivePendingReview = document.getElementById('archive-pending-review');
const archivePendingDetails = document.getElementById('archive-pending-details');
let archiveRecoveryReview;
let archiveReview;
archivePreview.onclick = async () => {
  archiveReview = null; archiveExport.disabled = true; archivePreview.disabled = true;
  try {
    const review = await window.companion['archive-preview']({ savedOnly: archiveSavedOnly.checked, recoveryId: archiveRecoveryReview }); archiveReview = review.id;
    archiveSummary.textContent = `Application data: ${review.location}. ${review.count} conversation${review.count === 1 ? '' : 's'}; ${review.vaults} vault binding${review.vaults === 1 ? '' : 's'}. Includes complete saved history, defined settings and vault matching hints. Codex path and sandbox preferences are inert reconnect hints only. Excludes credentials, provider permissions and vault contents. Schedule intent requires explicit reconnection. This file contains private conversation text. Review before saving.`;
    if (review.omitted) archiveSummary.textContent += ` Incomplete archive: ${review.omitted} unresolved files omitted. Their only copies may remain in the local history folder shown below. Preserve those files separately; this export is not a complete history backup.`;
    archiveExport.disabled = false;
  } catch (error) { archiveSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archivePreview.disabled = false; }
};
archiveSavedOnly.onchange = () => { archiveReview = null; archiveExport.disabled = true; archiveSummary.textContent = 'Export scope changed. Preview the archive again.'; };
archivePendingReview.onclick = async () => {
  archiveRecoveryReview = null; archiveSavedOnly.checked = false; archiveSavedOnly.disabled = true; archiveReview = null; archiveExport.disabled = true; archivePendingDetails.replaceChildren(); archivePendingReview.disabled = true;
  try {
    const result = await window.companion['archive-review-pending'](); archiveRecoveryReview = result.id;
    const warning = document.createElement('p'); warning.textContent = `${result.records.length} unresolved files remain preserved at ${result.location}. Copy these preserved files separately before closing or moving this installation. Some may contain the only copy of a reply. Complete export stays blocked; the optional saved-history-only archive omits these bytes and records only inert names, lengths and digests. Nothing is promoted or deleted.`; archivePendingDetails.append(warning);
    for (const record of result.records) {
      const row = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `${record.kind === 'validated-conversation' ? 'Validated pending conversation' : 'Unknown recovery data'}: ${record.name}; ${record.bytes} bytes; SHA256 ${record.sha256}`; row.append(summary);
      if (record.text !== undefined) { const text = document.createElement('pre'); text.textContent = record.text; row.append(text); }
      archivePendingDetails.append(row);
    }
    archiveSavedOnly.disabled = result.records.length === 0;
  } catch (error) { archivePendingDetails.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archivePendingReview.disabled = false; }
};
archiveExport.onclick = async () => {
  const id = archiveReview; archiveReview = null; archiveExport.disabled = true; archivePreview.disabled = true;
  try { const result = await window.companion['archive-export']({ id }); archiveSummary.textContent = result.cancelled ? 'Export cancelled. Preview again to export.' : `Archive exported: ${result.location}. ${result.omitted ? `Incomplete archive: ${result.omitted} unresolved files omitted; preserve those only copies separately. ` : ''}Keep a separate vault backup. Imported history never proves current Codex readiness.`; }
  catch (error) { archiveSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archivePreview.disabled = false; }
};
const archiveInspect = document.getElementById('archive-inspect');
const archiveMatch = document.getElementById('archive-match');
const archiveMatchPreview = document.getElementById('archive-match-preview');
const archiveRestore = document.getElementById('archive-restore');
const archiveRestoreSummary = document.getElementById('archive-restore-summary');
const archiveConflicts = document.getElementById('archive-conflicts');
const archiveSource = document.getElementById('archive-source');
const archiveSettings = document.getElementById('archive-settings');
const archiveNotes = document.getElementById('archive-notes');
const archiveIntentSummary = document.getElementById('archive-intents');
const archiveCodexHintSummary = document.getElementById('archive-codex-hints');
const archiveCadence = document.getElementById('archive-cadence');
const archiveReconnectPreview = document.getElementById('archive-reconnect-preview');
const archiveReconnectConfirm = document.getElementById('archive-reconnect');
const archiveReconnectSummary = document.getElementById('archive-reconnect-summary');
let archiveReconnectToken, archiveReconnectEpoch = 0;
let archiveInspection, archiveRestoreToken, archiveMissing = 0, archiveMetadata = 0, archiveMetadataConflicts = 0;
function invalidateRestore() { archiveRestoreToken = null; archiveRestore.disabled = true; archiveConflicts.replaceChildren(); archiveNotes.replaceChildren(); }
function restoreChoices() { return [...archiveConflicts.querySelectorAll('select')].map(select => ({ id: select.dataset.conversationId, choice: select.value })); }
function selectedArchiveNotes() { return [...archiveNotes.querySelectorAll('input:checked')].map(input => input.dataset.noteFile); }
function updateRestoreConfirmation() { archiveRestore.disabled = !archiveRestoreToken || archiveMissing === 0 && selectedArchiveNotes().length === 0 && archiveMetadata === 0 || archiveMetadataConflicts > 0 || restoreChoices().some(resolution => resolution.choice !== 'keep-current'); }
function updateArchiveMatchControls() {
  for (const control of [archiveMatch, archiveSource, archiveSettings]) control.disabled = !archiveInspection;
  archiveMatchPreview.disabled = !archiveInspection || !archiveMatch.checked || !archiveSource.value;
}
updateArchiveMatchControls();
archiveMatch.onchange = () => { invalidateRestore(); archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection || !archiveSource.value; };
archiveSource.onchange = () => { archiveMatch.checked = false; invalidateRestore(); archiveMatchPreview.disabled = true; };
archiveSettings.onchange = () => { invalidateRestore(); archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection || !archiveSource.value; };
archiveInspect.onclick = async () => {
  archiveInspection = null; invalidateRestore(); archiveMatch.checked = false; archiveSettings.value = 'keep-current'; archiveMatchPreview.disabled = true; archiveInspect.disabled = true;
  updateArchiveMatchControls();
  try {
    const result = await window.companion['archive-inspect']();
    if (result.cancelled) { archiveRestoreSummary.textContent = 'Inspection cancelled. Nothing was restored.'; return; }
    archiveInspection = result.id;
    archiveSource.replaceChildren();
    for (const root of ['', ...result.roots]) { const option = document.createElement('option'); option.value = root; option.textContent = root || 'Choose an archived vault'; archiveSource.append(option); }
    archiveSource.value = result.roots.includes(result.currentVault) ? result.currentVault : '';
    archiveRestoreSummary.textContent = `Integrity and version validated. ${result.missing} missing conversation${result.missing === 1 ? '' : 's'}, ${result.equal} equal, ${result.conflicts} conflicting. Archive vault hints: ${result.roots.join('; ') || 'None'}. Current vault: ${result.currentVault || 'None selected'}. Paths and matching content do not prove vault identity. Current settings and source exclusions remain authoritative. Restore adds only reviewed missing conversations; it does not restore vault files, replace settings or connect a scheduled task. Explicit vault matching is required.`;
    if (result.omitted) archiveRestoreSummary.textContent += ` Incomplete archive: ${result.omitted} unresolved files omitted. Omission metadata is inert and cannot restore their missing content.`;
    showCodexHints(result.codexHints);
  } catch (error) { archiveInspection = null; archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveMatch.checked = false; archiveInspect.disabled = false; updateArchiveMatchControls(); }
};
archiveMatchPreview.onclick = async () => {
  invalidateRestore(); archiveMatchPreview.disabled = true;
  try {
    const result = await window.companion['archive-match']({ id: archiveInspection, matched: archiveMatch.checked, sourceRoot: archiveSource.value, settingsMode: archiveSettings.value });
    archiveRestoreToken = result.token; archiveMissing = result.missing; archiveMetadata = result.metadataAdditions; archiveMetadataConflicts = result.metadataConflicts;
    archiveRestoreSummary.textContent = `Matched restore preview: ${result.missing} missing conversation${result.missing === 1 ? '' : 's'}, ${result.equal} equal, ${result.conflicts} conflicting. Missing history may have been deleted intentionally. Confirm only if you want to add these archived conversations. Current settings and source exclusions remain authoritative. Existing history and vault files stay unchanged. Exact retained brief pins match; original external documents may be unavailable or outdated. Historical restore does not refresh them. Schedule intent remains inactive; task reconnection is separate. Historic packages, capacity bindings and provider IDs do not prove current eligibility or readiness.`;
    if (result.newGenerations) archiveRestoreSummary.textContent += ` ${result.newGenerations} previously deleted or generation-bound identities will receive a fresh local generation and scope version. Current retained source and history exclusions are added to the archive scope; older archives cannot remove them. Fresh explicit context review is required to change those exclusions.`;
    archiveRestoreSummary.textContent += ` Current vault configuration is kept: ${result.currentVault.vault}; managed folder ${result.currentVault.managedRoot}. Archived hints: ${result.archivedVault.vault || 'unavailable'}; managed folder ${result.archivedVault.managedRoot}. Use Choose vault to change configuration. Note inclusions change only for individually checked current text below; conversation exclusions remain authoritative.`;
    archiveRestoreSummary.textContent += ` ${result.metadataAdditions} inert settings records to preserve: ${result.metadataTypes.cadence} cadence intents, ${result.metadataTypes.codexHints} Codex reconnect hints, ${result.metadataTypes.coverage} incomplete-archive coverage records. ${result.missing === 0 ? 'No conversations will be added; current settings stay active. ' : ''}This confirmation only preserves those inactive records; task or Codex reconnection requires its separate explicit workflow. ${result.metadataConflicts} inert metadata conflicts; conflicts block restore and existing records are kept.`;
    if (result.omitted) archiveRestoreSummary.textContent += ` Incomplete archive: ${result.omitted} unresolved files omitted. Their recovery content cannot be restored from this archive.`;
    for (const conflict of result.conflictRecords) {
      const row = document.createElement('div'), details = document.createElement('p'), label = document.createElement('label'), select = document.createElement('select');
      details.textContent = `Conversation ${conflict.id}: current ${conflict.currentRequests} requests and ${conflict.currentExclusions} omitted requests; archive ${conflict.archivedRequests} requests and ${conflict.archivedExclusions} omitted requests. Keep current preserves all current text and source scope. This restore adds missing history and keeps existing conflicts; it does not overwrite or merge them.`;
      label.textContent = `Conflict resolution for conversation ${conflict.id}`; select.dataset.conversationId = conflict.id;
      select.id = `archive-conflict-${conflict.id}`; label.htmlFor = select.id;
      for (const [value, text] of [['', 'Choose a resolution'], ['keep-current', 'Keep current']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
      select.onchange = updateRestoreConfirmation; row.append(details, label, select); archiveConflicts.append(row);
    }
    for (const [index, candidate] of result.noteCandidates.entries()) {
      const row = document.createElement('div');
      if (candidate.unavailable) row.textContent = `Archived note unavailable: ${candidate.original}. ${candidate.reason} Nothing will be included.`;
      else {
        const label = document.createElement('label'), input = document.createElement('input'), details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('pre');
        input.type = 'checkbox'; input.id = `archive-note-${index}`; input.dataset.noteFile = candidate.file;
        label.htmlFor = input.id; label.textContent = `Restore note inclusion ${candidate.file}`;
        summary.textContent = `Review exact current note text; SHA256 ${candidate.digest}`; text.textContent = candidate.text; details.append(summary, text);
        input.onchange = updateRestoreConfirmation; row.append(label, input, details);
      }
      archiveNotes.append(row);
    }
    updateRestoreConfirmation();
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection || !archiveSource.value; }
};
archiveRestore.onclick = async () => {
  const token = archiveRestoreToken, resolutions = restoreChoices(), noteFiles = selectedArchiveNotes(); invalidateRestore(); archiveMatchPreview.disabled = true; archiveInspect.disabled = true;
  try {
    const result = await window.companion['archive-restore']({ token, resolutions, noteFiles }); archiveInspection = null; archiveMatch.checked = false;
    archiveRestoreSummary.textContent = `Restored ${result.restored} conversation${result.restored === 1 ? '' : 's'}. ${result.equal} equal records left unchanged. No task was connected. Reopen a retained conversation to inspect its exact historical context; a new turn requires current review.`;
    if (result.restoredNotes) archiveRestoreSummary.textContent += ` Restored ${result.restoredNotes} reviewed note inclusion${result.restoredNotes === 1 ? '' : 's'}. Existing conversation exclusions remain unchanged.`;
    if (result.preservedMetadata) archiveRestoreSummary.textContent += ` Preserved ${result.preservedMetadata} inert settings records. Active settings and task/provider connections were not changed.`;
    await showArchiveIntents();
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); archiveInspection = null; }
  finally { archiveInspect.disabled = false; updateArchiveMatchControls(); }
};
async function showArchiveIntents() {
  try {
    const result = await window.companion['archive-state']();
    archiveIntentSummary.textContent = result.inactiveIntents.length ? `Imported daily intake intent is inactive. ${result.inactiveIntents.map(record => `Requested ${record.intent.mode}; anchor ${record.intent.anchor}; original vault ${record.sourceRoot}; matched vault ${record.targetRoot}.`).join(' ')} Explicit scheduled-task reconnection is required. Startup does not run imported cadence.` : 'No imported daily intake intent.';
    const previous = archiveCadence.value; archiveCadence.replaceChildren();
    for (const record of [null, ...result.inactiveIntents]) {
      const option = document.createElement('option');
      option.value = record ? JSON.stringify({ archiveId: record.archiveId, sourceRoot: record.sourceRoot, targetRoot: record.targetRoot }) : '';
      option.textContent = record ? `${record.archiveId}: ${record.intent.mode}; ${record.intent.anchor}; matched vault ${record.targetRoot}; original vault ${record.sourceRoot}` : 'Choose an imported cadence';
      archiveCadence.append(option);
    }
    if ([...archiveCadence.options].some(option => option.value === previous)) archiveCadence.value = previous;
    else invalidateCadenceReview();
    showCodexHints(result.codexHints);
  } catch (error) { archiveIntentSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
}
function showCodexHints(records) {
  archiveCodexHintSummary.textContent = records.length ? `Archived Codex preferences are inert reconnection hints. ${records.map(record => `Archive ${record.archiveId}: executable ${record.preferences.executable}; project ${record.preferences.project}; former vault ${record.preferences.vault}; requested sandbox ${record.preferences.sandbox}.`).join(' ')} Reapproval is required in the existing Check Codex setup workflow. No imported path, sandbox permission, authentication, readiness or connection is applied.` : 'No archived Codex reconnection hints.';
}
function invalidateCadenceReview() {
  archiveReconnectEpoch++;
  archiveReconnectToken = null;
  archiveReconnectConfirm.disabled = true;
  archiveReconnectSummary.textContent = 'Preview the selected imported cadence before connecting it.';
}
archiveCadence.onchange = invalidateCadenceReview;
archiveReconnectPreview.onclick = async () => {
  archiveReconnectToken = null; archiveReconnectConfirm.disabled = true; archiveReconnectPreview.disabled = true;
  const request = ++archiveReconnectEpoch, choice = archiveCadence.value;
  const current = () => request === archiveReconnectEpoch && choice === archiveCadence.value;
  try {
    const result = await window.companion['archive-reconnect-preview'](choice ? JSON.parse(choice) : null);
    if (!current()) return;
    if (result.alreadyConnected) { archiveReconnectSummary.textContent = `This imported cadence is already connected to ${result.targetRoot}. The existing local task was inspected; no duplicate was created.`; return; }
    archiveReconnectToken = result.token;
    archiveReconnectSummary.textContent = `Matched vault: ${result.targetRoot}. Original vault: ${result.sourceRoot}. Original anchor: ${result.anchor}. Requested mode: ${result.mode}. A fresh local task identity will be used; an unfinished reconnection reuses its already reserved local identity. No missed checks run during reconnection. Historical due slots are skipped explicitly; later checks keep this anchor. Current vault sources require their own connection review. Only confirm if this current vault and cadence are intended. This does not authenticate Codex or submit model requests.`;
    archiveReconnectConfirm.disabled = false;
  } catch (error) { if (current()) archiveReconnectSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveReconnectPreview.disabled = false; }
};
archiveReconnectConfirm.onclick = async () => {
  const token = archiveReconnectToken;
  if (!token) return;
  archiveReconnectToken = null; archiveReconnectConfirm.disabled = true; archiveReconnectPreview.disabled = true; archiveCadence.disabled = true;
  try { const result = await window.companion['archive-reconnect']({ token }); archiveReconnectSummary.textContent = `Imported daily intake connected. Matched vault: ${result.targetRoot}. Original vault: ${result.sourceRoot}. Original anchor: ${result.anchor}. Current local schedule: ${result.id}. No historical missed checks were run.`; }
  catch (error) { archiveReconnectSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveCadence.disabled = false; archiveReconnectPreview.disabled = false; window.dispatchEvent(new Event('companion-schedule-changed')); }
};
showArchiveIntents();

// Interrupted restorations use their exact locally reserved manifest, never an old provider thread.
const restorationRecovery = document.createElement('section'); restorationRecovery.setAttribute('aria-label', 'Pending history restorations');
restorationRecovery.innerHTML = '<h3>Pending history restorations</h3><p>Inspect retained history and its exact manifest. Nothing is promoted or removed automatically.</p><div id="archive-recovery-pending"></div><section id="archive-recovery-review" aria-label="History restoration recovery review" hidden><p id="archive-recovery-description"></p><label>Retained restoration record<textarea id="archive-recovery-record" rows="12" readonly></textarea></label><button id="archive-recovery-confirm">Confirm history restoration recovery</button><button id="archive-recovery-cancel">Cancel history restoration recovery</button></section>';
document.querySelector('section[aria-label="Local history archive"]').append(restorationRecovery);
let restorationRecoveryToken, restorationRecoveryEpoch = 0, restorationPendingEpoch = 0;
function invalidateRestorationRecovery() {
  restorationRecoveryEpoch++; const previous = restorationRecoveryToken; restorationRecoveryToken = null;
  document.getElementById('archive-recovery-review').hidden = true; document.getElementById('archive-recovery-record').value = '';
  document.getElementById('archive-recovery-confirm').disabled = false;
  if (previous) window.companion['conversation-delete-cancel']({ token: previous }).catch(() => {});
}
async function refreshRestorationRecovery() {
  const request = ++restorationPendingEpoch;
  try {
    const result = await window.companion['archive-recovery-pending'](); if (request !== restorationPendingEpoch) return;
    const list = document.getElementById('archive-recovery-pending'); list.replaceChildren();
    for (const issue of result.issues) { const row = document.createElement('p'); row.textContent = issue; list.append(row); }
    for (const record of result.records) {
      const article = document.createElement('article'), description = document.createElement('p'), details = document.createElement('details'), summary = document.createElement('summary'), label = document.createElement('label'), text = document.createElement('textarea'), resume = document.createElement('button');
      description.textContent = `${record.id} · generation ${record.generation} · archive ${record.archiveId} · exact manifest: ${record.targets.join(', ')}. ${record.warning || 'Retained history awaits explicit restoration recovery.'}`;
      summary.textContent = 'Inspect retained restoration'; label.textContent = 'Retained pending restoration record'; text.readOnly = true; text.rows = 10; text.value = record.text; label.append(text); details.append(summary, label);
      resume.textContent = 'Resume history restoration'; resume.disabled = !record.canResume;
      resume.onclick = async () => {
        if (request !== restorationPendingEpoch) return;
        invalidateRestorationRecovery(); const current = restorationRecoveryEpoch; resume.disabled = true;
        try {
          const result = await window.companion['archive-recovery-resume']({ id: record.id });
          if (current !== restorationRecoveryEpoch) { await window.companion['conversation-delete-cancel']({ token: result.token }); return; }
          restorationRecoveryToken = result.token;
          document.getElementById('archive-recovery-description').textContent = `Recover only ${result.id}, generation ${result.generation}, from archive ${result.archiveId}. Exact retained targets: ${result.targets.join(', ')}. Current exclusions remain. No source authority, provider request, missing payload or independent writing is reconstructed.`;
          document.getElementById('archive-recovery-record').value = result.text; document.getElementById('archive-recovery-review').hidden = false;
        } catch (error) { if (current === restorationRecoveryEpoch) archiveRestoreSummary.textContent = error.message; }
        finally { if (current === restorationRecoveryEpoch) resume.disabled = !record.canResume; }
      };
      article.append(description, details, resume); list.append(article);
    }
  } catch (error) { if (request === restorationPendingEpoch) document.getElementById('archive-recovery-pending').textContent = error.message; }
}
document.getElementById('archive-recovery-confirm').onclick = async () => {
  const current = restorationRecoveryEpoch, approved = restorationRecoveryToken; document.getElementById('archive-recovery-confirm').disabled = true;
  try {
    const result = await window.companion['archive-recovery-confirm']({ token: approved });
    if (current !== restorationRecoveryEpoch) return;
    restorationRecoveryToken = null; document.getElementById('archive-recovery-review').hidden = true;
    archiveRestoreSummary.textContent = `Restoration recovered locally: ${result.id}, generation ${result.generation}. Original retained writing and current exclusions remain; no request was replayed.`;
  } catch (error) { if (current === restorationRecoveryEpoch) archiveRestoreSummary.textContent = error.message; }
  finally { if (current === restorationRecoveryEpoch) document.getElementById('archive-recovery-confirm').disabled = false; await refreshRestorationRecovery(); }
};
document.getElementById('archive-recovery-cancel').onclick = invalidateRestorationRecovery;
for (const [id, event] of [['conversation-new', 'click'], ['conversation-select', 'change']]) document.getElementById(id).addEventListener(event, invalidateRestorationRecovery);
document.getElementById('configure').addEventListener('click', () => { invalidateCadenceReview(); restorationPendingEpoch++; invalidateRestorationRecovery(); document.getElementById('archive-recovery-pending').replaceChildren(); });
window.addEventListener('companion-vault-configured', () => refreshRestorationRecovery());
refreshRestorationRecovery();
