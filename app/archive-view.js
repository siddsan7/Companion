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
let archiveInspection, archiveRestoreToken;
function invalidateRestore() { archiveRestoreToken = null; archiveRestore.disabled = true; }
archiveMatch.onchange = () => { invalidateRestore(); archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection; };
archiveInspect.onclick = async () => {
  archiveInspection = null; invalidateRestore(); archiveMatch.checked = false; archiveMatchPreview.disabled = true; archiveInspect.disabled = true;
  try {
    const result = await window.companion['archive-inspect']();
    if (result.cancelled) { archiveRestoreSummary.textContent = 'Inspection cancelled. Nothing was restored.'; return; }
    archiveInspection = result.id;
    archiveRestoreSummary.textContent = `Integrity and version validated. ${result.missing} missing conversation${result.missing === 1 ? '' : 's'}, ${result.equal} equal, ${result.conflicts} conflicting. Archive vault hints: ${result.roots.join('; ') || 'None'}. Current vault: ${result.currentVault || 'None selected'}. Paths and matching content do not prove vault identity. Current settings and source exclusions remain authoritative. Restore adds only reviewed missing conversations; it does not restore vault files, replace settings or connect a scheduled task. Explicit vault matching is required.`;
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveInspect.disabled = false; }
};
archiveMatchPreview.onclick = async () => {
  invalidateRestore(); archiveMatchPreview.disabled = true;
  try {
    const result = await window.companion['archive-match']({ id: archiveInspection, matched: archiveMatch.checked });
    archiveRestoreToken = result.token;
    archiveRestoreSummary.textContent = `Matched restore preview: ${result.missing} missing conversation${result.missing === 1 ? '' : 's'}, ${result.equal} equal, ${result.conflicts} conflicting. Missing history may have been deleted intentionally. Confirm only if you want to add these archived conversations. Current settings and source exclusions remain authoritative. Existing history and vault files stay unchanged. Schedule intent remains inactive; task reconnection is separate. Historic packages, capacity bindings and provider IDs do not prove current eligibility or readiness.`;
    archiveRestore.disabled = result.conflicts > 0 || result.missing === 0;
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
  finally { archiveMatchPreview.disabled = !archiveMatch.checked || !archiveInspection; }
};
archiveRestore.onclick = async () => {
  const token = archiveRestoreToken; invalidateRestore(); archiveMatchPreview.disabled = true; archiveInspect.disabled = true;
  try {
    const result = await window.companion['archive-restore']({ token }); archiveInspection = null; archiveMatch.checked = false;
    archiveRestoreSummary.textContent = `Restored ${result.restored} conversation${result.restored === 1 ? '' : 's'}. ${result.equal} equal records left unchanged. No task was connected. Reopen a retained conversation to inspect its exact historical context; a new turn requires current review.`;
  } catch (error) { archiveRestoreSummary.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); archiveInspection = null; }
  finally { archiveInspect.disabled = false; }
};
