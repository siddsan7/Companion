// Decision ledger and Revisit list (D41-D48). Every decision write is previewed first.
(() => {
  const api = window.decisions;
  const make = (tag, props = {}, children = []) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
  const field = (labelText, input) => { input.id ||= `decision-field-${Math.random().toString(36).slice(2)}`; const label = make('label', { htmlFor: input.id, textContent: labelText }); return [label, input]; };
  const clean = message => String(message).replace(/^Error invoking remote method '[^']+': Error: /, '');
  const say = message => { document.querySelector('[role=status]').textContent = message; };
  const run = async work => { try { await work(); } catch (error) { say(clean(error.message)); } };

  const section = make('section', { id: 'decision-section' });
  section.setAttribute('aria-label', 'Decisions and revisit notices');
  const heading = make('h2', { textContent: 'Decision ledger' });
  const intro = make('p', { textContent: 'Record technical decisions with what would make you reconsider them. New captures are matched locally against active revisit conditions; a separate gate decides whether a match meets the condition. Silence is the default.' });
  const noticeHeading = make('h3', { id: 'revisit-heading', textContent: 'Revisit notices' });
  const notices = make('div', { id: 'revisit-notices' });
  const runStatus = make('p', { id: 'revisit-run' }); runStatus.setAttribute('aria-live', 'polite');
  const checkNow = make('button', { textContent: 'Check decisions now' });
  const automatic = make('fieldset', { id: 'revisit-automatic' });
  const automaticStatement = make('p', { id: 'revisit-automatic-statement' });
  const cap = make('input', { id: 'revisit-cap', type: 'number', min: 1, max: 100, value: 10 });
  const enable = make('button', { textContent: 'Enable automatic revisit checks' });
  const disable = make('button', { textContent: 'Disable automatic revisit checks' });
  const gateStatus = make('p', { id: 'revisit-gate-status' });
  automatic.append(make('legend', { textContent: 'Automatic gate checks' }), automaticStatement, ...field('Automatic gate requests per check', cap), enable, disable, gateStatus);
  const pending = make('div', { id: 'revisit-pending' });
  const notRaised = make('div', { id: 'revisit-not-raised' });
  const inert = make('div', { id: 'revisit-inert' });
  const list = make('div', { id: 'decision-list' });
  const issues = make('p', { id: 'decision-issues' }); issues.setAttribute('role', 'note');
  const newDecision = make('button', { textContent: 'New decision' });

  // Editor
  const editor = make('div', { id: 'decision-editor', hidden: true });
  const title = make('input', { id: 'decision-title' }), project = make('input', { id: 'decision-project', value: 'MyTune' });
  const choice = make('textarea', { id: 'decision-choice', rows: 3 }), reasons = make('textarea', { id: 'decision-reasons', rows: 4 });
  const alternatives = make('textarea', { id: 'decision-alternatives', rows: 3 });
  const state = make('select', { id: 'decision-state' }), supersededBy = make('select', { id: 'decision-superseded-by' });
  for (const [value, text] of [['active', 'Active'], ['withdrawn', 'Withdrawn'], ['superseded', 'Superseded by another decision']]) state.append(make('option', { value, textContent: text }));
  const reliedOn = make('fieldset', { id: 'decision-relied-on' });
  const conditions = make('div', { id: 'decision-conditions' });
  const addEvidence = make('button', { textContent: 'Add evidence condition' }), addTime = make('button', { textContent: 'Add time condition' });
  const previewButton = make('button', { textContent: 'Preview decision version' }), cancelEdit = make('button', { textContent: 'Cancel decision edit' });
  const editorNote = make('p', { id: 'decision-editor-note' });
  editor.append(make('h3', { id: 'decision-editor-heading', textContent: 'New decision' }), editorNote,
    ...field('Decision title', title), ...field('Project', project), ...field('Choice made', choice),
    ...field('Reasons (one per line)', reasons), ...field('Alternatives rejected (one per line)', alternatives),
    ...field('Decision state', state), ...field('Superseded by', supersededBy),
    reliedOn, make('h4', { textContent: 'Revisit conditions' }), conditions, addEvidence, addTime, make('br'), previewButton, cancelEdit);

  // Preview
  const preview = make('section', { id: 'decision-preview', hidden: true });
  preview.setAttribute('aria-label', 'Decision version preview');
  const previewSummary = make('p', { id: 'decision-preview-summary' });
  const previewContent = make('textarea', { id: 'decision-preview-content', rows: 16, readOnly: true });
  const confirm = make('button', { textContent: 'Save decision version' }), cancelPreview = make('button', { textContent: 'Cancel decision preview' });
  preview.append(make('h3', { textContent: 'Preview' }), previewSummary, ...field('Proposed decision note', previewContent), confirm, cancelPreview);

  section.append(heading, intro, noticeHeading, notices, runStatus, checkNow, automatic,
    make('h3', { textContent: 'Waiting for the gate' }), pending,
    make('h3', { textContent: 'Checked, not raised' }), notRaised,
    make('h3', { textContent: 'Withdrawn and repeated candidates' }), inert,
    make('h3', { textContent: 'Decisions' }), issues, newDecision, list, editor, preview);
  (document.getElementById('ideas-section') || document.getElementById('brief-section')).after(section);
  const navLink = make('a', { href: '#decision-section', id: 'decision-nav', textContent: 'Decisions' });
  document.querySelector('nav[aria-label="Companion sections"]').append(' · ', navLink);

  let view = null, sources = [], editing = null, previewId = null, loadEpoch = 0;

  function sourceChoices(container, legend, chosen, name) {
    container.replaceChildren(make('legend', { textContent: legend }));
    if (!sources.length) container.append(make('p', { textContent: 'No eligible sources are available.' }));
    for (const source of sources) {
      const box = make('input', { type: 'checkbox', value: source.key, checked: chosen.has(source.key), name });
      box.dataset.digest = source.digest; box.dataset.title = source.title; box.dataset.revision = source.revisionId || '';
      container.append(make('label', {}, [box, `${source.title} (${source.key})`]));
    }
  }
  function conditionFields(input) {
    const index = conditions.children.length + 1, kind = input.kind;
    const box = make('fieldset', { className: 'decision-condition' });
    box.dataset.id = input.id || ''; box.dataset.kind = kind;
    const labelled = (text, element) => { element.setAttribute('aria-label', `Condition ${index} ${text}`); return make('label', {}, [`${text}`, element]); };
    const label = make('input', { value: input.label || '' }), trigger = make('textarea', { rows: 2, value: input.trigger || '' });
    const action = make('textarea', { rows: 2, value: input.action || '' });
    const condState = make('select');
    for (const value of ['active', 'met', 'withdrawn']) condState.append(make('option', { value, textContent: value }));
    condState.value = input.state || 'active';
    const remove = make('button', { textContent: `Remove condition ${index}` });
    remove.onclick = () => { box.remove(); };
    box.append(make('legend', { textContent: `Condition ${index} · ${kind === 'time' ? 'time-based' : 'evidence-based'}` }),
      labelled('label', label), labelled('trigger', trigger), labelled('action', action));
    if (kind === 'time') box.append(labelled('review by', make('input', { type: 'date', value: input.reviewBy || '', className: 'review-by' })));
    else {
      box.append(labelled('cue terms (comma separated)', make('input', { value: (input.cueTerms || []).join(', '), className: 'cue-terms' })));
      const links = make('fieldset', { className: 'condition-links' });
      sourceChoices(links, `Condition ${index} linked sources`, new Set(input.links || []), `links-${index}`);
      box.append(links);
    }
    box.append(labelled('state', condState), remove);
    Object.assign(box, { read: () => ({
      ...(box.dataset.id ? { id: box.dataset.id } : {}), kind, label: label.value, trigger: trigger.value, action: action.value, state: condState.value,
      ...(kind === 'time' ? { reviewBy: box.querySelector('.review-by').value } : {
        cueTerms: box.querySelector('.cue-terms').value.split(',').map(term => term.trim()).filter(Boolean),
        links: [...box.querySelectorAll('.condition-links input:checked')].map(item => item.value)
      })
    }) });
    conditions.append(box);
  }
  async function openEditor(decision, resolution) {
    sources = await api['decision-sources']();
    editing = { id: decision?.id || null, expectedVersion: decision?.latest.version || 0, resolution: resolution || null };
    const draft = decision?.draft || { title: '', project: 'MyTune', choice: '', reasons: [], alternatives: [], reliedOn: [], state: 'active', conditions: [] };
    document.getElementById('decision-editor-heading').textContent = decision ? `Edit decision: ${draft.title} (next version ${decision.latest.version + 1})` : 'New decision';
    editorNote.textContent = resolution ? 'Revising this decision resolves the selected revisit notice.' : '';
    title.value = draft.title; project.value = draft.project; choice.value = draft.choice;
    reasons.value = draft.reasons.join('\n'); alternatives.value = draft.alternatives.join('\n'); state.value = draft.state;
    supersededBy.replaceChildren(make('option', { value: '', textContent: 'None' }), ...(view?.decisions || []).filter(item => item.id !== decision?.id).map(item => make('option', { value: item.id, textContent: item.latest.title })));
    supersededBy.value = draft.supersededBy || '';
    sourceChoices(reliedOn, 'Relied-on sources', new Set(draft.reliedOn.map(ref => ref.key)), 'relied-on');
    // Keep recorded references that are no longer listed, so a save does not drop them silently.
    editing.recorded = draft.reliedOn;
    conditions.replaceChildren();
    for (const condition of draft.conditions) conditionFields(condition);
    editor.hidden = false; preview.hidden = true; title.focus();
  }
  function readDraft() {
    const chosen = [...reliedOn.querySelectorAll('input:checked')].map(box => ({ key: box.value, digest: box.dataset.digest, title: box.dataset.title, revisionId: box.dataset.revision || undefined }));
    const listed = new Set(sources.map(source => source.key));
    const kept = (editing.recorded || []).filter(ref => !listed.has(ref.key));
    return {
      title: title.value, project: project.value, choice: choice.value,
      reasons: reasons.value.split('\n'), alternatives: alternatives.value.split('\n'),
      state: state.value, supersededBy: supersededBy.value || null, reliedOn: [...kept, ...chosen],
      conditions: [...conditions.children].map(box => box.read())
    };
  }
  function showPreview(result) {
    previewId = result.previewId;
    previewSummary.textContent = `Destination: ${result.destination}. Decision version ${result.version}. Nothing is saved until you select Save decision version.`;
    previewContent.value = result.content; preview.hidden = false; previewContent.focus();
  }
  function describeEvidence(item) { return item.evidence.clock ? `Review-by date ${item.evidence.clock}` : `${item.evidence.title} (${item.evidence.key}; sha256 ${item.evidence.digest.slice(0, 12)}…)`; }
  function noticeArticle(notice) {
    const article = make('article', { className: 'revisit-notice' });
    article.setAttribute('aria-label', `Revisit notice for ${notice.decision.title}`);
    article.append(make('h4', { textContent: `${notice.decision.title} — ${notice.condition.label}` }),
      make('p', { textContent: `Status: ${notice.status}. Raised ${notice.raisedAt}. Decision version ${notice.decision.version}, condition version ${notice.condition.version}.` }),
      make('p', { textContent: `Condition: ${notice.condition.trigger} Action: ${notice.condition.action}` }),
      make('p', { textContent: `Evidence: ${describeEvidence(notice)}` }));
    if (notice.passage) article.append(make('blockquote', { className: 'revisit-passage', textContent: notice.passage }));
    article.append(make('p', { className: 'revisit-reason', textContent: `Gate reason: ${notice.reason}` }));
    if (notice.resolution) article.append(make('p', { textContent: `Resolved: ${notice.resolution.action}${notice.resolution.reason ? ` — ${notice.resolution.reason}` : ''} (decision version ${notice.resolution.decisionVersion}).` }));
    if (['open', 'evidence removed'].includes(notice.status)) {
      const reason = make('input', { className: 'resolution-reason' });
      reason.setAttribute('aria-label', `Resolution reason for ${notice.decision.title}`);
      const resolve = action => run(async () => showPreview(await api['decision-resolve-preview']({ noticeId: notice.id, action, reason: reason.value })));
      const buttons = [['Reaffirm decision', () => resolve('reaffirm')], ['Revise decision', () => run(async () => {
        const decision = view.decisions.find(item => item.id === notice.decision.id);
        if (!decision) throw Error('This decision is unavailable.');
        await openEditor(decision, { noticeId: notice.id });
      })], ['Withdraw decision', () => resolve('withdraw')], ['Dismiss notice', () => resolve('dismiss')]];
      article.append(make('label', {}, ['Resolution reason', reason]), ...buttons.map(([text, onclick]) => make('button', { textContent: text, onclick })));
    }
    return article;
  }
  function candidateArticle(candidate, actions) {
    const article = make('article', { className: 'revisit-candidate' });
    article.setAttribute('aria-label', `Candidate for ${candidate.decision.title}`);
    article.append(make('h4', { textContent: `${candidate.decision.title} — ${candidate.condition.label}` }),
      make('p', { textContent: `Status: ${candidate.status}. Evidence: ${describeEvidence(candidate)}.` }),
      make('p', { textContent: `Matched because: ${candidate.reasons.join('; ')}` }),
      ...candidate.passages.slice(0, 1).map(p => make('blockquote', { textContent: p.text })));
    if (candidate.outcomeReason) article.append(make('p', { textContent: `Gate reason: ${candidate.outcomeReason}` }));
    if (candidate.heldReason) article.append(make('p', { textContent: candidate.heldReason }));
    if (candidate.withdrawnReason) article.append(make('p', { textContent: candidate.withdrawnReason }));
    if (candidate.status === 'duplicate') article.append(make('p', { textContent: 'Same matched text as an earlier candidate for this condition version. Not sent to the gate.' }));
    if (candidate.attempts.length) {
      const details = make('details', {}, [make('summary', { textContent: `Gate requests (${candidate.attempts.length})` })]);
      for (const attempt of candidate.attempts) details.append(make('p', { textContent: `${attempt.at} · ${attempt.mode} · ${attempt.status}${attempt.outcome ? ` · ${attempt.outcome}` : ''}${attempt.error ? ` · ${attempt.error}` : ''}${attempt.model ? ` · model ${attempt.model}` : ''}` }), make('pre', { className: 'revisit-package', textContent: attempt.package }));
      article.append(details);
    }
    for (const [text, onclick] of actions) article.append(make('button', { textContent: text, onclick }));
    return article;
  }
  function render() {
    if (!view) { section.hidden = false; notices.replaceChildren(make('p', { textContent: 'Choose a vault to record decisions.' })); return; }
    const openCount = view.notices.filter(notice => notice.status === 'open').length;
    noticeHeading.textContent = `Revisit notices (${openCount} open)`;
    navLink.textContent = openCount ? `Decisions (${openCount} to revisit)` : 'Decisions';
    notices.replaceChildren(...(view.notices.length ? view.notices.map(noticeArticle) : [make('p', { textContent: 'No revisit notices.' })]));
    runStatus.textContent = view.lastRun ? `Last check ${view.lastRun.at} (${view.lastRun.trigger}): ${view.lastRun.status}. ${view.lastRun.message} Pending candidates: ${view.lastRun.pending}.` : 'No revisit check has run yet.';
    automaticStatement.textContent = `When on, each check sends every pending revisit candidate to the signed-in Codex model without asking first: the condition, the decision's choice and reasons, the matched passages with their provenance, and earlier outcomes for that condition. Nothing else from the vault is sent. At most ${view.settings.cap} requests per check; the rest stay pending. Automatic checks are ${view.settings.automatic ? 'on' : 'off'}.`;
    cap.value = view.settings.cap; enable.disabled = view.settings.automatic; disable.disabled = !view.settings.automatic;
    gateStatus.textContent = view.gate.automatic.open ? 'Automatic gate is available.' : view.gate.automatic.reason;
    pending.replaceChildren(...(view.pending.length ? view.pending.map(candidate => candidateArticle(candidate, [
      ['Review gate package', () => run(async () => {
        const result = await api['revisit-package']({ candidate: candidate.id });
        const article = pending.querySelector(`[data-candidate="${candidate.id}"]`);
        const area = make('textarea', { rows: 12, readOnly: true, value: result.text });
        area.setAttribute('aria-label', 'Reviewed gate package');
        const send = make('button', { textContent: 'Send reviewed gate package', disabled: result.blocked || !view.gate.manual.open, onclick: () => run(async () => {
          const sent = await api['revisit-send']({ previewId: result.previewId });
          say(sent.error ? `Gate request failed: ${sent.error}` : `Gate outcome: ${sent.outcome}.`); await load();
        }) });
        article.append(make('p', { textContent: `${result.length} of ${result.limit} characters.${view.gate.manual.open ? '' : ` ${view.gate.manual.reason}`}` }), area, send);
      })],
      ...(candidate.status === 'held' ? [['Allow another automatic attempt', () => run(async () => { await api['revisit-retry']({ candidate: candidate.id }); await load(); })]] : [])
    ])) : [make('p', { textContent: 'No candidates are waiting.' })]));
    for (const [index, article] of [...pending.children].entries()) if (view.pending[index]) article.dataset.candidate = view.pending[index].id;
    notRaised.replaceChildren(...(view.notRaised.length ? view.notRaised.map(candidate => candidateArticle(candidate, [])) : [make('p', { textContent: 'Nothing checked and not raised.' })]));
    inert.replaceChildren(...(view.other.length ? view.other.map(candidate => candidateArticle(candidate, [])) : [make('p', { textContent: 'None.' })]));
    issues.textContent = view.issues.join(' ');
    list.replaceChildren(...(view.decisions.length ? view.decisions.map(decision => {
      const latest = decision.latest, article = make('article', { className: 'decision' });
      article.setAttribute('aria-label', `Decision ${latest.title}`);
      const active = latest.conditions.filter(c => c.state === 'active');
      article.append(make('h4', { textContent: latest.title }),
        make('p', { textContent: `Version ${latest.version} · ${latest.state}${latest.superseded_by ? ` (superseded by ${view.decisions.find(item => item.id === latest.superseded_by)?.latest.title || latest.superseded_by})` : ''} · project ${latest.project}` }),
        make('p', { textContent: `Choice: ${latest.choice}` }),
        make('p', { className: 'decision-conditions-summary', textContent: latest.conditions.length ? `Revisit conditions: ${latest.conditions.map(c => `${c.label} (v${c.version}, ${c.state}${c.state === 'active' && latest.state !== 'active' ? ', inert' : ''})`).join('; ')}` : 'No revisit condition. This decision can never raise a notice.' }),
        ...decision.warnings.map(text => make('p', { className: 'decision-warning', textContent: text })));
      if (decision.blocked) article.append(make('p', { className: 'decision-warning', textContent: 'A version is damaged or missing. This decision is inert until it is repaired.' }));
      if (!active.length && latest.conditions.length) article.append(make('p', { textContent: 'No active revisit condition.' }));
      const versions = make('details', {}, [make('summary', { textContent: `All versions (${decision.versions.length})` })]);
      for (const version of decision.versions) versions.append(make('h5', { textContent: `Version ${version.version} · ${version.state}${version.current ? ' · current' : ' · earlier version, inert'}` }), make('pre', { className: 'decision-version', textContent: version.content }));
      article.append(versions, make('button', { textContent: `Edit decision ${latest.title}`, onclick: () => run(() => openEditor(decision)) }));
      return article;
    }) : [make('p', { textContent: 'No decisions recorded.' })]));
  }
  async function load() {
    const epoch = ++loadEpoch, next = await api['decision-view']();
    if (epoch !== loadEpoch) return;
    view = next; render();
  }
  checkNow.onclick = () => run(async () => { const result = await api['revisit-check'](); await load(); say(result.lastRun ? `Revisit check: ${result.lastRun.status}.` : 'No decisions to check.'); });
  enable.onclick = () => run(async () => { await api['revisit-settings']({ automatic: true, cap: Number(cap.value) }); await load(); say('Automatic revisit checks enabled.'); });
  disable.onclick = () => run(async () => { await api['revisit-settings']({ automatic: false, cap: Number(cap.value) }); await load(); say('Automatic revisit checks disabled.'); });
  newDecision.onclick = () => run(() => openEditor(null));
  addEvidence.onclick = () => conditionFields({ kind: 'evidence' });
  addTime.onclick = () => conditionFields({ kind: 'time' });
  cancelEdit.onclick = () => { editor.hidden = true; preview.hidden = true; editing = null; previewId = null; };
  previewButton.onclick = () => run(async () => {
    showPreview(await api['decision-preview']({ id: editing.id, expectedVersion: editing.expectedVersion, draft: readDraft(), resolution: editing.resolution }));
  });
  cancelPreview.onclick = () => { preview.hidden = true; previewId = null; };
  confirm.onclick = () => run(async () => {
    if (!previewId) throw Error('Preview the decision first.');
    const saved = await api['decision-confirm']({ previewId });
    previewId = null; preview.hidden = true; editor.hidden = true; editing = null;
    await load(); say(`Decision version ${saved.version} saved.`);
  });
  // Capture, intake and vault changes in the rest of the window can add evidence or
  // notices; reload when the shared status line or capture list changes.
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => load().catch(error => { runStatus.textContent = `Decisions unavailable: ${clean(error.message)}`; }), 150); };
  new MutationObserver(later).observe(document.querySelector('[role=status]'), { childList: true, characterData: true, subtree: true });
  window.addEventListener('focus', later);
  later();
})();
