const archivePreview = document.getElementById('archive-preview');
const archiveExport = document.getElementById('archive-export');
const archiveSummary = document.getElementById('archive-summary');
let archiveReview;
archivePreview.onclick = async () => {
  archiveReview = null; archiveExport.disabled = true; archivePreview.disabled = true;
  try {
    const review = await window.companion['archive-preview'](); archiveReview = review.id;
    archiveSummary.textContent = `Application data: ${review.location}. ${review.count} conversation${review.count === 1 ? '' : 's'}; ${review.vaults} vault binding${review.vaults === 1 ? '' : 's'}. Includes complete saved history, defined settings and vault matching hints. Excludes credentials, provider setup and vault contents. Schedule intent requires explicit reconnection. This file contains private conversation text. Review before saving.`;
    archiveExport.disabled = false;
  } catch (error) { archiveSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archivePreview.disabled = false; }
};
archiveExport.onclick = async () => {
  const id = archiveReview; archiveReview = null; archiveExport.disabled = true; archivePreview.disabled = true;
  try { const result = await window.companion['archive-export']({ id }); archiveSummary.textContent = result.cancelled ? 'Export cancelled. Preview again to export.' : `Archive exported: ${result.location}. Keep a separate vault backup. Imported history never proves current Codex readiness.`; }
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
const archiveCadence = document.getElementById('archive-cadence');
const archiveReconnectPreview = document.getElementById('archive-reconnect-preview');
const archiveReconnectConfirm = document.getElementById('archive-reconnect');
const archiveReconnectSummary = document.getElementById('archive-reconnect-summary');
let archiveReconnectToken;
let archiveInspection, archiveRestoreToken, archiveMissing = 0;
function invalidateRestore() { archiveRestoreToken = null; archiveRestore.disabled = true; archiveConflicts.replaceChildren(); archiveNotes.replaceChildren(); }
function restoreChoices() { return [...archiveConflicts.querySelectorAll('select')].map(select => ({ id: select.dataset.conversationId, choice: select.value })); }
function selectedArchiveNotes() { return [...archiveNotes.querySelectorAll('input:checked')].map(input => input.dataset.noteFile); }
function updateRestoreConfirmation() { archiveRestore.disabled = !archiveRestoreToken || archiveMissing === 0 && selectedArchiveNotes().length === 0 || restoreChoices().some(resolution => resolution.choice !== 'keep-current'); }
archiveMatch.onchange = () => { invalidateRestore(); archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection || !archiveSource.value; };
archiveSource.onchange = () => { archiveMatch.checked = false; invalidateRestore(); archiveMatchPreview.disabled = true; };
archiveSettings.onchange = () => { invalidateRestore(); archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection || !archiveSource.value; };
archiveInspect.onclick = async () => {
  archiveInspection = null; invalidateRestore(); archiveMatch.checked = false; archiveSettings.value = 'keep-current'; archiveMatchPreview.disabled = true; archiveInspect.disabled = true;
  try {
    const result = await window.companion['archive-inspect']();
    if (result.cancelled) { archiveRestoreSummary.textContent = 'Inspection cancelled. Nothing was restored.'; return; }
    archiveInspection = result.id;
    archiveSource.replaceChildren();
    for (const root of ['', ...result.roots]) { const option = document.createElement('option'); option.value = root; option.textContent = root || 'Choose an archived vault'; archiveSource.append(option); }
    archiveSource.value = result.roots.includes(result.currentVault) ? result.currentVault : '';
    archiveRestoreSummary.textContent = `Integrity and version validated. ${result.missing} missing conversation${result.missing === 1 ? '' : 's'}, ${result.equal} equal, ${result.conflicts} conflicting. Archive vault hints: ${result.roots.join('; ') || 'None'}. Current vault: ${result.currentVault || 'None selected'}. Paths and matching content do not prove vault identity. Current settings and source exclusions remain authoritative. Restore adds only reviewed missing conversations; it does not restore vault files, replace settings or connect a scheduled task. Explicit vault matching is required.`;
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveInspect.disabled = false; }
};
archiveMatchPreview.onclick = async () => {
  invalidateRestore(); archiveMatchPreview.disabled = true;
  try {
    const result = await window.companion['archive-match']({ id: archiveInspection, matched: archiveMatch.checked, sourceRoot: archiveSource.value, settingsMode: archiveSettings.value });
    archiveRestoreToken = result.token; archiveMissing = result.missing;
    archiveRestoreSummary.textContent = `Matched restore preview: ${result.missing} missing conversation${result.missing === 1 ? '' : 's'}, ${result.equal} equal, ${result.conflicts} conflicting. Missing history may have been deleted intentionally. Confirm only if you want to add these archived conversations. Current settings and source exclusions remain authoritative. Existing history and vault files stay unchanged. Exact retained brief pins match; original external documents may be unavailable or outdated. Historical restore does not refresh them. Schedule intent remains inactive; task reconnection is separate. Historic packages, capacity bindings and provider IDs do not prove current eligibility or readiness.`;
    archiveRestoreSummary.textContent += ` Current vault configuration is kept: ${result.currentVault.vault}; managed folder ${result.currentVault.managedRoot}. Archived hints: ${result.archivedVault.vault || 'unavailable'}; managed folder ${result.archivedVault.managedRoot}. Use Choose vault to change configuration. Note inclusions change only for individually checked current text below; conversation exclusions remain authoritative.`;
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
    await showArchiveIntents();
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); archiveInspection = null; }
  finally { archiveInspect.disabled = false; }
};
async function showArchiveIntents() {
  try {
    const result = await window.companion['archive-state']();
    archiveIntentSummary.textContent = result.inactiveIntents.length ? `Imported daily intake intent is inactive. ${result.inactiveIntents.map(record => `Requested ${record.intent.mode}; anchor ${record.intent.anchor}; original vault ${record.sourceRoot}; matched vault ${record.targetRoot}.`).join(' ')} Explicit scheduled-task reconnection is required. Startup does not run imported cadence.` : 'No imported daily intake intent.';
    const previous = archiveCadence.value; archiveCadence.replaceChildren();
    for (const record of [null, ...result.inactiveIntents]) { const option = document.createElement('option'); option.value = record?.archiveId || ''; option.textContent = record ? `${record.archiveId}: ${record.intent.mode}; ${record.intent.anchor}; ${record.targetRoot}` : 'Choose an imported cadence'; archiveCadence.append(option); }
    if ([...archiveCadence.options].some(option => option.value === previous)) archiveCadence.value = previous;
  } catch (error) { archiveIntentSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
}
archiveCadence.onchange = () => { archiveReconnectToken = null; archiveReconnectConfirm.disabled = true; archiveReconnectSummary.textContent = 'Preview the selected imported cadence before connecting it.'; };
archiveReconnectPreview.onclick = async () => {
  archiveReconnectToken = null; archiveReconnectConfirm.disabled = true; archiveReconnectPreview.disabled = true;
  try {
    const result = await window.companion['archive-reconnect-preview']({ archiveId: archiveCadence.value });
    if (result.alreadyConnected) { archiveReconnectSummary.textContent = 'This imported cadence is already connected. The existing local task was inspected; no duplicate was created.'; return; }
    archiveReconnectToken = result.token;
    archiveReconnectSummary.textContent = `Original anchor: ${result.anchor}. Requested mode: ${result.mode}. A fresh local task identity will be used; an unfinished reconnection reuses its already reserved local identity. No missed checks run during reconnection. Historical due slots are skipped explicitly; later checks keep this anchor. Current vault sources require their own connection review. Only confirm if this current vault and cadence are intended. This does not authenticate Codex or submit model requests.`;
    archiveReconnectConfirm.disabled = false;
  } catch (error) { archiveReconnectSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveReconnectPreview.disabled = false; }
};
archiveReconnectConfirm.onclick = async () => {
  const token = archiveReconnectToken; archiveReconnectToken = null; archiveReconnectConfirm.disabled = true; archiveReconnectPreview.disabled = true;
  try { const result = await window.companion['archive-reconnect']({ token }); archiveReconnectSummary.textContent = `Imported daily intake connected. Original anchor: ${result.anchor}. Current local schedule: ${result.id}. No historical missed checks were run.`; }
  catch (error) { archiveReconnectSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveReconnectPreview.disabled = false; }
};
showArchiveIntents();
