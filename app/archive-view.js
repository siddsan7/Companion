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
