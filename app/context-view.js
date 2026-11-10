(() => {
  const byId = id => document.getElementById(id);
  const conversation = document.createElement('section'); conversation.id = 'conversation-section'; conversation.setAttribute('aria-label', 'Project conversations');
  conversation.innerHTML = '<h2>Project conversations</h2><p id="conversation-location"></p><label for="conversation-select">Retained conversation</label><select id="conversation-select"><option value="">New conversation</option></select><button id="conversation-new">New conversation</button><label>Conversation brief version<input id="conversation-brief" type="number" min="1" value="1"></label><label><input id="conversation-speculation" type="checkbox">Allow beyond-evidence speculation</label><button id="conversation-preview">Preview conversation</button><label>Reviewed conversation package<textarea id="conversation-package" rows="14" readonly></textarea></label><p id="conversation-summary"></p><button id="conversation-send" disabled>Send reviewed package</button><p id="conversation-error" role="alert"></p><div id="conversation-history"></div>';
  byId('context-section').after(conversation);
  const priorSearch = document.createElement('section'); priorSearch.setAttribute('aria-label', 'Prior conversation search');
  priorSearch.innerHTML = '<h3>Prior conversation search</h3><p>Optional for this request. Search uses the context question and local text matches. Dialogue is prior discussion, not independent evidence. Different wording can be missed.</p><button id="history-search">Search prior conversations</button><p id="history-search-status"></p><div id="history-search-results"></div><div id="history-selected"></div>';
  byId('conversation-preview').before(priorSearch);
  const historySelections = new Map();
  let conversationId = null, conversationToken = null, conversationGeneration = 0;
  let viewEpoch = 0, draftMode = false;
  const retained = new Map();
  let renderedChoices = '';
  let displayedHistory = '';
  let historyExclusions = [];
  const excludedHistory = new Set();
  const restoredSources = new Set(), restoredHistory = new Set();
  const historyRevision = record => JSON.stringify({ requests: record.requests, storageWarning: record.storageWarning });
  const invalidateConversation = () => { conversationGeneration++; conversationToken = null; byId('conversation-send').disabled = true; byId('conversation-package').value = ''; byId('conversation-summary').textContent = 'Preview required. Review the current question, history and sources before sending.'; };
  function choices() {
    const select = byId('conversation-select');
    const options = [['', 'New conversation'], ...[...retained.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(record => [record.id, `${record.requests[0]?.question.slice(0, 80) || 'Conversation'} · brief ${record.brief.version} · ${record.id.slice(0, 8)}`])];
    const revision = JSON.stringify(options);
    if (revision !== renderedChoices) {
      renderedChoices = revision;
      select.replaceChildren(...options.map(([id, label]) => { const option = document.createElement('option'); option.value = id; option.textContent = label; return option; }));
    }
    if (select.value !== (conversationId || '')) select.value = conversationId || '';
  }
  function resetView() {
    retireFind(); viewEpoch++; conversationId = null; draftMode = true; displayedHistory = ''; historyExclusions = [];
    excludedHistory.clear(); restoredHistory.clear(); restoredSources.clear(); excluded.clear(); selections = []; all = [];
    historySelections.clear(); byId('history-search-results').replaceChildren(); byId('history-selected').replaceChildren(); byId('history-search-status').textContent = '';
    byId('conversation-history').replaceChildren(); byId('conversation-error').textContent = '';
    byId('conversation-brief').disabled = false; byId('conversation-brief').value = '1';
    byId('conversation-speculation').checked = false; byId('context-question').value = '';
    byId('context-results').replaceChildren(); byId('context-manual').replaceChildren(); byId('context-notes').replaceChildren(); byId('context-error').textContent = '';
    selected(); clearPreview(); choices();
  }
  byId('conversation-new').onclick = resetView;
  byId('conversation-select').onchange = () => {
    const record = retained.get(byId('conversation-select').value);
    resetView(); if (record) showConversation(record);
  };
  function warnHistory() {
    for (const warning of byId('conversation-history').querySelectorAll('.history-exclusion')) warning.remove();
    for (const article of byId('conversation-history').children) {
      const excluded = historyExclusions.find(item => item.id === article.dataset.requestId);
      if (excluded) { const warning = document.createElement('p'); warning.className = 'history-exclusion'; warning.textContent = `Excluded from next request preview: ${excluded.reason}. Historical text remains locally inspectable.`; article.prepend(warning); }
    }
  }
  function showConversation(record) {
    const firstDisplay = !displayedHistory;
    const revision = historyRevision(record);
    if (revision !== displayedHistory) { invalidateConversation(); displayedHistory = revision; }
    conversationId = record.id; draftMode = false; retained.set(record.id, record); choices();
    byId('conversation-brief').value = record.brief.version; byId('conversation-brief').disabled = true;
    if (firstDisplay) {
      historyExclusions = record.requests.at(-1)?.package?.historyExclusions || [];
      const scope = record.scope || { excludedSources: [], excludedHistory: record.requests.at(-1)?.package?.excludedHistory || [] };
      // A delayed initial read must not undo explicit controls already changed in this window.
      for (const key of scope.excludedSources) if (!restoredSources.has(key)) excluded.add(key);
      for (const id of scope.excludedHistory) if (!restoredHistory.has(id)) excludedHistory.add(id);
    }
    byId('conversation-error').textContent = record.storageWarning || '';
    byId('conversation-history').replaceChildren();
    for (const request of record.requests) {
      const article = document.createElement('article'), state = document.createElement('p'), question = document.createElement('pre'), reply = document.createElement('pre');
      article.dataset.requestId = request.id;
      state.textContent = `${request.status}${request.status === 'completed' ? '' : ' — incomplete'} · ${request.evidence || 'provider evidence unavailable'} · ${request.id}${request.error ? ` · ${request.error}` : ''}`;
      question.textContent = request.question; reply.textContent = request.reply; article.append(state, question, reply); byId('conversation-history').append(article);
      if (request.reply) {
        const draft = document.createElement('button'); draft.textContent = 'Draft saved idea';
        draft.onclick = () => window.dispatchEvent(new CustomEvent('companion-idea-draft', { detail: { conversationId: record.id, requestId: request.id } }));
        article.append(draft);
      }
      const includeLabel = document.createElement('label'), include = document.createElement('input');
      include.type = 'checkbox'; include.checked = request.status === 'completed' && !excludedHistory.has(request.id); include.disabled = request.status !== 'completed';
      includeLabel.append(include, document.createTextNode('Include request in next context'));
      include.onchange = () => { if (include.checked) { excludedHistory.delete(request.id); restoredHistory.add(request.id); } else { excludedHistory.add(request.id); restoredHistory.delete(request.id); } invalidateConversation(); };
      const contextDetails = document.createElement('details'), contextTitle = document.createElement('summary'), contextLabel = document.createElement('label'), contextText = document.createElement('textarea');
      contextTitle.textContent = 'Inspect approved context'; contextLabel.textContent = 'Saved approved context'; contextText.readOnly = true; contextText.rows = 8; contextText.value = request.package?.text || 'Saved context is unavailable.';
      contextLabel.append(contextText); contextDetails.append(contextTitle, contextLabel); article.append(includeLabel, contextDetails);
      if (request.status === 'failed' || request.status === 'interrupted') {
        const retry = document.createElement('button'); retry.textContent = 'Retry or edit request';
        retry.onclick = () => {
          retireFind(); byId('context-question').value = request.question; byId('conversation-speculation').checked = request.speculation === true;
          selections = []; restoredSources.clear(); selected(); clearPreview();
          byId('conversation-summary').textContent = 'Explicit retry: inspect and select current sources, then preview and send a new request. Earlier partial output stays incomplete.';
        }; article.append(retry);
      }
    }
    if (record.storageWarning) {
      const save = document.createElement('button'); save.textContent = 'Save retained reply locally';
      save.onclick = async () => {
        const epoch = viewEpoch;
        save.disabled = true; invalidateConversation();
        try { const saved = await window.companion['conversation-preserve']({ id: record.id }); if (epoch === viewEpoch) showConversation(saved); }
        catch (error) { if (epoch === viewEpoch) byId('conversation-error').textContent = error.message; }
        finally { save.disabled = false; }
      };
      byId('conversation-history').prepend(save);
    }
    warnHistory();
  }
  async function restoreConversation() {
    const request = conversationGeneration, epoch = viewEpoch;
    try {
      const state = await window.companion['conversation-list'](); if (request !== conversationGeneration || epoch !== viewEpoch) return;
      byId('conversation-location').textContent = `Local conversation history: ${state.location}. No vault notes are created automatically.`;
      retained.clear(); for (const record of state.conversations) retained.set(record.id, record); choices();
      const record = state.conversations.find(item => item.id === conversationId) || (!draftMode && state.conversations.at(-1));
      if (record && historyRevision(record) !== displayedHistory) showConversation(record);
    }
    catch (error) { if (request === conversationGeneration && epoch === viewEpoch) byId('conversation-error').textContent = error.message; }
  }
  let selections = [], all = [], generation = 0, findGeneration = 0;
  const excluded = new Set();
  const findFeedback = document.createElement('p');
  findFeedback.setAttribute('aria-live', 'polite'); byId('context-find').after(findFeedback);
  function retireFind() {
    findGeneration++; all = [];
    byId('context-results').replaceChildren(); byId('context-manual').replaceChildren();
    byId('context-manual').disabled = true; byId('context-add-manual').disabled = true;
    findFeedback.textContent = '';
  }
  retireFind();
  const clearPreview = () => { generation++; invalidateConversation(); byId('context-package').value = ''; byId('context-summary').textContent = 'Preview required. No model request is made.'; };
  const run = async work => { try { byId('context-error').textContent = ''; await work(); } catch (error) { clearPreview(); byId('context-error').textContent = error.message; } };
  const dependentOn = (item, key) => [item.associated, ...(item.associatedIds || [])].some(id => `capture:${id}` === key) || item.projectVersion !== undefined && `brief:${item.projectVersion}` === key;
  function revoke(item) { delete item.approval; delete item.approvedText; delete item.approvalLabel; }
  function add(source) {
    if (source) { restoredSources.add(source.key); if (excluded.delete(source.key)) for (const item of selections) if (dependentOn(item, source.key)) revoke(item); selections = selections.filter(item => item.key !== source.key); selections.push({ ...source }); }
    selected(); clearPreview();
  }
  function selected() {
    byId('context-selected').replaceChildren();
    for (const source of selections) {
      const article = document.createElement('article'), title = document.createElement('p'), remove = document.createElement('button');
      title.textContent = source.title; remove.textContent = 'Remove from context';
      remove.onclick = () => { excluded.add(source.key); restoredSources.delete(source.key); selections = selections.filter(item => item.key !== source.key); for (const item of selections) if (dependentOn(item, source.key)) revoke(item); selected(); clearPreview(); };
      const label = document.createElement('label'), editor = document.createElement('textarea'), approve = document.createElement('button'), proposed = document.createElement('pre'), state = document.createElement('p');
      label.textContent = 'Shorter passage'; editor.rows = 4; editor.value = source.approvedText || source.text; label.append(editor);
      const proposal = () => { proposed.textContent = `${source.provenance}; ${source.approvalLabel || 'Explicitly shortened passage'}\n${editor.value}`; };
      proposal(); state.textContent = source.approval ? 'Shortening approved. Preview the complete package.' : 'Inspect the exact proposed outgoing selection, then approve it to use it in the package.';
      editor.oninput = () => { delete source.approval; delete source.approvedText; delete source.approvalLabel; state.textContent = 'Shortening needs explicit approval.'; proposal(); clearPreview(); };
      approve.textContent = 'Approve shorter passage'; approve.onclick = () => run(async () => {
        const approved = await window.companion['context-shorten']({ key: source.key, digest: source.digest, sourceGenerations: source.sourceGenerations, text: editor.value });
        source.approval = approved.approval; source.approvedText = approved.text; source.approvalLabel = 'Explicitly shortened passage'; state.textContent = 'Shortening approved. Preview the complete package.'; clearPreview();
      });
      const full = document.createElement('button'); full.textContent = 'Use full source'; full.onclick = () => { delete source.approval; delete source.approvedText; delete source.approvalLabel; selected(); clearPreview(); };
      article.append(title, remove, label, proposed, state, approve, full); byId('context-selected').append(article);
    }
  }
  async function find() {
    retireFind(); clearPreview();
    const request = findGeneration, epoch = viewEpoch, question = byId('context-question').value;
    const current = () => request === findGeneration && epoch === viewEpoch && question === byId('context-question').value;
    byId('context-error').textContent = ''; byId('context-notes').replaceChildren();
    findFeedback.textContent = 'Finding context\u2026';
    try {
      const result = await window.companion['context-find']({ question });
      if (!current()) return;
      all = result.all;
      byId('context-error').textContent = result.issues.join('\n');
      for (const note of result.included) {
        const row = document.createElement('p'), remove = document.createElement('button'); row.textContent = note.file; remove.textContent = 'Exclude note';
        remove.onclick = () => run(async () => { await window.companion['context-exclude'](note.key); selections = selections.filter(source => source.key !== note.key); selected(); await find(); }); row.append(remove); byId('context-notes').append(row);
      }
      for (const source of all) { const option = document.createElement('option'); option.value = source.key; option.textContent = source.title; byId('context-manual').append(option); }
      for (const source of result.matches) {
        const article = document.createElement('article'), title = document.createElement('h3'), reason = document.createElement('p'), passage = document.createElement('pre'), button = document.createElement('button');
        title.textContent = source.title; reason.textContent = `${source.reason}; ${source.provenance}`; passage.textContent = source.text; button.textContent = 'Add to context';
        button.onclick = () => { if (current()) add(source); }; article.append(title, reason);
        for (const match of source.passages || []) {
          const row = document.createElement('div'), anchor = document.createElement('p'), excerpt = document.createElement('pre'), choose = document.createElement('button'); row.className = 'context-passage';
          anchor.textContent = `Matching passage lines ${match.start}-${match.end}; Text match: ${match.matched.join(', ')}; source sha256 ${source.digest}`; excerpt.textContent = match.text; choose.textContent = 'Add passage';
          choose.onclick = () => run(async () => { if (!current()) return; const approved = await window.companion['context-passage']({ key: source.key, digest: source.digest, sourceGenerations: source.sourceGenerations, start: match.start, end: match.end }); add({ ...source, approval: approved.approval, approvedText: approved.text, approvalLabel: approved.label }); });
          row.append(anchor, excerpt, choose); article.append(row);
        }
        const full = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Inspect full eligible source'; full.append(summary, passage); article.append(full, button); byId('context-results').append(article);
      }
      if (!result.matches.length) byId('context-results').textContent = 'No Relevant Context. Try another search or add a source manually. Local text matching can miss differently worded relevant material.';
      findFeedback.textContent = 'Context search complete.';
    } catch (error) {
      if (!current()) return;
      byId('context-error').textContent = error.message;
      findFeedback.textContent = 'Context search failed. Try Find context again.';
    } finally {
      if (current()) {
        byId('context-manual').disabled = !all.length;
        byId('context-add-manual').disabled = !all.length;
      }
    }
  }
  byId('context-find').onclick = find;
  byId('context-include').onclick = () => run(async () => { await window.companion['context-include'](); await find(); });
  byId('context-add-manual').onclick = () => { if (!byId('context-add-manual').disabled) add(all.find(source => source.key === byId('context-manual').value)); };
  byId('context-question').oninput = () => { retireFind(); clearPreview(); };
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
      const preview = await window.companion['context-preview']({ question: byId('context-question').value, excludedSources: [...excluded], selections: selections.map(({key,digest,approval,sourceGenerations}) => ({key,digest,...(sourceGenerations ? {sourceGenerations} : {}),...(approval ? {approval} : {})})) });
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
  const conversationInput = () => ({ conversationId, briefVersion: Number(byId('conversation-brief').value), question: byId('context-question').value, speculation: byId('conversation-speculation').checked, excludedHistory: [...excludedHistory], restoreHistory: [...restoredHistory], excludedSources: [...excluded], restoreSources: [...restoredSources], selections: selections.map(({key,digest,approval,sourceGenerations}) => ({key,digest,...(sourceGenerations ? {sourceGenerations} : {}),...(approval ? {approval} : {})})), historySelections: [...historySelections.values()].map(({conversationId,requestId,digest}) => ({conversationId,requestId,digest})) });
  function selectedHistory() {
    byId('history-selected').replaceChildren();
    for (const [key, item] of historySelections) {
      const row = document.createElement('p'), remove = document.createElement('button');
      row.textContent = `Selected historical dialogue: ${item.conversationId}/${item.requestId} · approved brief version ${item.brief.version}. `;
      remove.textContent = 'Remove historical dialogue';
      remove.onclick = () => { historySelections.delete(key); selectedHistory(); invalidateConversation(); };
      row.append(remove); byId('history-selected').append(row);
    }
  }
  byId('history-search').onclick = async () => {
    invalidateConversation(); const version = conversationGeneration;
    byId('history-search-results').replaceChildren(); byId('history-search-status').textContent = 'Searching prior dialogue…';
    try {
      const result = await window.companion['conversation-search'](conversationInput());
      if (version !== conversationGeneration) return;
      byId('history-search-status').textContent = `${result.matches.length} matching historical turns. ${result.matches.length ? '' : 'Local text matching can miss differently worded dialogue. '}${result.warnings.join(' ')}`;
      for (const item of result.matches) {
        const article = document.createElement('article'), provenance = document.createElement('p'), text = document.createElement('pre'), add = document.createElement('button');
        provenance.textContent = `Historical dialogue · conversation ${item.conversationId} · request ${item.requestId} · origin sha256 ${item.digest} · approved brief ${item.brief.id}, version ${item.brief.version}, sha256 ${item.brief.digest} · Text match: ${item.matched.join(', ')}. Source dependency closure: ${JSON.stringify(item.dependencies)}`;
        text.textContent = `User: ${item.question}\nAssistant: ${item.reply}`; add.textContent = 'Add historical dialogue';
        add.onclick = () => { historySelections.set(`${item.conversationId}:${item.requestId}`, item); selectedHistory(); invalidateConversation(); };
        article.append(provenance, text, add); byId('history-search-results').append(article);
      }
    } catch (error) { if (version === conversationGeneration) byId('history-search-status').textContent = error.message; }
  };
  byId('conversation-preview').onclick = async () => {
    invalidateConversation(); const version = conversationGeneration; byId('conversation-error').textContent = '';
    try {
      const preview = await window.companion['conversation-preview'](conversationInput());
      if (version !== conversationGeneration) return;
      // A completed restore is one reviewed action, not permission to undo future exclusions.
      restoredSources.clear(); restoredHistory.clear();
      conversationToken = preview.packageId; byId('conversation-package').value = preview.text;
      historyExclusions = preview.historyExclusions; warnHistory();
      byId('conversation-summary').textContent = `${preview.count} / ${preview.limit} Unicode code points. ${preview.blocked ? 'Oversized. Remove or explicitly shorten sources.' : 'Within limit.'} ${conversationId ? 'Reviewed exclusion scope saved locally. ' : ''}${preview.boundEvidence} ${preview.warnings.join(' ')}`;
      byId('conversation-send').disabled = preview.blocked;
    } catch (error) { if (version === conversationGeneration) byId('conversation-error').textContent = error.message; }
  };
  byId('conversation-send').onclick = async () => {
    const packageId = conversationToken, epoch = viewEpoch; invalidateConversation();
    try { const record = await window.companion['conversation-send']({ packageId }); if (epoch === viewEpoch) showConversation(record); }
    catch (error) { if (epoch === viewEpoch) byId('conversation-error').textContent = error.message; }
  };
  restoreConversation();
  setInterval(restoreConversation, 300);
})();
