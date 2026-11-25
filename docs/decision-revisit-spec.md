# Decision Ledger and Revisit Notices

Status: **implemented on branch `spec/decision-revisit`; acceptance review of D41–D50 pending.** Decision IDs D41–D50 continue the numbering in [the first spec](local-second-brain-spec.md). [Implementation notes](#implementation-notes) record where the code settles or departs from this text. The measurement plan is in the companion draft, [Revisit Replay Evaluation](revisit-replay-evaluation-spec.md).

## Problem Statement

I make technical decisions for a project (for example "use lexical search, not embeddings") for reasons that hold at the time. Months later I capture a reel, link or note that undermines one of those reasons. Nothing connects the new material to the old decision, so the decision stays in force by default.

Remembering to act later, when a cue appears, is called **prospective memory**. It is different from recalling a fact when asked. Current AI agents are weak at it: on PM-Bench the best agent setup averages 65.1% on the benchmark's main score, and no setup exceeds 50% on tasks that were changed after being set (Liu & Gabriel 2026, Table 2 and §4.4). Searching my notes does not solve this, because search answers a question I think to ask. Here I do not know there is a question.

## Solution

Record each technical decision in a versioned **decision ledger** inside the vault, together with explicit **revisit conditions**: statements of what evidence, or what date, should make me look at the decision again.

When new material enters Companion, two separate steps run:

1. **Retrieve.** A local, inspectable text match finds decisions whose revisit conditions the new material might touch. This step answers "is this related?" and uses no model.
2. **Gate.** A separate model judgment answers a different question: "does this evidence actually meet the revisit condition?" Only a yes produces a **revisit notice**. The default answer is silence. The gate runs automatically after intake once I have switched it on.

The split follows MemoProAgent, whose gate asks whether a memory justifies interrupting the user, not whether it is relevant (Zeng et al. 2026, §5.1). The ledger and its task states follow PM-Bench's definition of a deferred intention (Liu & Gabriel 2026, §3.1).

## Research basis

Each row is a finding I read in the paper and the design choice it leads to here. Section and table numbers refer to the arXiv HTML versions (PM-Bench v1, MemoProAgent v2).

| Finding | Source | Design choice |
| --- | --- | --- |
| A deferred intention is a label, a trigger condition and an action. A task can be active, completed, cancelled or modified. | PM-Bench §3.1 | D41, D42: a decision entry carries revisit conditions with those three parts and the same four states. |
| An explicit to-do ledger gave the fewest false alarms (134, against 199 for the plain agent) and the highest precision (73.2%). | PM-Bench Table 2 | D41: intentions live in an explicit ledger, not in conversation history. |
| Tasks whose cue is hidden until the agent chooses to look are the hardest slice. The best hit rate is 16.7%, and a setup issuing 1,661 queries scored worse overall (45.2%). | PM-Bench §4.3, Table 2 | D44: Companion never relies on a model deciding to look. Every admitted piece of evidence is checked against every active condition. |
| More frequent automatic reminders raised false alarms (489) without raising the score (57.8%). | PM-Bench Table 2, §4.2 | D47: no periodic reminders. A notice needs new evidence or a due date. |
| Cancelled tasks stay selectable in the benchmark to expose stale-memory errors. No setup exceeds 50% on updated tasks. | PM-Bench §3, §4.4 | D43: only the current version of a condition can fire. Superseded and withdrawn versions are kept but inert. |
| Retrieval relevance and the decision to speak are different questions. Removing the gate cut the main score from 37.3 to 24.0. | MemoProAgent §5.1, §6.3 | D45, D46: retrieval and gate are separate stages with separate records. |
| With perfect evidence and perfect timing a model scores 96.0. Letting it choose timing drops it to 38.0. Replacing perfect evidence with retrieval drops it to 15.3. | MemoProAgent Table 4 | D46, and the evaluation spec: finding evidence and deciding to notify fail independently, so they are built and measured independently. |
| On clips with nothing to say, always-on retrieval spoke anyway 77.3% of the time. The gated system spoke 15.3% of the time. | MemoProAgent §6.3 | D46: the gate can abstain, and silence is the default outcome. |
| Hiding the system's own earlier messages caused the largest drop (37.3 to 8.0). Repeating a correct reminder counts as a failure. | MemoProAgent §6.3, §3.3 | D47: notice history is an input. One notice per decision version and evidence revision. |

### What does not transfer

- PM-Bench simulates a week of everyday errands with 81 scored tasks. MemoProAgent watches first-person video against a year of synthetic memory averaging 618K tokens. Companion handles a small number of technical decisions in one person's vault. The papers motivate the design; their scores predict nothing about Companion.
- MemoProAgent's graph memory, personalized PageRank retrieval and reinforcement-learning stage are not adopted. D25 keeps retrieval local, lexical and inspectable. Its known weakness on paraphrase is measured in the evaluation, not hidden.
- MemoProAgent decides every few seconds on a live stream. Companion decides once per piece of admitted evidence. "Timing" here means the notice appears at the first check after the evidence arrives, never before, and never twice.

## User Stories

1. As a project owner, I want to record a decision with its reasons and alternatives, so that I can see later why I chose it.
2. As a project owner, I want to state what would make me reconsider, so that the decision is not permanent by accident.
3. As a project owner, I want a review-by date on a decision, so that time alone can prompt a second look.
4. As a project owner, I want to change a revisit condition without losing the old wording, so that I can see what I used to watch for.
5. As a daily user, I want new captures checked against my decisions without asking, so that I do not have to remember to search.
6. As a daily user, I want to hear nothing when nothing meets a condition, so that notices stay worth reading.
7. As a daily user, I want each notice to show the decision, the condition, the exact passage and the reasoning, so that I can check it myself.
8. As a daily user, I want one notice per piece of evidence, so that I am not told twice.
9. As a project owner, I want to reaffirm, revise or withdraw a decision from a notice, so that the ledger records what I did about it.
10. As a careful user, I want to see what was retrieved but not raised, so that I can judge whether the gate is too quiet.
11. As a careful user, I want rejected or deleted sources never to trigger a notice, so that removed evidence stays removed.
12. As a daily user, I want gate checks to run on their own after intake, so that I do not have to remember to press a button for the feature to work.
13. As a careful user, I want automatic checks off until I turn them on, and a full record of what each one sent, so that unattended sending stays bounded and inspectable.
14. As a careful user, I want a cap on automatic checks, so that a large import cannot use up my model allowance.

## Implementation Decisions

### D41 · Keep technical decisions as versioned vault notes

- **D41-I01**. Add a `Decisions` area under the Companion parent folder. Each decision is a readable Markdown note with a stable identity, schema version, project reference, decided-at instant and state.
- **D41-I02**. A decision holds a title, the choice made, its reasons, the alternatives rejected, and the captures, saved ideas or brief version it relied on, with their source revisions (D03-I04).
- **D41-I03**. Every change publishes a new numbered version and keeps earlier versions as immutable snapshots, using the existing staged publication and recovery path (ADR 0005). The note is the authority. Any index is rebuildable.
- **D41-I04**. Creating or changing a decision is always an explicit, previewed save (D04-I01). Companion never writes a decision on its own.

### D42 · Give each decision explicit revisit conditions

- **D42-I01**. A revisit condition has a label, a trigger and an action, following PM-Bench §3.1. The trigger is a plain-language statement. The action says what to reconsider.
- **D42-I02**. A trigger is either evidence-based ("a capture reports X") or time-based ("review by a date"), the two classic kinds of prospective memory (PM-Bench §2.3).
- **D42-I03**. An evidence-based trigger also lists cue terms and optional linked captures or projects. These drive the local match in D45 and are shown to the user.
- **D42-I04**. A decision may be saved with no condition. It is then labelled "no revisit condition" and can never fire.

### D43 · Track decision and condition state through updates

- **D43-I01**. A condition is active, met, withdrawn or superseded. A decision is active, revised, withdrawn or superseded by another decision. These mirror PM-Bench's active, completed, cancelled and modified.
- **D43-I02**. Only the current version of an active condition on an active decision can produce a candidate or a notice. Earlier versions stay readable and are marked inert.
- **D43-I03**. Editing a condition does not re-open evidence already judged against the old version, and does not carry old outcomes over to the new one.

### D44 · Check every evidence event; never rely on the model to look

- **D44-I01**. An **evidence event** is the admission of a new capture, a new source revision, an annotation, a saved idea or an approved brief refresh.
- **D44-I02**. Each evidence event is matched against all active conditions during the same locked reconciliation that admitted it (D14, ADR 0004), and on quick capture. No model decides whether or when to check.
- **D44-I03**. Time-based conditions are evaluated against the clock at each scheduled, catch-up or manual check. A missed check produces one due result, not one per missed day (D23).
- **D44-I04**. Rejected evidence, removed sources and their derivatives are excluded before matching (D19-I04, D37).

### D45 · Retrieve candidates with inspectable local matching

- **D45-I01**. Reuse the D25 local text retrieval. For each evidence event, rank active conditions by match on cue terms, trigger text, and source or project links, and record the matching passages and reasons.
- **D45-I02**. A match creates a **revisit candidate**: decision version, condition version, evidence revision, passages and reasons. A candidate is not a notice and is not shown as one.
- **D45-I03**. Record "no candidate" outcomes too, so a later miss can be traced to this stage (D32).

### D46 · Gate each candidate separately from retrieval

- **D46-I01**. The gate answers one question per candidate: does this evidence meet this revisit condition? The outcomes are **meets**, **does not meet** and **cannot tell**. Only **meets** raises a notice.
- **D46-I02**. The gate runs automatically for the candidates a check produced, with no send action from the user ([ADR 0007](adr/0007-automatic-revisit-gate.md)). A gate that waits for a button would hand the remembering back to the user, which is the problem this feature exists to remove. MemoProAgent defines the task the same way: the system must decide with no query from the user (§3.1).
- **D46-I03**. Automatic checks are off until the user enables them. The enabling screen states what is sent, to where, and the cap in D46-I07. While they are off, candidates stay pending and can be judged by one reviewed, user-sent package.
- **D46-I04**. An automatic package has a fixed shape and nothing else: the condition, the decision's choice and reasons, the matched passages with their provenance, and earlier notice outcomes for that condition. It obeys the D36 size limit. A candidate that does not fit is held for a manual check, never shortened silently (D36-I03).
- **D46-I05**. Each gate request uses a fresh isolated thread with no tools or file access (D35). Captured text is untrusted: it may contain instructions. The gate's reply is accepted only as one of the three outcomes plus a reason and a quoted passage, and its only possible effect is raising a notice. It cannot write or change a decision (D41-I04).
- **D46-I06**. Record the full package, outcome, reason, model settings and observed usage against the candidate. Every automatic package is inspectable afterwards from its notice or from "checked, not raised".
- **D46-I07**. Cap automatic gate requests per check. Candidates over the cap stay pending and are shown as such. Offline, signed-out or usage-limit failures stop the run, leave candidates pending and appear in the schedule status. Permissions are never widened to make a request succeed (D35-I05).
- **D46-I08**. A failed or interrupted gate request is terminal and is never replayed. Its candidate returns to pending and gets a new request at the next check, up to three attempts, after which it needs an explicit retry. This is a bounded exception to D31-I02, which covers user turns.
- **D46-I09**. The gate runs after reconciliation releases the intake lock, so a slow model call cannot block or overlap intake (ADR 0004).
- **D46-I10**. The gate depends on the production chat readiness gate, plus a real check that an automatic request from the scheduled worker is isolated in the same way. While either is closed, candidates accumulate as pending and no notice is raised from evidence. Time-based conditions need no model and still work.

### Production evidence

Review-by dates use the local clock during a check. Local retrieval records matched evidence as pending while hosted inference is unavailable. A manual send needs a single-use preview from the selected vault and current chat readiness. Immediately before submission, Companion checks the verified model capacity, eligible source revision, active condition and exact package. Automatic sends additionally require current opt-in and a valid per-check request cap. After three automatic failures, each explicit retry grants one further attempt. Service outages stop the batch.

On 2026-11-25, Windows Task Scheduler launched the production worker at an accelerated trigger with the desktop closed. The disposable vault had automatic consent enabled and a cap of one. Intake imported one synthetic capture. Revisit recorded one pending evidence candidate, one due notice and zero gate attempts. The task exited with code zero and cleanup verified its removal. To repeat, use `scripts/probe-scheduled-intake.cjs` with `prepare`, `arm`, `observe`, and `cleanup` against one fresh disposable directory. Pass `--revisit` to both `prepare` and `observe` and wait for the armed trigger before observing.

The production worker performs local checks only. Enabling hosted requests requires a separate implementation and target-machine evidence. Run the registered task under its normal Windows principal with the desktop closed and a disposable vault. Verify the executable, arguments, working directory, protected roots and tool inventory against the approved isolation policy. Observe one fresh isolated thread for one authorized candidate, the exact submitted package, effective model settings, observed usage, and completion after intake releases its lock. Repeat with consent revoked and with readiness unavailable, and verify zero submissions. Target-machine inference isolation and a signed-in worker turn remain outstanding.

### D47 · Raise at most one notice, and default to silence

- **D47-I01**. A **revisit notice** shows the decision, the condition, the evidence passage with its source revision, and the gate's reason.
- **D47-I02**. Raise one notice per pair of condition version and evidence revision. Earlier notices and their outcomes are supplied to the gate so the same point is not raised again from a re-import or a near-duplicate.
- **D47-I03**. Notices appear in a Revisit list inside Companion. There are no periodic reminders, operating-system pop-ups or sounds in this increment.
- **D47-I04**. Candidates that did not become notices are listed separately as "checked, not raised", with the gate's reason.

### D48 · Resolve a notice explicitly

- **D48-I01**. From a notice the user can **reaffirm** (decision stands, evidence recorded as considered), **revise** (new decision version), **withdraw** the decision, or **dismiss** the notice with a short reason.
- **D48-I02**. Each resolution is a previewed save that publishes a new ledger version linking the notice and evidence revision.
- **D48-I03**. A dismissed notice stays dismissed for that evidence revision.

### D49 · Keep source removal and deletion authority intact

- **D49-I01**. A decision is independent user writing. Deleting a capture leaves the decision in place with a missing-reference warning (ADR 0001, ADR 0006).
- **D49-I02**. Deleting or rejecting a source withdraws its open candidates and marks its raised notices as "evidence removed". It does not silently undo a resolution the user already made.
- **D49-I03**. Decision notes, candidates and notices are included in dependency previews and in the Local History Archive where they live outside the vault.

### D50 · Make every stage observable for evaluation

- **D50-I01**. Persist, per evidence event, the candidate list, each gate outcome and each notice. These records are the input to the replay evaluation.
- **D50-I02**. Allow the gate to be replaced by a fixed rule ("notify on any match") under test, so retrieval and gate can be measured apart.

## Testing Decisions

Test at the desktop workflow and the resulting files, with controlled time, producer artifacts and model replies (D40). Acceptance examples:

- **D41, D43**. Save a decision, edit its condition twice, restart. Three versions exist, only the latest is active, and the earlier wording is readable.
- **D44, D45**. Import a reel whose text matches a condition's cue terms. One candidate is recorded with the matching passage. An unrelated import records "no candidate".
- **D46**. With a controlled "meets" reply, one notice appears with the quoted passage. With "does not meet" or "cannot tell", no notice appears and the candidate is listed as checked, not raised.
- **D47**. Re-import the same source revision and import a retitled copy. No second notice appears.
- **D43**. Evidence that matches a superseded condition version raises nothing.
- **D44-I03**. Advance the clock past a review-by date across three missed checks. One due notice appears.
- **D49**. Delete the source behind a raised notice. The notice shows "evidence removed", and the decision note is byte-identical.
- **D46-I02, D46-I03**. With automatic checks enabled, a scheduled check with the window closed imports a matching reel and raises one notice with no user action. With them disabled, the same import leaves one pending candidate and sends nothing.
- **D46-I04, D46-I06**. The recorded package contains only the fixed parts. A canary note elsewhere in the vault never appears in it. An oversized candidate is held for a manual check.
- **D46-I05**. Evidence text that tells the model to raise a notice or edit a decision changes nothing beyond a normal outcome. A reply outside the allowed shape is recorded as a failed request.
- **D46-I07**. With a cap of two and five candidates, two requests are sent and three stay pending. A controlled usage-limit failure stops the run and shows in the schedule status.
- **D46-I08**. A candidate whose request fails three times is held for explicit retry and is not sent a fourth time.
- **D46-I10**. With chat readiness closed, evidence produces pending candidates and no notice.
- **Failure and recovery**. Interrupt publication of a decision version and a gate request. After restart there is no duplicate version, no false notice and no replay of the interrupted request.

Live model behaviour is a separate real integration gate and is not replaced by controlled replies (D40-I04).

## Out of Scope

- Operating-system notifications, email, mobile alerts and periodic reminders.
- Watching the web or any source outside the Discovery Corpus (D16, D33).
- Automatic changes to a decision, a project or code as a result of a notice.
- Semantic or embedding retrieval, graph memory and model training. If the evaluation shows lexical retrieval is the limiting stage, that is a later, separately approved change to D25.
- Extracting decisions automatically from conversations or documents.
- Multi-user ledgers and sync.

## Open Questions

1. **What is the cap?** Recommended: 10 automatic gate requests per check, changeable in settings. The right number depends on the Codex allowance, which is unmeasured until the sign-in check runs.
2. **Which projects first?** Recommended: MyTune only, reusing its approved brief.
3. **Where do notices appear?** Recommended: a Revisit list plus a count on Today.

Settled on 2026-11-20: the gate runs automatically at intake, not on a user send. See [ADR 0007](adr/0007-automatic-revisit-gate.md).

## Glossary terms

**Decision**, **Decision Ledger**, **Revisit Condition**, **Evidence Event**, **Revisit Candidate**, **Gate Outcome**, **Revisit Notice** are defined in `GLOSSARY.md`.

## Implementation notes

Code: `app/decisions.js` (ledger), `app/revisit.js` (checks, candidates, notices), `app/revisit-match.js` (local matching), `app/revisit-gate.js` (package, reply parsing, providers), `app/decisions-ipc.js` and `app/decisions-view.js` (desktop). Acceptance tests: `tests/decisions.spec.js`.

- **Storage (D41).** Each version is an immutable note at `<parent>/Decisions/<decision id>/version-<N>.md`, published with the existing exclusive first-publication path, so an interrupted save leaves either no new version or exactly one. Revisit records (seen evidence, events, candidates, gate requests, notices, settings) live in one atomically replaced file, `<parent>/.revisit/state.json`, inside the vault. Each gate package is written once to `<parent>/.revisit/packages/<request id>.txt`; the records keep its path, length and digest. Vault backups therefore include them; the Local History Archive is unchanged (D49-I03).
- **When matching runs (D44-I02, departure).** Matching runs right after intake or capture finishes, not inside the intake lock. Reading the eligible corpus takes the intake source lock, so the check queues behind the same per-vault request order as capture and intake. Every evidence revision is still matched exactly once, by the first check that sees it, and no model decides when to look. Checks also run after capture deletion and annotation removal, at desktop startup catch-up, from **Check decisions now**, and in the scheduled worker.
- **Evidence before a condition.** Evidence present when a decision version is saved is marked as seen without matching, so a new condition never fires on material that existed when it was written. If the corpus cannot be read at save time, the save still succeeds and that older evidence can still be matched at the next check.
- **Matching (D45).** A candidate needs at least one cue-term match (whole words, or a phrase for multi-word cues) or a linked source. Trigger words only add to the recorded reasons. Up to three matched passages are kept.
- **Repeats (D47-I02).** Besides one notice per condition version and evidence revision, a candidate whose matched passages are identical to an earlier candidate for the same condition version is recorded as a duplicate and never sent to the gate. This is how a retitled copy or re-import stays silent without a model call.
- **Superseded conditions (D43-I03).** Pending candidates for a condition version that is no longer current are withdrawn as inert.
- **Gate (D46).** Replies must be exactly one JSON object with `outcome`, `reason` and `quote`; the quote must appear in the matched passages. Anything else is a failed request. Failures that look like usage limits, offline or sign-in problems stop the run; they are recorded as "stopped" and do not count toward a candidate's three attempts. A request still marked as sent is treated as interrupted once its owning process has exited or 30 minutes have passed, so a reused process id cannot hold it forever. An oversized candidate returns to pending when its decision is saved in a new version. The production gate stays closed: chat readiness is closed, and isolation of automatic requests from the scheduled worker is unverified (D46-I10). Desktop tests use controlled replies from `revisit-gate.json` in the disposable test root.
- **Test seam (D50-I02).** Under the test root only, `"rule": "match"` in `revisit-gate.json` replaces the gate with "notify on any match".
- **Open questions, settled with the recommended defaults.** The cap defaults to 10 requests per check and can be set from 1 to 100. Decisions carry a free-text project, defaulting to MyTune. Notices appear in a Revisit list in the Decision ledger section, and the navigation link shows the open count.
- **Resolution (D48).** Reaffirm and dismiss on a review-by notice mark that condition as met in the new version. Revise opens the editor with the notice attached. Withdraw withdraws the decision and its conditions.

## References

- Genglin Liu and Saadia Gabriel. "PM-Bench: Evaluating Prospective Memory in LLM Agents." COLM 2026. [arXiv:2607.12385](https://arxiv.org/abs/2607.12385).
- Shenglai Zeng, Xiao Yang, Tiffany Ma, et al. "MemoProAgent: Toward Memory-Driven Proactive Assistance." 2026. [arXiv:2610.22671](https://arxiv.org/abs/2610.22671).
