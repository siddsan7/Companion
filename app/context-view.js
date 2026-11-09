(() => {
  const byId = id => document.getElementById(id);
  const conversation = document.createElement('section'); conversation.id = 'conversation-section'; conversation.setAttribute('aria-label', 'Project conversations');
  conversation.innerHTML = '<h2>Project conversations</h2><p id="conversation-location"></p><label>Conversation brief version<input id="conversation-brief" type="number" min="1" value="1"></label><label><input id="conversation-speculation" type="checkbox">Allow beyond-evidence speculation</label><button id="conversation-preview">Preview conversation</button><label>Reviewed conversation package<textarea id="conversation-package" rows="14" readonly></textarea></label><p id="conversation-summary"></p><button id="conversation-send" disabled>Send reviewed package</button><p id="conversation-error" role="alert"></p><div id="conversation-history"></div>';
  byId('context-section').after(conversation);
  let conversationId = null, conversationToken = null, conversationGeneration = 0;
  let displayedHistory = '';
  let historyExclusions = [];
  const invalidateConversation = () => { conversationGeneration++; conversationToken = null; byId('conversation-send').disabled = true; byId('conversation-package').value = ''; };
  function warnHistory() {
    for (const warning of byId('conversation-history').querySelectorAll('.history-exclusion')) warning.remove();
    for (const article of byId('conversation-history').children) {
      const excluded = historyExclusions.find(item => item.id === article.dataset.requestId);
      if (excluded) { const warning = document.createElement('p'); warning.className = 'history-exclusion'; warning.textContent = `Excluded from next request preview: ${excluded.reason}. Historical text remains locally inspectable.`; article.prepend(warning); }
    }
  }
  function showConversation(record) {
    const firstDisplay = !displayedHistory;
    const revision = JSON.stringify(record.requests);
    if (revision !== displayedHistory) { invalidateConversation(); displayedHistory = revision; }
    conversationId = record.id; byId('conversation-brief').value = record.brief.version; byId('conversation-brief').disabled = true;
    if (firstDisplay) historyExclusions = record.requests.at(-1)?.package?.historyExclusions || [];
    byId('conversation-error').textContent = record.storageWarning || '';
    byId('conversation-history').replaceChildren();
    for (const request of record.requests) {
      const article = document.createElement('article'), state = document.createElement('p'), question = document.createElement('pre'), reply = document.createElement('pre');
      article.dataset.requestId = request.id;
      state.textContent = `${request.status}${request.status === 'completed' ? '' : ' — incomplete'} · ${request.evidence || 'provider evidence unavailable'} · ${request.id}${request.error ? ` · ${request.error}` : ''}`;
      question.textContent = request.question; reply.textContent = request.reply; article.append(state, question, reply); byId('conversation-history').append(article);
      if (request.status === 'failed' || request.status === 'interrupted') {
        const retry = document.createElement('button'); retry.textContent = 'Retry or edit request';
        retry.onclick = () => {
          byId('context-question').value = request.question; byId('conversation-speculation').checked = request.speculation === true;
          selections = []; excluded.clear(); selected(); clearPreview();
          byId('conversation-summary').textContent = 'Explicit retry: inspect and select current sources, then preview and send a new request. Earlier partial output stays incomplete.';
        }; article.append(retry);
      }
    }
    warnHistory();
  }
  async function restoreConversation() {
    try { const state = await window.companion['conversation-list'](); byId('conversation-location').textContent = `Local conversation history: ${state.location}. No vault notes are created automatically.`; const record = state.conversations.find(item => item.id === conversationId) || state.conversations.at(-1); if (record && JSON.stringify(record.requests) !== displayedHistory) showConversation(record); }
    catch (error) { byId('conversation-error').textContent = error.message; }
  }
  let selections = [], all = [], generation = 0; const excluded = new Set();
  const clearPreview = () => { generation++; invalidateConversation(); byId('context-package').value = ''; byId('context-summary').textContent = 'Preview required. No model request is made.'; };
  const run = async work => { try { byId('context-error').textContent = ''; await work(); } catch (error) { clearPreview(); byId('context-error').textContent = error.message; } };
  const dependentOn = (item, key) => [item.associated, ...(item.associatedIds || [])].some(id => `capture:${id}` === key) || item.projectVersion !== undefined && `brief:${item.projectVersion}` === key;
  function revoke(item) { delete item.approval; delete item.approvedText; delete item.approvalLabel; }
  function add(source) {
    if (source) { if (excluded.delete(source.key)) for (const item of selections) if (dependentOn(item, source.key)) revoke(item); selections = selections.filter(item => item.key !== source.key); selections.push({ ...source }); }
    selected(); clearPreview();
  }
  function selected() {
    byId('context-selected').replaceChildren();
    for (const source of selections) {
      const article = document.createElement('article'), title = document.createElement('p'), remove = document.createElement('button');
      title.textContent = source.title; remove.textContent = 'Remove from context';
      remove.onclick = () => { excluded.add(source.key); selections = selections.filter(item => item.key !== source.key); for (const item of selections) if (dependentOn(item, source.key)) revoke(item); selected(); clearPreview(); };
      const label = document.createElement('label'), editor = document.createElement('textarea'), approve = document.createElement('button'), proposed = document.createElement('pre'), state = document.createElement('p');
      label.textContent = 'Shorter passage'; editor.rows = 4; editor.value = source.approvedText || source.text; label.append(editor);
      const proposal = () => { proposed.textContent = `${source.provenance}; ${source.approvalLabel || 'Explicitly shortened passage'}\n${editor.value}`; };
      proposal(); state.textContent = source.approval ? 'Shortening approved. Preview the complete package.' : 'Inspect the exact proposed outgoing selection, then approve it to use it in the package.';
      editor.oninput = () => { delete source.approval; delete source.approvedText; delete source.approvalLabel; state.textContent = 'Shortening needs explicit approval.'; proposal(); clearPreview(); };
      approve.textContent = 'Approve shorter passage'; approve.onclick = () => run(async () => {
        const approved = await window.companion['context-shorten']({ key: source.key, digest: source.digest, text: editor.value });
        source.approval = approved.approval; source.approvedText = approved.text; source.approvalLabel = 'Explicitly shortened passage'; state.textContent = 'Shortening approved. Preview the complete package.'; clearPreview();
      });
      const full = document.createElement('button'); full.textContent = 'Use full source'; full.onclick = () => { delete source.approval; delete source.approvedText; delete source.approvalLabel; selected(); clearPreview(); };
      article.append(title, remove, label, proposed, state, approve, full); byId('context-selected').append(article);
    }
  }
  async function find() {
    clearPreview(); const result = await window.companion['context-find']({ question: byId('context-question').value }); all = result.all;
    byId('context-results').replaceChildren(); byId('context-manual').replaceChildren(); byId('context-notes').replaceChildren();
    byId('context-error').textContent = result.issues.join('\n');
    for (const note of result.included) {
      const row = document.createElement('p'), remove = document.createElement('button'); row.textContent = note.file; remove.textContent = 'Exclude note';
      remove.onclick = () => run(async () => { await window.companion['context-exclude'](note.key); selections = selections.filter(source => source.key !== note.key); selected(); await find(); }); row.append(remove); byId('context-notes').append(row);
    }
    for (const source of all) { const option = document.createElement('option'); option.value = source.key; option.textContent = source.title; byId('context-manual').append(option); }
    for (const source of result.matches) {
      const article = document.createElement('article'), title = document.createElement('h3'), reason = document.createElement('p'), passage = document.createElement('pre'), button = document.createElement('button');
      title.textContent = source.title; reason.textContent = `${source.reason}; ${source.provenance}`; passage.textContent = source.text; button.textContent = 'Add to context';
      button.onclick = () => add(source); article.append(title, reason);
      for (const match of source.passages || []) {
        const row = document.createElement('div'), anchor = document.createElement('p'), excerpt = document.createElement('pre'), choose = document.createElement('button'); row.className = 'context-passage';
        anchor.textContent = `Matching passage lines ${match.start}-${match.end}; Text match: ${match.matched.join(', ')}; source sha256 ${source.digest}`; excerpt.textContent = match.text; choose.textContent = 'Add passage';
        choose.onclick = () => run(async () => { const approved = await window.companion['context-passage']({ key: source.key, digest: source.digest, start: match.start, end: match.end }); add({ ...source, approval: approved.approval, approvedText: approved.text, approvalLabel: approved.label }); });
        row.append(anchor, excerpt, choose); article.append(row);
      }
      const full = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Inspect full eligible source'; full.append(summary, passage); article.append(full, button); byId('context-results').append(article);
    }
    if (!result.matches.length) byId('context-results').textContent = 'No Relevant Context. Try another search or add a source manually. Local text matching can miss differently worded relevant material.';
  }
  byId('context-find').onclick = () => run(find);
  byId('context-include').onclick = () => run(async () => { await window.companion['context-include'](); await find(); });
  byId('context-add-manual').onclick = () => add(all.find(source => source.key === byId('context-manual').value));
  byId('context-question').oninput = clearPreview;
  byId('context-preview').onclick = async () => {
    clearPreview(); const request = generation; byId('context-error').textContent = '';
    const outdated = () => {
      if (request === generation) return false;
      const summary = byId('context-summary');
      if (!byId('context-package').value) summary.textContent = 'Earlier preview ignored. Preview the current controls.';
      else if (!summary.textContent.includes('Earlier preview ignored')) summary.textContent += ' Earlier preview ignored.';
      return true;
    };
    try {
      const preview = await window.companion['context-preview']({ question: byId('context-question').value, excludedSources: [...excluded], selections: selections.map(({key,digest,approval}) => ({key,digest,...(approval ? {approval} : {})})) });
      if (outdated()) return;
      byId('context-package').value = preview.text;
      byId('context-summary').textContent = `${preview.count} / ${preview.limit} Unicode code points. ${preview.blocked ? 'Oversized: remove sources or explicitly shorten a selection.' : 'Within limit'} · Application cap: 32000. Serialized line endings: LF. ${preview.boundEvidence} Local preview only; chat readiness is separate. ${(preview.warnings || []).join(' ')}`;
    } catch (error) {
      if (outdated()) return;
      clearPreview(); byId('context-error').textContent = error.message;
    }
  };
  byId('conversation-brief').oninput = invalidateConversation;
  byId('conversation-speculation').onchange = invalidateConversation;
  byId('conversation-preview').onclick = async () => {
    invalidateConversation(); const version = conversationGeneration; byId('conversation-error').textContent = '';
    try {
      const preview = await window.companion['conversation-preview']({ conversationId, briefVersion: Number(byId('conversation-brief').value), question: byId('context-question').value, speculation: byId('conversation-speculation').checked, excludedSources: [...excluded], selections: selections.map(({key,digest,approval}) => ({key,digest,...(approval ? {approval} : {})})) });
      if (version !== conversationGeneration) return;
      conversationToken = preview.packageId; byId('conversation-package').value = preview.text;
      historyExclusions = preview.historyExclusions; warnHistory();
      byId('conversation-summary').textContent = `${preview.count} / ${preview.limit} Unicode code points. ${preview.blocked ? 'Oversized. Remove or explicitly shorten sources.' : 'Within limit.'} ${preview.boundEvidence} ${preview.warnings.join(' ')}`;
      byId('conversation-send').disabled = preview.blocked;
    } catch (error) { if (version === conversationGeneration) byId('conversation-error').textContent = error.message; }
  };
  byId('conversation-send').onclick = async () => {
    const packageId = conversationToken; invalidateConversation();
    try { showConversation(await window.companion['conversation-send']({ packageId })); }
    catch (error) { byId('conversation-error').textContent = error.message; }
  };
  restoreConversation();
  setInterval(restoreConversation, 300);
})();
