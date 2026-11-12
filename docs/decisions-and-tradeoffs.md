# Companion decisions and trade-offs

Recorded on 2026-11-07, America/Phoenix.

The user accepted D01–D04 in the initial review and D05–D40 in Q5–Q40. Grilling is complete. Shared understanding and the external-behavior test seams were confirmed. Q14 replaced startup-plus-periodic intake with a 24-hour cadence. Application implementation and real integration gates remain unexecuted.

IDs match `decisions-and-tradeoffs.json`. Requirements describe planned behavior and safeguards. Update both records together.

## D01 · Deliver the complete capture-to-project workflow first

Status is accepted.

### Accepted decision

- Include quick capture, a daily inbox, automatic Reel to MD intake, one MyTune project brief, Codex idea chat, and explicit saving to the Obsidian vault.
- Use a reel-to-MyTune conversation that produces a cited experiment proposal as the first acceptance scenario.
- Include a small paired comparison of direct brainstorming and explicit analogy reasoning in this milestone.
- Deliver watches and the formal repeated, blind-scored evaluation in later increments.

A complete journey tests whether the product helps turn collected material into a useful project idea. An early paired comparison tests the central reasoning technique before extensive product work.

### Alternatives considered

- **Capture and import only**. Benefits include Smallest delivery surface and Earlier storage and recovery feedback. Costs include Does not test project relevance or the value of the reasoning workflow. Deferred as a standalone release boundary. These capabilities remain the first implementation steps.
- **Complete workflow with all comparison work deferred**. Benefits include Less evaluation work during the first milestone. Costs include Delays evidence about whether explicit analogy adds value. Rejected in favor of a small early paired comparison.
- **Full draft including watches and formal evaluation**. Benefits include Covers the broad product vision together. Costs include Adds background matching, lifecycle state, deduplication, and evaluation tooling before core usefulness is established. Deferred to later increments.

### Consequences we accept

- Several integrations must work before the first complete acceptance scenario can pass.
- A weak idea may result from source quality, retrieval, project context, or reasoning. The workflow must expose enough evidence to distinguish those causes.
- A small comparison provides exploratory evidence. It cannot establish general usefulness or learning outcomes.
- The first milestone includes both an explicit analogy path and a direct brainstorming path for comparison.

### Full implementation requirements for this decision

- **D01-I01**. Provide thought/link capture and a Today inbox backed by vault notes. Capture and import must remain usable when Codex is unavailable.
- **D01-I02**. Detect completed intake artifacts, validate the supported export contract, and create or update a capture with visible success or failure. Partial writes and unreadable input must not appear as successful imports.
- **D01-I03**. Build one MyTune brief from selected current project documents, retaining source references and the context version used for a conversation.
- **D01-I04**. Support a conversation using selected captures and the MyTune brief. The analogy output must explain the shared mechanism, project application, limitations, and a small test, with references to both source and project context.
- **D01-I05**. Allow an explicit no-useful-connection result. Label proposed applications as hypotheses and expose missing support.
- **D01-I06**. Provide a paired comparison using the same source material, project brief, model, candidate count, and approximately comparable generation budget. Record prompts, model, inputs, outputs, and comparison conditions. Rate usefulness, surprise, grounding, and ease of testing using the same rubric. Include a case where analogy may add little.
- **D01-I07**. Implement in verifiable steps. Establish capture/import first, then project context and a real signed-in Codex interaction, then saving and the paired comparison. Use fixture responses for repeatability and a real interaction for integration evidence.

### Acceptance checks

- With a test vault and supported reel export, import once, discuss its application to MyTune, and explicitly save a cited experiment proposal that opens in Obsidian.
- Re-importing the same logical export leaves one current capture.
- Offline or unavailable Codex does not prevent capture/import or damage existing notes.
- A non-fit example can finish without a proposal.
- Run both comparison paths on identical material and retain the conditions and outputs for inspection.

### Related decision topics

- O01 · Import eligibility and contract (resolved)
- O02 · Evidence history (resolved)
- O03 · Codex connection and data boundary (resolved)
- O04 · Project brief lifecycle (resolved)
- O05 · Comparison protocol (resolved)
- O06 · Context retrieval (resolved)

## D02 · Manage imported content and preserve user writing separately

Status is accepted.

### Accepted decision

- Keep one current imported capture per logical export.
- Re-imports update export-owned content and metadata.
- Store user annotations and saved ideas in separate linked notes.
- Retain enough revision information to identify the evidence used by an existing proposal.
- Carry identity, revision, provenance, and review information through an explicit import contract.

Separate ownership permits predictable import updates while preserving user writing. Revision-aware citations let an older proposal remain inspectable after its source changes.

### Alternatives considered

- **Replace an unrestricted editable imported note**. Benefits include Simple synchronization. Costs include Can destroy user edits. Rejected.
- **Managed and editable sections in one note**. Benefits include Source and commentary stay together in Obsidian. Costs include Marker changes and concurrent edits make safe updates more complex. Rejected for the initial workflow.
- **Create a new inbox note for every import**. Benefits include Naturally preserves all received versions. Costs include Creates duplicates and complicates identifying the current capture. Rejected as the inbox model. Evidence history may still be retained outside the current inbox entry.

### Consequences we accept

- Related content spans multiple notes, so the interface must make navigation and joint reading easy.
- Imported notes are managed content even though users can access them in Obsidian.
- Conflict handling is required when a user edits a managed note externally.
- Current capture content and historically cited evidence have distinct lifecycles.
- Validated export, review decision, and factual support must remain distinguishable.

### Full implementation requirements for this decision

- **D02-I01**. Resolve a logical export identity independently from its path and revision identity. Retry or relocation must not create a second current capture for the same export.
- **D02-I02**. Validate an import envelope carrying logical identity, revision identity, content, available source locators/timestamps, provenance, and review information. Do not infer human approval from a successful export or a content completeness field.
- **D02-I03**. Update only the managed capture. Link annotations and saved ideas using a stable capture identity so import updates do not break their relationship.
- **D02-I04**. Make import publication atomic from the user's perspective. Detect changed destination content before replacing it and preserve conflicting user content. A failed or retried import must leave a recoverable state.
- **D02-I05**. Record the source revision and evidence location used by each saved idea. Make that cited revision inspectable after a later import using D06 immutable snapshots. O02 tracks retention and deletion details.
- **D02-I06**. Show source content, annotations, linked ideas, and review information together or through direct navigation. Explain the ownership of managed notes before direct editing.
- **D02-I07**. Preserve original captures. Saving an interpretation or experiment creates its own note and does not rewrite the source to agree with the proposal.

### Acceptance checks

- Import revision A, add an annotation and saved idea, then import revision B. There is one current capture, user writing is intact, and the old idea's evidence from A remains inspectable.
- Retry an interrupted import without duplicates or false success.
- Modify a managed note in Obsidian before re-import. Preserve the edit and expose a recoverable conflict.
- An export without human review remains visibly unreviewed. An unreadable review bundle does not silently become reviewed.
- Move an input file while keeping its logical export identity and verify deduplication.

### Related decision topics

- O01 · Import eligibility and contract (resolved)
- O02 · Evidence history (resolved)
- O07 · Managed note conflicts (resolved)
- O08 · Review semantics (resolved)
- O09 · Vault layout and identity (resolved)

## D03 · Distinguish captures, project briefs, saved ideas, and experiment proposals

Status is accepted.

### Accepted decision

- A Capture is collected material for possible later use, with an initial type of thought, link, or reel import.
- A Project Brief supplies project goals and constraints.
- A Saved Idea records an interpretation or conclusion developed from material.
- An Experiment Proposal is a saved idea that includes a testable hypothesis and a proposed test.
- Today is a date-filtered view of captures. Older captures remain accessible.
- Several captures can support one idea, and one capture can support several ideas.

A shared inbox accommodates different inputs while explicit concepts keep source material, project context, and generated interpretation understandable.

### Alternatives considered

- **Call every stored item a capture**. Benefits include One simple collection. Costs include Blurs collected evidence, project context, and interpretation. Rejected.
- **Use unrelated concepts and lists for each capture type**. Benefits include Tailored behavior for each input. Costs include More terminology and repeated behavior across browsing and search. Rejected as the domain model.

### Consequences we accept

- Capture types need different metadata and rendering while sharing inbox behavior.
- An imported capture can have provenance that a rough thought lacks.
- Older material needs navigation beyond Today.
- Relationships between captures and ideas must support multiple links in both directions.
- An experiment proposal is a specialization of a saved idea, so the app must not require a test for every saved idea.

### Full implementation requirements for this decision

- **D03-I01**. Represent stable capture identity, type, captured time, content, and available provenance. Use type-specific metadata for imports without requiring invented source metadata on a rough thought.
- **D03-I02**. Keep source occurrence time, import time, and captured time distinct when available. Apply D11 first-capture semantics to Today. O10 tracks timezone and day-boundary details.
- **D03-I03**. Provide access to earlier captures and connected ideas. Changing the day must not delete, resolve, or hide older captures from all navigation.
- **D03-I04**. Represent source-to-idea links as many-to-many relationships and retain the relevant evidence revision. Keep project context references distinguishable from capture references.
- **D03-I05**. Treat Experiment Proposal as a saved idea with experiment fields. Avoid mandatory experiment fields for other saved ideas.

### Acceptance checks

- Create a thought, a bare link, and a reel import. Each appears as a capture with its type and available metadata.
- Find a capture from a previous day.
- Save an idea using two captures, then save another idea from one of those captures. Navigate all relationships.
- Save an idea without an experiment and a complete experiment proposal without misclassifying their supporting captures.

### Related decision topics

- O09 · Vault layout and identity (resolved)
- O10 · Today semantics (resolved)
- O11 · Capture interactions (resolved)

## D04 · Save structured ideas explicitly, with experiments when ready

Status is accepted.

### Accepted decision

- Saving a note requires an explicit user action.
- Show the proposed note and vault destination before committing it.
- Save a structured idea containing an explanation, supporting references, and explicit uncertainty.
- Include an experiment when the idea has a hypothesis, a small test, and an observable result.
- The first acceptance scenario must produce a complete experiment proposal.
- Retain conversation history locally under D13 independently from explicitly saving notes.

Explicit saving keeps the vault deliberate. Flexible structured ideas preserve useful conclusions at different stages, including a conclusion that a proposed analogy fails.

### Alternatives considered

- **Automatically save all generated ideas**. Benefits include Low effort and fewer forgotten ideas. Costs include Adds weak suggestions, duplicates, and conversational debris. Rejected for the initial workflow.
- **Automatically save candidate drafts for later promotion**. Benefits include Preserves candidates with a later quality gate. Costs include Adds another inbox and lifecycle. Deferred.
- **Save only free-form excerpts**. Benefits include Fast and flexible. Costs include Can omit evidence and the reason the idea mattered. Rejected as the default saved artifact.
- **Require an experiment for every save**. Benefits include Consistent and actionable. Costs include Forces premature experiments and excludes useful observations. Rejected.

### Consequences we accept

- Users can leave without saving useful material.
- Preview and explicit commit add an interaction.
- Incomplete ideas and missing support must be representable honestly.
- Saved notes and conversation history require separate persistence policies.
- A failure to save must remain recoverable without creating duplicate notes on retry.

### Full implementation requirements for this decision

- **D04-I01**. Provide a save action that builds a proposed standalone note and shows its content and destination. Commit only after the explicit save confirmation.
- **D04-I02**. Include a title, explanation, source/project references where available, and uncertainty or limitations. Clearly disclose missing support rather than generating citations.
- **D04-I03**. When an experiment is present, include the hypothesis, borrowed mechanism, project application, smallest test, and observable result. Validate completeness before labeling the note an Experiment Proposal.
- **D04-I04**. Retain capture identities, cited revisions, evidence locations, and project context references in the saved artifact. Distinguish source claims from proposed applications.
- **D04-I05**. Write the note safely, avoid overwriting unrelated files, and make retries recoverable without duplicate successful saves. Preserve the proposed content after failure so the user can retry.
- **D04-I06**. Handle a useful negative conclusion such as an analogy breaking down as a normal Saved Idea. A no-useful-connection response does not require a saved artifact.
- **D04-I07**. Apply D13 local history and restart/resume behavior independently from explicit note saving. Set remaining retention, storage, and recovery details through O12.

### Acceptance checks

- Generate a useful idea and verify that it becomes a vault note only after an explicit save confirmation.
- Review note content and destination before writing.
- Save an observation with no test and an explanation of a failed analogy.
- Save a complete experiment proposal with source and project citations, then open it in Obsidian.
- Simulate a failed write and retry. Recover the content and produce one successful note.
- Update a cited capture after saving and verify that the saved idea still identifies its original evidence.

### Related decision topics

- O02 · Evidence history (resolved)
- O09 · Vault layout and identity (resolved)
- O12 · Conversation persistence (resolved)

## D05 · Admit valid draft and reviewed exports

Status is accepted.

User approval for Q5 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Automatically admit valid draft exports and reviewed exports, preserving their distinct status.
- A partial but valid draft may enter the inbox and inform a conversation. Show review status, limitations, and evidence together.
- Failed processing and incomplete file transfers are outside successful imports.
- Preserve actual human review decisions and findings.

Admission before formal review makes the inbox useful earlier.

### Alternatives considered

- **Reviewed exports only**. Benefits include Stronger admission gate. Costs include Delays access to useful draft material. Not selected for the initial workflow.
- **Treat all exported material as equally trusted**. Benefits include Simpler display. Costs include Hides uncertainty and review findings. Not selected for the initial workflow.

### Consequences we accept

- Conversations must handle uncertain source material explicitly.
- A validated export is not proof that every claim is correct.

### Full implementation requirements for this decision

- **D05-I01**. Validate supported artifacts before publishing an import. Separate processing completeness, validation, extraction uncertainty, and human review information.
- **D05-I02**. Expose status and limitations both in the capture view and in context sent to Codex.
- **D05-I03**. Do not label incomplete transfers, failed processing, or unreadable review metadata as a successful reviewed import. The exact handoff and contract remain open.

### Acceptance checks

- A valid partial draft appears as unreviewed with its limitations.
- A reviewed import preserves the decision and findings.
- An incomplete transfer or failed artifact is not admitted as successful.

### Related decision topics

- O01 · Import eligibility and contract (resolved)
- O08 · Review semantics (resolved)

## D06 · Retain immutable imported text revisions in the vault

Status is accepted.

User approval for Q6 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Keep an immutable text-and-metadata snapshot of every successfully imported revision inside the vault.
- Keep one current capture and revision history outside the daily inbox. Saved ideas refer to the revision used.
- Snapshots retain imported text, evidence references, provenance, and review metadata.
- Reference original videos through available locators.

Historical evidence stays inspectable when the current capture changes.

### Alternatives considered

- **Keep only the current revision**. Benefits include Less storage and fewer files. Costs include Earlier cited evidence can disappear. Not selected for the initial workflow.
- **Copy all original media**. Benefits include More complete offline source access. Costs include Greater storage and asset management burden. Not selected for the initial workflow.

### Consequences we accept

- Additional files and storage are accepted.
- Text retention cannot guarantee future access to an original video.
- Cleanup and deletion policies remain unresolved.

### Full implementation requirements for this decision

- **D06-I01**. Publish an immutable snapshot for every accepted imported revision while preserving the current capture identity.
- **D06-I02**. Store source text and metadata with revision identity and evidence anchors. Keep snapshots accessible from citations and outside Today.
- **D06-I03**. Resolve a saved idea's evidence link to its cited revision after an update. Detect snapshot damage and report unavailable evidence rather than substituting newer text.
- **D06-I04**. Do not infer authorization to copy original videos. Store their available locators. Retention and deletion behavior require O02.

### Acceptance checks

- Import A, cite A, import B, and open both A and B independently.
- Retry A without an extra accepted snapshot.
- An unavailable video is reported while retained text remains accessible.

### Related decision topics

- O02 · Evidence history (resolved)
- O09 · Vault layout and identity (resolved)

## D07 · Send visible bounded context to Codex

Status is accepted.

User approval for Q7 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Send the user's question, relevant conversation history, and a bounded selection of capture and project excerpts to Codex.
- Companion assembles the context and makes included sources visible.
- Allow inspection and removal of included sources before sending.
- Direct agent access to vault and project folders is outside the initial workflow.

Explicit source selection supports hosted reasoning with an inspectable data boundary.

### Alternatives considered

- **Give the agent folder access**. Benefits include Flexible exploration. Costs include Broader exposure and harder-to-bound reads. Not selected for the initial workflow.
- **Require all content to remain on the PC**. Benefits include Strict local content boundary. Costs include Conflicts with using hosted Codex inference on those contents. Not selected for the initial workflow.

### Consequences we accept

- Selected content leaves the PC.
- Bounded context can omit relevant material.
- Retrieval quality and source selection are Companion responsibilities.
- Integration and effective access controls still require verification.

### Full implementation requirements for this decision

- **D07-I01**. Build each outgoing context package in Companion with selected excerpts, provenance, and relevant history.
- **D07-I02**. Present included sources and support removing them before dispatch. Send only the reviewed package after the user's send action.
- **D07-I03**. Keep vault and project folders outside direct agent tool access and test the effective boundary on Windows.
- **D07-I04**. Expose unavailable authentication, offline operation, usage limits, interruption, and other failed turns while preserving local capture and existing notes. Set exact context bounds and integration through O03/O06.

### Acceptance checks

- Remove a source before sending and verify its text is excluded from the outgoing context, including reintroduced history.
- Verify bounded context and visible sources correspond to the actual outgoing package.
- Attempt an agent read outside supplied context and verify it cannot read vault/project folders.
- Simulate an interrupted turn without losing local captures.

### Related decision topics

- O03 · Codex connection and data boundary (resolved)
- O06 · Context retrieval (resolved)
- O12 · Conversation persistence (resolved)

## D08 · Approve project brief refreshes and pin conversation context

Status is accepted.

User approval for Q8 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Build the MyTune brief from an explicitly selected set of current project documents.
- Generate a proposed brief with references and require user approval.
- Detect changed inputs and offer a reviewed refresh before the next conversation.
- An existing conversation retains the brief version it started with.
- Allow continuing with a visibly outdated brief.

Reviewed versions preserve user control and make conversations reproducible.

### Alternatives considered

- **Refresh silently within conversations**. Benefits include Always uses newer documents. Costs include Changes the basis of reasoning without review. Not selected for the initial workflow.
- **Keep a permanently static brief**. Benefits include Minimal refresh work. Costs include Context drifts from the project. Not selected for the initial workflow.

### Consequences we accept

- Brief approval adds an interaction.
- The user may continue with visibly outdated context.

### Full implementation requirements for this decision

- **D08-I01**. Record selected documents and their versions with each proposed brief and retain source references.
- **D08-I02**. Require approval to activate a newly generated or refreshed brief.
- **D08-I03**. Detect changes to selected inputs and offer a new brief before starting a conversation; visibly mark outdated inputs.
- **D08-I04**. Pin the approved brief version when starting a conversation and preserve access to the cited context. Resolve missing inputs, limits, and refresh failures through O04.

### Acceptance checks

- Change an input document and verify a refresh is offered without silently replacing the active brief.
- An existing conversation retains its original brief while a new conversation can use an approved refresh.
- Continuing with an older brief shows it is outdated.

### Related decision topics

- O04 · Project brief lifecycle (resolved)
- O09 · Vault layout and identity (resolved)

## D09 · Pause per-capture updates on managed note conflicts

Status is accepted.

User approval for Q9 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Preserve an externally edited managed capture and pause its updates until the user resolves the conflict.
- Preserve both the local version and the incoming revision.
- Offer to move user changes into an annotation and then apply the update, or leave the conflict unresolved.
- Other imports continue.
- While unresolved, identify the version used by a conversation.

Explicit conflict resolution preserves writing without guessing how to merge source material.

### Alternatives considered

- **Overwrite local edits**. Benefits include Simple automatic updates. Costs include Loses user writing. Not selected for the initial workflow.
- **Automatically merge edits**. Benefits include Less user interruption. Costs include Can alter source meaning or annotations. Not selected for the initial workflow.
- **Stop all intake on one conflict**. Benefits include Simple global pause. Costs include Unrelated imports are blocked. Not selected for the initial workflow.

### Consequences we accept

- Updates for the conflicting capture are interrupted.
- Conflicts may remain unresolved and conversations need explicit version identity.

### Full implementation requirements for this decision

- **D09-I01**. Detect destination changes against the last managed version before applying an update.
- **D09-I02**. Preserve local and incoming content and mark the capture conflicted. Continue independent intake.
- **D09-I03**. Present local changes for user-controlled transfer to an annotation before applying the incoming revision.
- **D09-I04**. Keep unresolved conflicts recoverable across restart and identify the exact content used in any conversation. Resolve rename/deletion/concurrency details through O07.

### Acceptance checks

- Edit a managed note, re-import, and verify both versions survive.
- Import an unrelated capture during a conflict.
- Resolve into an annotation and verify the user content and new source are both retained.
- Restart during an unresolved conflict and recover its state.

### Related decision topics

- O07 · Managed note conflicts (resolved)
- O09 · Vault layout and identity (resolved)

## D10 · Use a dedicated structured vault folder

Status is accepted.

User approval for Q10 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Use one dedicated folder inside the selected vault, with separate areas for captures, annotations, ideas, project briefs, and revision history.
- Let the user choose the parent folder during setup.
- Use stable item identities in metadata, readable filenames, and ordinary Markdown links.
- Renames and moves must preserve identity and relationships.

A visible ownership boundary makes storage and recovery understandable.

### Alternatives considered

- **Scatter notes through existing vault folders**. Benefits include Blends into an established vault. Costs include Harder to identify managed content and recover relationships. Not selected for the initial workflow.
- **Keep all artifacts in one flat folder**. Benefits include Fewer folder choices. Costs include More clutter and less clear ownership. Not selected for the initial workflow.

### Consequences we accept

- More files and folder structure appear in Obsidian.
- Exact folder names, metadata, link repair, and lifecycle behavior remain to be settled.

### Full implementation requirements for this decision

- **D10-I01**. Set up an explicit user-selected parent folder with distinct artifact areas.
- **D10-I02**. Persist stable item identities independently from paths and readable filenames.
- **D10-I03**. Use ordinary Markdown links and reconcile identity when notes move or are renamed.
- **D10-I04**. Keep managed content ownership clear and avoid overwriting unrelated notes. Determine schema and repair rules through O09.

### Acceptance checks

- Create each artifact type under the selected parent folder.
- Open notes and relationships in Obsidian.
- Rename or move a note and preserve its identity and relationships.
- Encounter an unrelated filename collision without overwriting it.

### Related decision topics

- O09 · Vault layout and identity (resolved)

## D11 · Base Today on the first capture date

Status is accepted.

User approval for Q11 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Today shows material first captured into Companion during the current local calendar day.
- Importing an old reel today puts it in Today.
- A later update retains the original capture date.
- Keep source date and revision time separately when available.
- Older captures remain accessible through history and search, and updates need a separate visible indicator.

The view answers what the user collected today.

### Alternatives considered

- **Use source publication date**. Benefits include Tracks source chronology. Costs include Newly imported old material disappears from Today. Not selected for the initial workflow.
- **Move updated captures into Today**. Benefits include Highlights recent updates. Costs include Blurs collection date and refresh date. Not selected for the initial workflow.

### Consequences we accept

- Updates do not automatically re-enter Today.
- Timezone changes and day-boundary details require an explicit follow-up policy.

### Full implementation requirements for this decision

- **D11-I01**. Store the initial capture time immutably and preserve it across imports and revisions.
- **D11-I02**. Filter Today using the capture time and local calendar day under the selected timezone policy.
- **D11-I03**. Store source and revision times separately and surface an update indicator.
- **D11-I04**. Maintain historical browsing/search. Set travel, timezone changes, and backdating rules through O10.

### Acceptance checks

- Import an old reel and find it in Today.
- Update it on the next day and verify its initial capture date is retained.
- Show the update separately and locate the capture in history.

### Related decision topics

- O10 · Today semantics (resolved)

## D12 · Keep quick capture minimal and offline

Status is accepted.

User approval for Q12 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Accept a thought or link without a required title, project, or tags.
- Save entered text locally and assign its capture time.
- Derive an editable display title.
- Reject empty input.
- Store pasted links immediately and make fetching content an explicit later action.

Minimal input reduces capture friction and works offline.

### Alternatives considered

- **Require categorization before saving**. Benefits include Better initial organization. Costs include More friction when capturing a fleeting idea. Not selected for the initial workflow.
- **Fetch links automatically before saving**. Benefits include Richer content immediately. Costs include Network dependency, latency, and unintended fetching. Not selected for the initial workflow.

### Consequences we accept

- Titles and initial organization can be uneven.
- Stored links have no searchable page content until explicitly enriched.

### Full implementation requirements for this decision

- **D12-I01**. Provide thought/link entry with no mandatory organization fields.
- **D12-I02**. Validate nonempty text and persist it locally with capture time without waiting for Codex or a network request.
- **D12-I03**. Derive a display title that the user can edit without changing capture identity.
- **D12-I04**. Keep links as entered and require explicit fetching. Specify entry shortcuts and enrichment behavior through O11.

### Acceptance checks

- Capture text and a link while offline.
- Reject empty input without creating an item.
- Edit a derived title and preserve the capture identity.
- Paste a link and verify no page fetch occurs automatically.

### Related decision topics

- O11 · Capture interactions (resolved)

## D13 · Retain resumable conversations locally

Status is accepted.

User approval for Q13 was “Yes to all” Scope is Round covering Q5–Q13

### Accepted decision

- Automatically retain chat history locally so conversations can resume after app closure.
- Retain messages and source/brief revisions used by each turn.
- Show interrupted replies as interrupted.
- Allow deleting a conversation independently of saved ideas.
- Vault idea notes continue to require explicit saving.

Local history reduces lost thinking and supports finding prior exploration.

### Alternatives considered

- **Discard chats after closing**. Benefits include Less retained local data. Costs include Loses context and unsaved thinking. Not selected for the initial workflow.
- **Save each conversation as an idea note**. Benefits include Easy vault discovery. Costs include Blurs exploratory dialogue and deliberately saved ideas. Not selected for the initial workflow.

### Consequences we accept

- Sensitive local history and storage growth are accepted.
- Conversation deletion has a separate lifecycle.
- Storage location, retention, and history-search behavior remain unresolved.

### Full implementation requirements for this decision

- **D13-I01**. Persist messages, per-turn context references, and turn completion/interruption state locally.
- **D13-I02**. Resume locally retained history after restart without presenting an interrupted response as complete.
- **D13-I03**. Support explicit conversation deletion without deleting independent saved ideas.
- **D13-I04**. Do not create a saved idea merely because conversation history was retained.
- **D13-I05**. Set retention, provider-side thread behavior, removed-source handling, and historical search through O12/O06.

### Acceptance checks

- Restart after a completed turn and restore the conversation with its context references.
- Restart during a reply and show its interrupted state.
- Delete a conversation and verify an explicitly saved idea remains.
- Retain a conversation without creating an idea note.

### Related decision topics

- O12 · Conversation persistence (resolved)
- O06 · Context retrieval (resolved)

## D14 · Reconcile intake on a 24-hour schedule

Status is accepted.

User approval for Q14 was “Make it some kind of cron job which checks every 24 hours. Otherwise go with the recommendation.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Check selected Reel to MD draft and optional finalized-review folders every 24 hours.
- Import eligible validated drafts and finalized reviewed material regardless of whether the user clicked Export Markdown.
- Validate artifacts before admission and persist processed identities.
- Use a scheduled reconciliation rather than continuous watching or frequent polling.

The user explicitly chose a 24-hour cron-like check while accepting the remaining intake recommendation.

### Alternatives considered

- **Continuous watching or frequent polling**. Benefits include Faster appearance of new material. Costs include More background activity and does not meet the selected cadence. Not selected.
- **Require manual Markdown download**. Benefits include Explicit user export selection. Costs include No automatic intake and no producer download receipt. Not selected.

### Consequences we accept

- Material may wait up to the next daily check.
- A supported scheduler and a missed-run policy are required.
- The initial or manual scan, closed-app behavior, and catch-up policy remain open.

### Full implementation requirements for this decision

- **D14-I01**. Configure explicit draft and optional review roots and reconcile on a persisted 24-hour schedule.
- **D14-I02**. Admit drafts only after validated readiness and reviews only after bundle validation and the applicable review policy.
- **D14-I03**. Persist artifact identities and outcomes so repeat runs do not duplicate captures or snapshots.
- **D14-I04**. Preserve the user's 24-hour cadence. Do not silently retain the earlier startup-plus-periodic recommendation. Specify scheduler registration, missed runs, overlap, first scan, and manual checks through O13.

### Acceptance checks

- With a controlled clock, verify scheduled checks are 24 hours apart under the selected scheduling policy.
- An eligible artifact is imported on a scheduled run without requiring browser download.
- Repeat a reconciliation without duplicate captures or snapshots.
- Invalid or partially written artifacts remain outside successful imports.

### Related decision topics

- O01 · Import eligibility and contract (resolved)
- O13 · 24-hour local scheduling (resolved)

## D15 · Group identical source bytes and prefer reviewed revisions

Status is accepted.

User approval for Q15 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Identical source-video bytes normally map to one capture using the source hash to connect processing attempts.
- Keep each accepted revision.
- Reviewed current material is not automatically replaced by a later unreviewed draft.
- Resolve competing reviewed revisions explicitly when their relationship is ambiguous.
- Different video bytes start separate captures unless the user explicitly links them. Different processing settings remain revision history.

A conservative identity policy avoids accidental merges and preserves reviewed context.

### Alternatives considered

- **Use paths as logical identity**. Benefits include Easy to implement. Costs include Moves and copies can duplicate a source. Not selected.
- **Always use the newest timestamp**. Benefits include Simple precedence. Costs include A draft or ambiguous finalization can replace reviewed material. Not selected.
- **Automatically merge similar videos**. Benefits include Fewer duplicate-looking captures. Costs include Can merge distinct clips without evidence. Not selected.

### Consequences we accept

- Re-encoded or edited copies may need manual linking.
- Ambiguous reviewed revisions require user resolution.
- Source hashes identify identical bytes, not semantic equivalence.

### Full implementation requirements for this decision

- **D15-I01**. Map processing attempts to capture identity using verified source hashes when available.
- **D15-I02**. Record attempts and finalizations as distinct revision identities while applying reviewed-over-draft precedence.
- **D15-I03**. Detect ambiguous reviewed successors and request an explicit current revision choice without discarding either revision.
- **D15-I04**. Require explicit user linking for different source bytes. Define missing hashes, manual linking, and legacy artifacts through O01.

### Acceptance checks

- Reprocess identical video bytes under a different configuration and retain one capture with revision history.
- Import a draft after a reviewed revision and preserve the reviewed current revision.
- Import competing reviewed revisions and preserve both pending a user choice.
- Import re-encoded bytes as a separate capture until explicitly linked.

### Related decision topics

- O01 · Import eligibility and contract (resolved)
- O07 · Managed note conflicts (resolved)

## D16 · Limit automatic discovery to Companion-managed material

Status is accepted.

User approval for Q16 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Automatic context discovery initially searches Companion-managed captures, annotations, saved ideas, and approved project briefs.
- Other vault notes become sources only through explicit inclusion.
- Selecting a vault does not enroll every personal note in automatic discovery.

An explicit corpus boundary makes discovery understandable and limits accidental inclusion.

### Alternatives considered

- **Automatically index the whole selected vault**. Benefits include Finds more existing material. Costs include Enrolls personal notes without a separate selection. Not selected.
- **Require manual source selection for every turn**. Benefits include Maximum immediate source control. Costs include More repeated work and weaker automatic discovery. Not selected.

### Consequences we accept

- Existing Obsidian notes may remain undiscovered until included.
- Retrieval methods, bounds, and inclusion lifecycle still need definition.

### Full implementation requirements for this decision

- **D16-I01**. Maintain an explicit eligible corpus based on managed artifact types and separately included vault notes.
- **D16-I02**. Exclude unapproved brief drafts and unselected personal notes from automatic discovery.
- **D16-I03**. Provide an explicit action to include another vault note as a source.
- **D16-I04**. Apply eligibility before ranking and context assembly. Define index, ranking, and historical search through O06.

### Acceptance checks

- Search for a phrase present only in an unselected vault note and verify it is absent from automatic discovery.
- Include that note and verify it can be discovered.
- Verify approved briefs are eligible and unapproved refresh drafts are excluded.

### Related decision topics

- O06 · Context retrieval (resolved)
- O09 · Vault layout and identity (resolved)

## D17 · Store conversation history in local application data

Status is accepted.

User approval for Q17 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Keep resumable conversation history in a separate local application-data store.
- Provide explicit transcript export to the vault.
- Keep deliberately saved ideas, approved briefs, and evidence snapshots in the vault.
- Show the conversation history location and provide export.

Separate chat state keeps exploratory dialogue from cluttering the vault.

### Alternatives considered

- **Store all chat state in the vault**. Benefits include Vault backups include chats. Costs include More conversational files and accidental search clutter. Not selected.
- **Retain chats only in memory**. Benefits include No local history store. Costs include Cannot resume after closing. Not selected.

### Consequences we accept

- Vault backup alone does not back up conversations.
- Application-data backup and provider-session behavior remain unresolved.

### Full implementation requirements for this decision

- **D17-I01**. Persist resumable chat state in a local application-data location and expose that location to the user.
- **D17-I02**. Keep deliberate idea-note saving independent from chat persistence.
- **D17-I03**. Offer explicit transcript export to a chosen vault destination.
- **D17-I04**. Define application-data backup/restore, storage format, provider histories, and removed-source behavior through O12.

### Acceptance checks

- Resume a conversation from the application-data store after restart.
- Verify normal conversation persistence does not create a vault transcript.
- Explicitly export a transcript and open it in the vault.
- Deleting a chat leaves independent saved ideas intact.

### Related decision topics

- O12 · Conversation persistence (resolved)

## D18 · Retain material until explicit deletion and warn about dependencies

Status is accepted.

User approval for Q18 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Retain notes, snapshots, and conversations until explicitly deleted. Start without automatic expiry.
- Warn before deleting evidence used by saved ideas or conversations and identify affected artifacts.
- Offer cancellation or deliberate deletion with broken-reference warnings preserved.
- Conversation deletion leaves independently saved ideas intact.
- Removing a capture suppresses automatic re-import until explicitly restored.

Explicit deletion preserves recoverability and traceability while allowing deliberate cleanup.

### Alternatives considered

- **Expire retained material automatically**. Benefits include Bounds storage growth. Costs include Can remove needed historical evidence. Not selected.
- **Delete without dependency inspection**. Benefits include Fewer interactions. Costs include Silently breaks evidence links. Not selected.
- **Re-import every removed source on the next scan**. Benefits include Simple reconciliation. Costs include Undoes the user's removal. Not selected.

### Consequences we accept

- Storage grows until the user performs cleanup.
- Intentional deletion can leave explicitly marked broken references.
- Suppression records and their restoration need lifecycle rules.

### Full implementation requirements for this decision

- **D18-I01**. Apply no automatic expiry to retained notes, snapshots, and conversations.
- **D18-I02**. Inspect dependencies and show affected items before deleting referenced evidence. Preserve missing-evidence markers in dependents when deletion is confirmed.
- **D18-I03**. Treat conversation deletion independently from saved ideas.
- **D18-I04**. Persist capture suppression so scheduled scans do not recreate removed captures until explicit restoration.
- **D18-I05**. Define external Obsidian deletion, deletion scope, removal of stored excerpts, backups, and restoration behavior through O02/O07/O12.

### Acceptance checks

- Advance time and verify retained material does not expire automatically.
- Cancel deletion after a dependency warning and verify all artifacts remain.
- Confirm deletion and show broken-reference warnings in affected items.
- Remove a capture and reconcile without recreating it; restore explicitly and allow intake.
- Delete a conversation while preserving saved ideas.

### Related decision topics

- O02 · Evidence history (resolved)
- O07 · Managed note conflicts (resolved)
- O12 · Conversation persistence (resolved)

## D19 · Separate completeness, uncertainty, and human review judgments

Status is accepted.

User approval for Q19 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Show processing completeness, extraction uncertainty, and human review as separate fields.
- Preserve actual human review decisions and available claim-level findings.
- Make rejected reviews visible against the existing capture and exclude rejected material from automatic supporting evidence.
- Prompt review of ideas that depend on rejected material.

Separate judgments avoid a misleading single trust badge.

### Alternatives considered

- **Use one reviewed/unreviewed badge**. Benefits include Simple display. Costs include Conflates completeness, extraction quality, and human findings. Not selected.
- **Hide rejected reviews**. Benefits include Cleaner inbox. Costs include Obscures evidence changes affecting existing ideas. Not selected.

### Consequences we accept

- Status display is more detailed.
- Dependent ideas need explicit handling when support is later rejected.

### Full implementation requirements for this decision

- **D19-I01**. Carry independent processing, extraction, and human-review fields through capture storage, display, snapshots, and context assembly.
- **D19-I02**. Show available claim-level findings when inspecting evidence.
- **D19-I03**. Record rejection metadata against the associated capture even though a rejection bundle has no reviewed Markdown export.
- **D19-I04**. Exclude rejected support from automatic evidence selection and flag dependent ideas for review without silently rewriting them.
- **D19-I05**. Map producer fields faithfully without claiming that acceptance proves every claim. Define unknown/legacy mappings and historical-use behavior through O08.

### Acceptance checks

- Display a partial capture with uncertain extraction and an accepted-with-edits review without collapsing the judgments.
- Import rejection metadata, inspect it against the capture, and exclude the rejected evidence from automatic selection.
- Flag an existing dependent idea without deleting or rewriting it.
- Retain claim-level findings when present.

### Related decision topics

- O08 · Review semantics (resolved)
- O06 · Context retrieval (resolved)

## D20 · Start the MyTune brief from the current README

Status is accepted.

User approval for Q20 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Start the first MyTune brief from the current README.
- Add other documents through explicit source selection.
- Cover purpose, current behavior, constraints, known limitations, and questions worth exploring with selected-passage references.
- Mark missing information explicitly.
- If a selected document disappears, retain the approved brief, mark it outdated, and resolve the source issue before approving a refresh.

A small inspectable source set gives the first brief a clear basis.

### Alternatives considered

- **Read all project files automatically**. Benefits include Broader context. Costs include Larger scope and less inspectable selection. Not selected.
- **Write a brief without source references**. Benefits include Fast initial draft. Costs include Weak grounding and harder refresh review. Not selected.

### Consequences we accept

- Undocumented behavior and information in unselected files remain absent.
- Missing documents can block approval of a refresh.

### Full implementation requirements for this decision

- **D20-I01**. Select the current MyTune README as the initial source and record its version.
- **D20-I02**. Generate the specified brief sections with passage references and explicit gaps.
- **D20-I03**. Require explicit selection for additional documents and approval under D08 for a refreshed brief.
- **D20-I04**. Retain and mark the approved brief outdated when a source is missing; block approval of a refresh until the source issue is resolved.
- **D20-I05**. Define size limits, refresh errors, and context excerpt selection through O04/O06.

### Acceptance checks

- Generate the initial brief from the README and inspect references for each supported section.
- Verify unselected documents are not silently incorporated.
- Remove a selected input and retain the outdated approved brief while blocking refresh approval.
- Add another document explicitly and approve a new brief version.

### Related decision topics

- O04 · Project brief lifecycle (resolved)
- O06 · Context retrieval (resolved)

## D21 · Compare three cases with hidden method labels

Status is accepted.

User approval for Q21 was “For all the other questions go with the recommendations.” Scope is Q14–Q21, with modified Q14 cadence.

### Accepted decision

- Use three initial comparison cases covering plausible transfer, weak connection, and misleading analogy.
- Use the same inputs and model for both methods and one final candidate per method per case.
- Record differences in generation effort.
- Hide method labels and shuffle presentation for scoring usefulness, surprise, grounding, and ease of testing.
- Review every result rather than selecting only impressive examples.
- Use exploratory results to guide improvements without a numerical release threshold yet.

A small comparison can probe useful connections and resistance to unsupported analogies.

### Alternatives considered

- **Show one successful demonstration**. Benefits include Low evaluation effort. Costs include Selects for an impressive result without probing failure. Not selected.
- **Run a formal repeated benchmark immediately**. Benefits include Stronger evidence. Costs include More materials, scoring, and repeated-run cost before first use. Not selected.
- **Show method labels while rating**. Benefits include Simpler evaluation display. Costs include Invites expectation bias. Not selected.

### Consequences we accept

- Three cases provide exploratory evidence with substantial uncertainty.
- Material selection and scoring anchors still need decisions.

### Full implementation requirements for this decision

- **D21-I01**. Prepare three identifiable cases covering the specified fit conditions with identical source/project context across paired methods.
- **D21-I02**. Produce one final candidate per method per case using the same recorded model. Retain every output, failure, prompt, and generation-effort difference.
- **D21-I03**. Present paired results with hidden method labels and shuffled order while preserving a private method mapping.
- **D21-I04**. Collect the four ratings for every result and inspect shortcomings without applying an unselected numerical gate.
- **D21-I05**. Choose the actual materials, rubric anchors, prompts, and budget tolerance through O05.

### Acceptance checks

- Verify three cases and six final output slots, including recorded failures rather than selective omission.
- Verify matched inputs/model and retained generation-effort differences.
- Score shuffled unlabeled outputs and recover the method mapping afterward.
- Inspect all results, including the misleading analogy case.

### Related decision topics

- O05 · Comparison protocol (resolved)

## D22 · Run a per-user worker on a fixed 24-hour schedule

Status is accepted.

User approval for Q22 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- A per-user Windows scheduled task launches a small intake worker every 24 elapsed hours anchored to setup time.
- Run while the Windows account is signed in, including when the Companion window is closed.
- Show schedule, last successful check, and latest error. Provide pause and disable controls.

A Windows scheduled worker meets the chosen cadence without requiring an open application window.

### Alternatives considered

- **Require the application window to stay open**. Benefits include Simpler process lifecycle. Costs include Intake stops when the window closes. Not selected.
- **Daily local clock-time trigger**. Benefits include Stable visible time of day. Costs include Does not always represent 24 elapsed hours. Not selected.
- **Run while signed out**. Benefits include More availability. Costs include Requires a different credential and access design. Not selected.

### Consequences we accept

- Intake waits while the user is signed out.
- The local clock time may shift at daylight-saving transitions.

### Full implementation requirements for this decision

- **D22-I01**. Register an identifiable per-user task only as part of authorized intake setup, using the signed-in user context and a fixed 24-hour repetition anchor.
- **D22-I02**. Launch a worker independently from the UI and expose schedule, last success, latest error, and pause/disable state.
- **D22-I03**. Preserve the anchor across normal runs and manual checks. Define task repair and cleanup as part of scheduler lifecycle implementation.
- **D22-I04**. Verify actual Windows behavior, permissions, and source access before declaring scheduling ready.

### Acceptance checks

- Close the UI while signed in and verify a scheduled worker can run.
- Verify fixed 24-hour scheduling rather than a daily local clock trigger.
- Pause or disable the task and verify automatic checks stop.
- Inspect visible last-success/error state.

### Related decision topics

- O13 · 24-hour local scheduling (resolved)

## D23 · Catch up missed checks without waking the PC

Status is accepted.

User approval for Q23 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- Run a missed check when the PC next becomes available without intentionally waking it.
- Perform one catch-up reconciliation for accumulated changes and preserve the original schedule anchor.
- Prevent overlapping workers.
- If a source folder is unavailable, report the failure and preserve existing captures.

Catch-up supports daily intake without deliberately interrupting sleep.

### Alternatives considered

- **Wake the PC for every scheduled run**. Benefits include Closer to the planned time. Costs include Interrupts sleep and depends on power policy. Not selected.
- **Replay every missed run separately**. Benefits include Preserves nominal run count. Costs include Repeated scans add work without improving reconciliation. Not selected.

### Consequences we accept

- Execution after sleep or sign-out is eventual.
- Missed-run timing must be verified on the user's PC.

### Full implementation requirements for this decision

- **D23-I01**. Configure missed-run catch-up without enabling intentional wake.
- **D23-I02**. Coalesce missed intervals into one reconciliation and leave the original trigger cadence intact.
- **D23-I03**. Use a common application-level lock for scheduled, catch-up, initial, and manual workers; do not run imports concurrently.
- **D23-I04**. Treat missing roots as visible failures without interpreting them as source deletions or deleting existing captures.

### Acceptance checks

- Miss several intervals and perform one catch-up scan on availability.
- Verify sleep is not intentionally interrupted.
- Attempt concurrent manual and scheduled runs and verify one active reconciliation.
- Disconnect a source root and preserve imported notes while recording the error.

### Related decision topics

- O13 · 24-hour local scheduling (resolved)

## D24 · Offer explicit first and manual intake checks

Status is accepted.

User approval for Q24 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- Offer an immediate first scan when connecting an intake folder.
- Provide a Check now action.
- Use the same validation and deduplication rules for manual checks.
- Manual checks do not reset the automatic schedule.
- Opening Companion alone does not trigger an extra intake scan unless a scheduled check is overdue.

Explicit checks support setup testing and timely use without changing the daily background cadence.

### Alternatives considered

- **Wait for the first scheduled interval**. Benefits include Strictly scheduled-only behavior. Costs include Delays setup feedback and immediate use. Not selected.
- **Scan on every application launch**. Benefits include Fresh launch-time intake. Costs include Adds automatic scans outside the accepted cadence. Not selected.

### Consequences we accept

- Initial and manual scans are deliberate exceptions to the automatic schedule.
- Worker overlap still needs prevention.

### Full implementation requirements for this decision

- **D24-I01**. Offer but do not silently force a first scan during folder connection.
- **D24-I02**. Expose Check now and route it through the shared worker, lock, validation, and import ledger.
- **D24-I03**. Keep manual runs independent from the recurring task anchor.
- **D24-I04**. On UI launch, show intake state; initiate catch-up only when due under the scheduled policy.

### Acceptance checks

- Accept the first-scan offer and import eligible material.
- Decline the offer and retain the scheduled scan.
- Use Check now and verify the next automatic run is unchanged.
- Open the UI before the next due time and verify no extra intake scan occurs.

### Related decision topics

- O13 · 24-hour local scheduling (resolved)

## D25 · Start with inspectable local text retrieval

Status is accepted.

User approval for Q25 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- Initial discovery uses local text search, source links, and project associations.
- Show candidate passages and why they matched before sending.
- Allow adding or removing sources.
- Historical conversation search is an explicit option for prior-exploration questions.
- Evaluate retrieval with relevant material expressed using different vocabulary.

An inspectable retrieval baseline helps distinguish context-selection errors from reasoning errors.

### Alternatives considered

- **Start with semantic/vector retrieval**. Benefits include Can match across vocabulary differences. Costs include Adds indexing and evaluation complexity. Not selected.
- **Automatically include all prior conversations**. Benefits include Broader apparent memory. Costs include Can include unwanted context without a targeted history search. Not selected.

### Consequences we accept

- Text retrieval may miss relevant paraphrases.
- Candidate ranking, context bounds, and historical search behavior still need specification.

### Full implementation requirements for this decision

- **D25-I01**. Search only the eligible corpus established by D16 and apply rejected-evidence exclusion before ranking.
- **D25-I02**. Rank local text matches with links and project associations, and show matching passages with reasons.
- **D25-I03**. Support explicit addition/removal before the outgoing context package is sent.
- **D25-I04**. Keep history search opt-in for a request and label conversation excerpts as historical dialogue.
- **D25-I05**. Evaluate exact matches, paraphrased relevant material, no-match cases, stale references, and removed sources.

### Acceptance checks

- Inspect candidate text matches and reasons before sending.
- Add a source and remove a candidate, then inspect the outgoing package.
- Keep unrelated conversation history out unless historical search is requested.
- Measure misses on relevant differently worded material without hiding the limitation.

### Related decision topics

- O06 · Context retrieval (resolved)
- O03 · Codex connection and data boundary (resolved)

## D26 · Default capture deletion to current content and revision history

Status is accepted.

User approval for Q26 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- Deleting a capture offers a clear scope with the capture and all retained revisions selected together by default.
- Show affected annotations, ideas, and conversations before confirmation.
- Preserve independent dependent artifacts, mark missing references, and suppress re-import.
- Deleting annotations or ideas requires separate explicit choices.
- Dependent writing may retain quotations; erasing those copies requires a separately scoped action.

A clear deletion scope avoids unexpectedly retaining a complete source history.

### Alternatives considered

- **Delete the current note only by default**. Benefits include Less disruption to historical citations. Costs include Leaves full source text in retained revisions. Not selected.
- **Cascade-delete every dependent artifact**. Benefits include Removes more derived content. Costs include Can destroy independently useful user writing. Not selected.

### Consequences we accept

- Dependent writing can retain quoted source text.
- Default deletion breaks references deliberately after the dependency preview.
- Removal of quoted copies is a separate choice.

### Full implementation requirements for this decision

- **D26-I01**. Build a deletion preview with current capture, all snapshots, affected dependents, and re-import suppression.
- **D26-I02**. Select the capture and all retained revisions by default and require confirmation of the displayed scope.
- **D26-I03**. Preserve independent annotations, ideas, and conversations, mark their broken references, and retain suppression until restoration.
- **D26-I04**. Keep deletion of independent artifacts and erasure of embedded quotations as separately scoped actions. Define these workflows through O02/O12.

### Acceptance checks

- Delete with default scope and remove current capture plus all snapshots.
- Verify independent notes and conversations remain with missing-reference warnings.
- Reconcile and verify the capture does not return.
- Cancel the preview and verify no content or suppression state changes.

### Related decision topics

- O02 · Evidence history (resolved)
- O07 · Managed note conflicts (resolved)
- O12 · Conversation persistence (resolved)

## D27 · Use current PC timezone for calendar views

Status is accepted.

User approval for Q27 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- Today uses the PC's current local timezone and local midnight boundaries.
- Store capture timestamps as absolute instants.
- Changing timezone can regroup captures by day without changing their stored capture instants.
- Show the timezone in date-sensitive views.
- Old source publication dates never backdate arrival in Companion.

Calendar views follow the PC's local settings while preserving capture chronology.

### Alternatives considered

- **Freeze the timezone at setup**. Benefits include Stable historical day grouping. Costs include Calendar views can diverge from current local time. Not selected.
- **Store local timestamps without an absolute instant**. Benefits include Simple display. Costs include Ambiguous chronology around timezone and daylight-saving changes. Not selected.

### Consequences we accept

- Historical day groupings can shift during travel.

### Full implementation requirements for this decision

- **D27-I01**. Persist an absolute initial capture instant and keep source occurrence and revision instants separate.
- **D27-I02**. Compute Today with the current PC timezone and its local midnight boundaries.
- **D27-I03**. Show the timezone where date grouping matters and refresh grouping when the timezone changes.
- **D27-I04**. Preserve the capture instant during updates, travel, and imported old source dates.

### Acceptance checks

- Test near-midnight captures across a timezone change and preserve absolute timestamps.
- Test daylight-saving day boundaries where applicable.
- Import old material and show it by its actual arrival date.
- Update a capture and preserve its original capture instant.

### Related decision topics

- O10 · Today semantics (resolved)

## D28 · Use authored comparison fixtures and a separate real import smoke test

Status is accepted.

User approval for Q28 was “Yes to all recommendations” Scope is Q22–Q28

### Accepted decision

- Use clearly labeled authored fixtures for plausible transfer, weak connection, and misleading analogy against the same MyTune brief.
- Give fixtures inspectable source passages and known limitations.
- Follow the fixture comparison with a separate real Reel to MD smoke test of the complete handoff.
- Distinguish synthetic fixture results from real imported material.

Fixtures make the early comparison repeatable before suitable reviewed reel material is available.

### Alternatives considered

- **Require real reviewed reels for every initial case**. Benefits include More realistic early inputs. Costs include Depends on suitable material and completed reviews. Not selected.
- **Use only fixtures including handoff validation**. Benefits include Repeatable and easy to control. Costs include Does not prove real producer integration. Not selected.

### Consequences we accept

- Fixture results provide limited evidence about messy real captures.
- The real smoke test establishes handoff feasibility separately from comparison quality.

### Full implementation requirements for this decision

- **D28-I01**. Author three versioned, explicitly synthetic fixture cases with inspectable source passages, limitations, and the same pinned MyTune brief.
- **D28-I02**. Run both methods on each fixture under D21 and label all recorded results as synthetic.
- **D28-I03**. Run a separately identified real Reel to MD import-to-saved-proposal smoke test with actual producer artifacts.
- **D28-I04**. Keep fixture and real-source evidence separate in reports and do not present authored fixtures as real reels.

### Acceptance checks

- Inspect all fixture labels, passages, limitations, and brief versions.
- Verify comparison records identify synthetic material.
- Complete the real producer handoff separately and retain its outcome.
- Verify reports do not conflate fixture quality with real-source reliability.

### Related decision topics

- O05 · Comparison protocol (resolved)

## D29 · Hold unsupported or ambiguous imports for resolution

Status is accepted.

User approval for Q29 was “Yes to all recommendations. Once you're done with the grilling session, go ahead and start the to Spec skill.” Scope is Q29–Q34; to-spec authorized after grilling completion.

### Accepted decision

- Hold an import for inspection when identity cannot be established, structure cannot be validated, or the current reviewed revision cannot be determined.
- Show the artifact, reason, and resolution action.
- Continue independent valid imports.
- Never infer identity from a filename alone.

Conservative admission avoids accidental merging and false success.

### Alternatives considered

- **Best-effort admission from filenames**. Benefits include More legacy inputs appear automatically. Costs include Can merge unrelated material or misstate success. Not selected.

### Consequences we accept

- Some legacy exports require manual identification or a fresh producer export.

### Full implementation requirements for this decision

- **D29-I01**. Validate identity, structure, and revision precedence before publication.
- **D29-I02**. Persist held-import reasons and expose a resolution action without modifying original producer artifacts.
- **D29-I03**. Continue independent items and retry a held item only after the relevant issue is resolved or on a later eligible check without duplicating successful imports.
- **D29-I04**. Require explicit identity resolution rather than a filename-based guess.

### Acceptance checks

- Missing identity is held with an actionable reason.
- Invalid structure and competing reviewed revisions remain inspectable.
- A valid unrelated item imports successfully in the same run.

### Related decision topics

- O01 · Import eligibility and contract (resolved)
- O08 · Review semantics (resolved)

## D30 · Resolve external identity and missing-note issues explicitly

Status is accepted.

User approval for Q30 was “Yes to all recommendations. Once you're done with the grilling session, go ahead and start the to Spec skill.” Scope is Q29–Q34; to-spec authorized after grilling completion.

### Accepted decision

- Detect note moves by stable identity and repair links after a verified move.
- Missing or duplicated identities require resolution.
- Mark a disappeared managed note missing and pause its automatic updates until the user restores it or confirms removal.
- Preserve both notes if they claim the same identity and ask which is authoritative.
- Treat an unavailable vault or disconnected drive as an access failure rather than many deleted notes.

Explicit repair preserves user content and distinguishes relocation from deletion.

### Alternatives considered

- **Automatically recreate every missing note**. Benefits include Fast apparent recovery. Costs include Undoes intentional external removal. Not selected.
- **Choose one duplicate identity automatically**. Benefits include Less repair work. Costs include Can overwrite the authoritative user content. Not selected.

### Consequences we accept

- Copied, deleted, or metadata-edited notes can require repair.

### Full implementation requirements for this decision

- **D30-I01**. Reconcile known identities against accessible vault files and distinguish verified moves, missing notes, duplicated identities, and unreadable roots.
- **D30-I02**. Repair known relationships after a verified move without changing item identity.
- **D30-I03**. Pause updates to missing managed notes and preserve existing metadata/history pending explicit restore or confirmed removal.
- **D30-I04**. Preserve identity collisions for explicit resolution without overwriting either note.
- **D30-I05**. Do not infer per-note deletion from a root access failure.

### Acceptance checks

- Move a note and repair its links by verified identity.
- Copy an identity and preserve both notes pending resolution.
- Delete a managed note externally and pause its updates.
- Disconnect the vault and report one access failure without deleting notes or suppression records.

### Related decision topics

- O07 · Managed note conflicts (resolved)
- O09 · Vault layout and identity (resolved)

## D31 · Require explicit retry for failed or interrupted agent requests

Status is accepted.

User approval for Q31 was “Yes to all recommendations. Once you're done with the grilling session, go ahead and start the to Spec skill.” Scope is Q29–Q34; to-spec authorized after grilling completion.

### Accepted decision

- Keep failed or interrupted requests visible.
- Require explicit retry and do not automatically replay requests after reconnection.
- Preserve the question, selected context, and any partial reply.
- Label partial replies incomplete and allow retry or editing.
- Keep note saving independent from request recovery.

Explicit retry avoids unexpected repeated generation and usage.

### Alternatives considered

- **Automatically replay after reconnection**. Benefits include Less user effort after an outage. Costs include Can duplicate generation and consume unexpected usage. Not selected.

### Consequences we accept

- Recovery after an outage takes another user action.

### Full implementation requirements for this decision

- **D31-I01**. Persist request input, selected context references, partial output, and terminal failure/interruption state.
- **D31-I02**. Never automatically replay a failed or interrupted user turn after reconnection or restart.
- **D31-I03**. Offer explicit retry or edit with inspectable context and a distinct request identity.
- **D31-I04**. Keep capture/import available and keep existing note writes independent from agent request failure.

### Acceptance checks

- Interrupt a turn and retain a visibly incomplete reply and its question.
- Reconnect or restart without generating another reply automatically.
- Explicitly retry and record it as a new request.
- Verify existing notes and independent capture/import remain intact.

### Related decision topics

- O03 · Codex connection and data boundary (resolved)
- O12 · Conversation persistence (resolved)

## D32 · Distinguish retrieval failure from unsupported transfer

Status is accepted.

User approval for Q32 was “Yes to all recommendations. Once you're done with the grilling session, go ahead and start the to Spec skill.” Scope is Q29–Q34; to-spec authorized after grilling completion.

### Accepted decision

- Distinguish no relevant retrieved material from retrieved material with no useful project connection.
- For empty retrieval, offer manual source selection or another search.
- For an unsupported transfer, explain where the proposed mechanism breaks.
- Brainstorm beyond supplied evidence only when explicitly requested and label it accordingly.

Separate outcomes make context-selection failures distinguishable from reasoning outcomes.

### Alternatives considered

- **Always produce an idea**. Benefits include Consistent apparent productivity. Costs include Hides missing evidence and weak connections. Not selected.

### Consequences we accept

- The assistant sometimes needs better material before it can produce an idea.

### Full implementation requirements for this decision

- **D32-I01**. Expose separate no-relevant-context and no-supported-connection outcomes.
- **D32-I02**. Offer source selection or re-search on missing context without inventing evidence.
- **D32-I03**. Explain unsupported transfer mechanisms against the available material.
- **D32-I04**. Require an explicit beyond-evidence request and label resulting suggestions as speculative without invented citations.

### Acceptance checks

- An empty search offers sources or a new search.
- A misleading analogy explains its broken mechanism.
- Ordinary grounded mode does not invent a supporting source.
- Explicit speculative mode remains labeled and traceable.

### Related decision topics

- O06 · Context retrieval (resolved)
- O05 · Comparison protocol (resolved)

## D33 · Enrich links with user-pasted excerpts first

Status is accepted.

User approval for Q33 was “Yes to all recommendations. Once you're done with the grilling session, go ahead and start the to Spec skill.” Scope is Q29–Q34; to-spec authorized after grilling completion.

### Accepted decision

- First-release link enrichment accepts explicitly pasted relevant excerpts and preserves the source URL.
- Store excerpts as user-supplied material linked to the original capture.
- Do not imply that Companion checked the page.
- Defer general-purpose webpage fetching.

Manual excerpts give predictable enrichment without broad webpage ingestion.

### Alternatives considered

- **Fetch arbitrary webpages in the initial release**. Benefits include Less manual copying. Costs include Adds parsing, authentication, and dynamic-page handling. Not selected.

### Consequences we accept

- The user supplies the excerpt.
- The application cannot claim it verified the excerpt against the webpage.
- This narrows the previously open fetching feature.

### Full implementation requirements for this decision

- **D33-I01**. Provide an explicit excerpt-entry action on a link capture and retain the supplied URL.
- **D33-I02**. Record user-supplied provenance separately from verified imports and preserve the original entered link.
- **D33-I03**. Include pasted text in local discovery with its provenance and limitations.
- **D33-I04**. Do not automatically fetch pasted links; keep general-purpose fetching outside first-release scope.

### Acceptance checks

- Paste an excerpt, retain its URL, and find its text through local discovery.
- Inspect provenance and verify no page-verification claim appears.
- Capture and enrich a link without fetching the page.

### Related decision topics

- O11 · Capture interactions (resolved)
- O08 · Review semantics (resolved)

## D34 · Score four dimensions separately with material-error flags

Status is accepted.

User approval for Q34 was “Yes to all recommendations. Once you're done with the grilling session, go ahead and start the to Spec skill.” Scope is Q29–Q34; to-spec authorized after grilling completion.

### Accepted decision

- Score each comparison output from 1 to 5 separately on usefulness, surprise, grounding, and ease of testing.
- Record a short reason and a material-error flag.
- Usefulness concerns a concrete MyTune decision; surprise concerns a non-obvious connection; grounding concerns supplied claims and mechanism; ease concerns a small test and observable result.
- Use 1 for poor, 3 for mixed, and 5 for strong, with written examples in the evaluation guide.
- Keep dimensions separate and flag unsupported claims or broken analogies even if the idea is surprising.

Separate ratings expose trade-offs between novelty, support, and practicality.

### Alternatives considered

- **Use one overall creativity score**. Benefits include Faster scoring. Costs include Can hide unsupported novelty or impractical ideas. Not selected.

### Consequences we accept

- Ratings are subjective and need short written justification.

### Full implementation requirements for this decision

- **D34-I01**. Record four independent integer ratings from 1 through 5, explanatory text, and material-error status per output.
- **D34-I02**. Define the accepted dimensions and anchor examples in the evaluation materials.
- **D34-I03**. Score every output with hidden method labels under D21 and retain the mapping for later inspection.
- **D34-I04**. Keep errors visible alongside scores and do not convert ratings into an unapproved numeric release gate.

### Acceptance checks

- Record independent ratings, a reason, and an error flag for each output.
- Reject scores outside the scale.
- Keep a highly surprising but unsupported result visibly flagged.
- Inspect all dimension scores without replacing them with a hidden composite.

### Related decision topics

- O05 · Comparison protocol (resolved)

## D35 · Use managed Codex App Server with isolated fresh-turn threads

Status is accepted.

User approval for Q35 was “Yes to all recommendations.” Scope is Q35–Q40, including shared understanding and test-seam confirmation.

### Accepted decision

- Use local Codex App Server and reuse its managed sign-in.
- Create a fresh model thread for each Companion turn and supply selected history and excerpts explicitly.
- Use an isolated working directory and controlled configuration with vault/project reads and unselected tools disabled.
- Enable chat only after a successful Windows isolation check. Otherwise show incomplete chat setup and preserve capture/import.

Fresh-turn assembly makes subsequent context control enforceable without relying on resumed provider history.

### Alternatives considered

- **Resume a model thread containing previous context**. Benefits include Less repeated input. Costs include Removed material can remain in implicit history. Not selected.
- **Assume default read-only configuration is isolated**. Benefits include Simpler setup. Costs include Default reads and injected context may exceed the boundary. Not selected.

### Consequences we accept

- Context is submitted repeatedly.
- Integration setup needs effective access verification on the installed version.
- Documentation alone does not establish working Windows isolation.

### Full implementation requirements for this decision

- **D35-I01**. Authenticate through managed App Server account state without scraping desktop tokens or exporting credentials.
- **D35-I02**. Use a new model thread per app turn and reconstruct only the approved context, including allowed local history.
- **D35-I03**. Control working directory, read roots, tools, connectors, hooks, instructions, and memories to prevent unselected content access or injection.
- **D35-I04**. Gate chat readiness on a real successful signed-in interaction and denied reads of known vault/project canaries under the effective Windows configuration.
- **D35-I05**. Expose setup and authentication failures while preserving local capture/import; never silently widen permissions to make the gate pass.

### Acceptance checks

- Reuse account sign-in across fresh threads without resuming hidden history.
- Verify known outside-context canaries cannot be read.
- Inspect effective configuration and a real outgoing context package.
- Fail chat readiness safely when isolation cannot be enforced.

### Related decision topics

- O03 · Codex connection and data boundary (resolved)

## D36 · Bound the inspectable context package at 32000 characters

Status is accepted.

User approval for Q36 was “Yes to all recommendations.” Scope is Q35–Q40, including shared understanding and test-seam confirmation.

### Accepted decision

- The initial application context package limit is 32,000 characters.
- Count the question, selected history, project brief, and excerpts.
- Preview included passages and proposed shortening.
- Require removal or explicit approval of a shorter selection before sending an oversized package.
- Use a stricter limit if required by verified model support. Keep character limits distinct from model token usage and billing.

A reviewable bound keeps request assembly explicit.

### Alternatives considered

- **Silently truncate selected material**. Benefits include Fewer interruptions. Costs include Can drop decisive evidence without review. Not selected.
- **Send unbounded context**. Benefits include Less manual selection. Costs include Harder to inspect and incompatible with finite model limits. Not selected.

### Consequences we accept

- Long conversations may need context editing.
- The initial product default may be revised based on observed workflows.

### Full implementation requirements for this decision

- **D36-I01**. Compute a deterministic character count over the application package using a documented convention.
- **D36-I02**. Display package count, limit, included passages, and proposed reductions before dispatch.
- **D36-I03**. Reject an oversized package until the user removes material or approves a smaller selection; do not silently drop selected evidence.
- **D36-I04**. Reserve room separately for harness instructions, reasoning, and output under the verified integration. Enforce any stricter supported input bound and record actual usage where available.

### Acceptance checks

- Send a package exactly at the application limit and block one above it.
- Require approval for proposed shortening.
- Verify removed history is absent from the dispatched package.
- Exercise a stricter verified model limit without claiming a billing cap.

### Related decision topics

- O03 · Codex connection and data boundary (resolved)
- O04 · Project brief lifecycle (resolved)
- O06 · Context retrieval (resolved)

## D37 · Exclude removed-source derivatives from subsequent requests

Status is accepted.

User approval for Q37 was “Yes to all recommendations.” Scope is Q35–Q40, including shared understanding and test-seam confirmation.

### Accepted decision

- Removing or rejecting a source excludes history messages and summaries derived from it from subsequent context packages.
- Use recorded source dependencies and show the excluded material.
- Preserve local conversations for inspection with warnings.
- Deletion applies to the selected local data; exports, backups, and previously submitted provider records have their own lifecycle.
- Removing quoted copies from independent writing remains a separately scoped explicit action.

Source control must include derived history, not only the current excerpt list.

### Alternatives considered

- **Remove only the original excerpt**. Benefits include Retains more conversation context. Costs include History or summaries can reintroduce the source. Not selected.
- **Erase all local conversations automatically**. Benefits include Stronger local removal. Costs include Destroys unrelated historical writing. Not selected.

### Consequences we accept

- Removing a source may exclude useful history.
- Subsequent-request exclusion does not establish deletion of earlier provider submissions or separate copies.

### Full implementation requirements for this decision

- **D37-I01**. Track each turn's source dependencies and propagate them to derived messages and summaries.
- **D37-I02**. When a source is removed/rejected, invalidate affected derived context and expose exclusions in the preview.
- **D37-I03**. Send the rebuilt package in a fresh model thread so old provider-thread history cannot be implicitly resumed.
- **D37-I04**. Keep warned local history inspectable; distinguish exclusion, selected local deletion, and separately managed backups/exports.
- **D37-I05**. Offer separately scoped user selection of dependent writing to remove quoted copies without promising automatic semantic erasure.

### Acceptance checks

- Remove a source and verify its excerpt, dependent messages, and summaries are excluded from the next outgoing request.
- Reject a source and prevent it from returning through historical search or cached context.
- Inspect preserved local history with warnings.
- Verify the UI does not claim prior provider records or independent copies were erased.

### Related decision topics

- O02 · Evidence history (resolved)
- O03 · Codex connection and data boundary (resolved)
- O06 · Context retrieval (resolved)
- O08 · Review semantics (resolved)
- O12 · Conversation persistence (resolved)

## D38 · Back up local chat state and settings explicitly

Status is accepted.

User approval for Q38 was “Yes to all recommendations.” Scope is Q35–Q40, including shared understanding and test-seam confirmation.

### Accepted decision

- Provide a manual local backup archive for conversation history and application settings.
- Back up the vault separately.
- Include a vault identity manifest and exclude sign-in credentials.
- Preview conflicts before restoration and preserve existing content.
- Require explicit reconnection of the vault and scheduled task on another installation.

Manual backup makes the separate application-data store recoverable.

### Alternatives considered

- **Assume vault backup covers everything**. Benefits include Less backup UI. Costs include Loses application-data conversation history. Not selected.
- **Restore settings and scheduled jobs silently**. Benefits include Less setup work. Costs include Can bind the wrong vault or duplicate jobs. Not selected.

### Consequences we accept

- The user has another backup responsibility.
- Archives can contain sensitive conversation text.
- Existing archives persist until explicitly removed.

### Full implementation requirements for this decision

- **D38-I01**. Export app-controlled conversations, settings, and vault identity metadata to a user-selected local archive without auth credentials.
- **D38-I02**. Validate archive integrity/version and preview destination conflicts before restore.
- **D38-I03**. Preserve existing state and require explicit conflict choices; do not silently replace a vault or overwrite unrelated history.
- **D38-I04**. On another installation require explicit vault matching and scheduled-task reconnection rather than automatic task registration.
- **D38-I05**. Clearly identify the archive as separate from vault backups and apply D37 copy lifecycle disclosures.

### Acceptance checks

- Export and restore a local history archive without credentials.
- Detect a mismatched vault manifest and block silent rebinding.
- Preview conflicting histories and preserve existing content until explicit resolution.
- Restore on another installation without silently registering a scheduled task.

### Related decision topics

- O12 · Conversation persistence (resolved)
- O13 · 24-hour local scheduling (resolved)

## D39 · Use one bounded comparison turn per method and retain effort differences

Status is accepted.

User approval for Q39 was “Yes to all recommendations.” Scope is Q35–Q40, including shared understanding and test-seam confirmation.

### Accepted decision

- Each method gets one model turn per case, identical source packages and common answer requirements, and a requested final answer of up to 600 words.
- Both methods return an idea or justified abstention, citations, limitations, and a test when appropriate.
- The analogy condition additionally requests explicit source-to-project mechanism mapping. The direct condition has no analogy instruction.
- Use the same available model settings; record actual usage and elapsed time where available.
- Retain failures and do not automatically reroll. Comparable setup does not imply identical token consumption.

Single-turn paired opportunities keep the small comparison inspectable.

### Alternatives considered

- **Give analogy extra hidden model calls**. Benefits include More reasoning opportunity. Costs include Confounds the method with extra effort. Not selected.
- **Reroll weak results until useful**. Benefits include Better-looking outputs. Costs include Selectively hides failures. Not selected.

### Consequences we accept

- The experiment does not establish repeated-run reliability.
- The answer length is requested, not a proven provider output ceiling.
- Model consumption may differ despite matched setup.

### Full implementation requirements for this decision

- **D39-I01**. Version the two prompt conditions with identical grounding/output requirements and an analogy-only explicit mechanism mapping instruction.
- **D39-I02**. Use one generation turn per method/case, the same pinned model and supported settings, the same source/brief package, and the accepted application limit.
- **D39-I03**. Request a final answer up to 600 words and record deviations without selectively discarding results.
- **D39-I04**. Record prompts, source revisions, settings, outcomes, observed usage availability, and elapsed time; retain failures without automatic regeneration.
- **D39-I05**. Present results for D34 scoring without method labels and preserve the pairing/method mapping.

### Acceptance checks

- Inspect six result slots across the three cases including failures.
- Verify only the analogy condition requests mechanism mapping.
- Verify one model turn per method/case and matched source packages/settings.
- Inspect observed effort and length differences without claiming exact equal consumption.

### Related decision topics

- O05 · Comparison protocol (resolved)

## D40 · Verify the desktop/file workflow with separate real integration gates

Status is accepted.

User approval for Q40 was “Yes to all recommendations.” Scope is Q35–Q40, including shared understanding and test-seam confirmation.

### Accepted decision

- Use the desktop workflow and resulting files as the main acceptance boundary.
- Use a test vault, producer fixtures, controlled time, and simulated agent replies for repeatable checks.
- Verify capture, intake, chat, saving, conflicts, deletion, and restart through observable outcomes.
- Add real Windows scheduled-worker and signed-in Codex gates covering isolation, interruption, and failures.
- Keep the real Reel to MD smoke test separate from the synthetic comparison.
- Acceptance confirms remaining design choices and the test approach and authorizes the to-spec handoff.

The highest practical boundary validates the actual workflow while controlled dependencies keep regressions reproducible.

### Alternatives considered

- **Test only internal functions or source wiring**. Benefits include Fast and deterministic. Costs include Does not establish end-to-end user outcomes. Not selected.
- **Use live model calls for every regression**. Benefits include Real provider behavior. Costs include Slow and nonrepeatable; obscures local failures. Not selected.

### Consequences we accept

- Real integration gates require the target machine/account.
- Fixture checks do not prove live provider or scheduler behavior.

### Full implementation requirements for this decision

- **D40-I01**. Build a desktop acceptance harness over a disposable vault with injectable time, producer artifacts, and agent transport responses.
- **D40-I02**. Assert observable UI outcomes and resulting Markdown/history state through realistic failure, retry, restart, and concurrency workflows.
- **D40-I03**. Run independent real Windows scheduler, signed-in isolated Codex, and real producer handoff checks before release readiness.
- **D40-I04**. Report skipped/failed real gates explicitly; never substitute mocks for integration evidence.
- **D40-I05**. Publish the synthesized specification to the configured issue tracker after this confirmed shared understanding.

### Acceptance checks

- Complete the import-to-cited-experiment acceptance journey and open the saved note in Obsidian.
- Exercise captured edits, interrupted imports/turns, explicit retry, conflict repair, deletion/suppression, and restart.
- Verify the real scheduler with UI closed and actual effective Codex isolation.
- Keep fixture evaluation evidence and real handoff results separately identified.

### Related decision topics

- O03 · Codex connection and data boundary (resolved)
- O13 · 24-hour local scheduling (resolved)

## Interview topic status

Resolved policy still requires implementation and verification.

### O01 · Import eligibility and contract

Status is resolved. Accepted policy is recorded in D05, D14, D15, D29.

Admission/identity/precedence and hold-for-resolution policy are settled. Define the consumer adapter fields from current producer contracts, treat unsupported or missing fields as held imports, and verify legacy and retry cases.

### O02 · Evidence history

Status is resolved. Accepted policy is recorded in D06, D18, D26, D37.

Deletion scope and subsequent-context exclusion are settled. Preserve warned local history and independently retained quotations; use explicit scope for further removal. Keep source locators and missing/damaged evidence visible. Verify restore/deletion consistency.

### O03 · Codex connection and data boundary

Status is resolved. Accepted policy is recorded in D07, D31, D35, D36, D37, D40.

Managed sign-in, fresh-thread assembly, restricted configuration, 32000-character input default, derivative exclusion, and explicit retries are settled. Installed-version/Windows isolation and live auth/failure checks are required implementation gates.

### O04 · Project brief lifecycle

Status is resolved. Accepted policy is recorded in D08, D20, D36.

Brief content, source/version lifecycle, missing-source behavior and context-size policy are settled. Generate inspectable drafts, preserve approved versions on refresh failures, and obtain approval for shortened context.

### O05 · Comparison protocol

Status is resolved. Accepted policy is recorded in D21, D28, D34, D39.

Three synthetic fit/weak/misleading cases, one turn per method, common output requirements, requested 600-word answer, observed effort recording, four-dimensional scoring and real handoff separation are settled. Author versioned fixtures/prompt/anchor materials under those constraints.

### O06 · Context retrieval

Status is resolved. Accepted policy is recorded in D16, D19, D25, D32, D36, D37.

Corpus, text retrieval, visible ranked passages, manual selection, opt-in historical search, no-match outcomes, bounded packages, and dependency-aware exclusion are settled. Concrete ranking weights are reversible defaults evaluated for useful and paraphrased matches.

### O07 · Managed note conflicts

Status is resolved. Accepted policy is recorded in D09, D15, D18, D30.

Conflict preservation, missing-note pause, verified move repair, explicit duplicate resolution, confirmed removal/suppression, and unavailable-vault behavior are settled. Verify concurrency, restart and restoration workflows.

### O08 · Review semantics

Status is resolved. Accepted policy is recorded in D05, D19, D29, D33, D37.

Completeness, extraction uncertainty, actual review outcomes, user-supplied provenance, held unsupported inputs, rejection warnings, and subsequent-context exclusion are settled. Implement faithful producer field mappings without elevating review into universal factual approval.

### O09 · Vault layout and identity

Status is resolved. Accepted policy is recorded in D10, D30.

Folder ownership, stable identity, verified relocation and collision policy are settled. Concrete readable folder names, versioned metadata fields, and ordinary Markdown link conventions remain implementation details to specify without changing accepted behavior.

### O10 · Today semantics

Status is resolved. Accepted policy is recorded in D11, D27.

Today and timezone policy are settled. Implement and verify absolute capture instants, current PC timezone, local midnight boundaries, travel regrouping, and no source-date backdating.

### O11 · Capture interactions

Status is resolved. Accepted policy is recorded in D12, D33.

Minimal offline capture and explicit pasted-excerpt enrichment are settled. General webpage fetching is deferred. Entry shortcuts and title derivation are reversible implementation details; verify keyboard usability.

### O12 · Conversation persistence

Status is resolved. Accepted policy is recorded in D13, D17, D18, D35, D37, D38.

App-data conversations, explicit retries, fresh model threads, local context dependencies, manual credential-free backup, conflict-preview restore and separate copy lifecycles are settled. Verify persistence, deletion and cross-installation reconnection.

### O13 · 24-hour local scheduling

Status is resolved. Accepted policy is recorded in D22, D23, D24, D38, D40.

Per-user fixed 24-hour scheduling, missed-run catch-up, nonoverlap, manual checks and explicit cross-installation reconnection are settled. Actual Windows lifecycle/catch-up/source-access gates remain unexecuted implementation checks.

## Evidence inspected

- Validated Markdown export may remain partial and unreviewed. Source is `Reel-to-MD/docs/12-local-ui.md`.

- Review finalization carries review/source metadata and revision manifests. Accept/edit produces reviewed notes. Source is `Reel-to-MD/docs/11-review-evaluation.md`.

- The current project is a guitar practice tutor. Current docs should ground the initial brief. Source is `MyTune/README.md`.

- A consumer can observe validated ready drafts and finalized review bundles. No browser-download receipt, monotonic review revision sequence, or general source URL is guaranteed. Source hashes identify identical bytes; reviewed clip keys are manual. Handoff and precedence policies remain open. Source is `Reel-to-MD/src/reel_to_md/ui_jobs.py; ui_worker.py; pipeline.py; ui.py; review.py`.

- Task Scheduler supports a per-user interactive task while that Windows user is signed in. Scheduler selection remains open. Source is [primary documentation](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).

- A fixed PT24H repetition differs from a daily calendar trigger or 24 hours after the last successful run. Source is [primary documentation](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-interval-repetitiontype-element).

- Documentation supports new threads with explicitly supplied turn inputs, shared managed account authentication, cancellation, and token-usage notifications. Read-only defaults do not establish the selected restricted-read boundary; installed-version and Windows enforcement remain unverified. Source is [primary documentation](https://learn.chatgpt.com/docs/app-server).

- Harness instructions, tools, connectors, hooks, and memory require controlled configuration. A fresh thread is not proof of deletion of prior provider records. Source is [primary documentation](https://learn.chatgpt.com/docs/config-file/config-reference).

## Reversible implementation defaults

These are agent-synthesized details within accepted behavior, not separately user-selected technology decisions.

- Desktop framework, packaging and persistence libraries are implementer choices constrained by Windows worker and Codex isolation gates; this empty repository has no established stack or lockfile.
- Use Unicode code-point count for the application context-character limit; provider token/harness limits remain separately verified.
- Use readable artifact subfolders, versioned metadata, stable IDs independent from filenames, Markdown links and repairable indices. Exact names and ranking weights are reversible implementation details.
- Keep archive validation, staged restore, atomic publication and shared-worker locking as safeguards for accepted behavior. Do not interpret settled product policy as proof of executed tests.

## Specification handoff

The user authorized to-spec after grilling and confirmed the test seams. Published [the specification as Companion issue 1](https://github.com/siddsan7/Companion/issues/1), labeled `ready-for-agent`. The published body matches the local spec. Independent review passed after corrections. No scheduled task has been installed by this interview.


## Implementation ticket handoff

The user approved the 15-ticket breakdown. The to-tickets skill published the following sub-issues of [spec 1](https://github.com/siddsan7/Companion/issues/1), all labeled `ready-for-agent`. Verification matched the approved bodies and all 20 native blocking edges. Application implementation has not started.

| Approved slice | Issue | Blocked by | Primary requirements |
| --- | --- | --- | --- |
| 1 | [#2 · Capture notes offline and browse Today in a chosen vault](https://github.com/siddsan7/Companion/issues/2) | None | D01-I01, D03-I01, D03-I02, D03-I03, D10-I01, D10-I02, D10-I04, D11-I02, D11-I04, D12-I01, D12-I02, D12-I03, D12-I04, D18-I01, D27-I01, D27-I02, D27-I03, D27-I04, D33-I01, D33-I02, D33-I03, D33-I04, D40-I01 |
| 2 | [#3 · Import ready reel drafts with revision snapshots and safe retries](https://github.com/siddsan7/Companion/issues/3) | [#2](https://github.com/siddsan7/Companion/issues/2) | D01-I02, D02-I01, D02-I02, D02-I04, D05-I01, D05-I03, D06-I01, D06-I02, D06-I04, D11-I01, D11-I03, D14-I03, D15-I01, D29-I02, D29-I03, D29-I04 |
| 3 | [#4 · Import human reviews and resolve current-revision ambiguity](https://github.com/siddsan7/Companion/issues/4) | [#3](https://github.com/siddsan7/Companion/issues/3) | D14-I02, D15-I02, D15-I03, D15-I04, D19-I01, D19-I02, D19-I03, D19-I05, D29-I01 |
| 4 | [#5 · Preserve annotations and repair external vault changes](https://github.com/siddsan7/Companion/issues/5) | [#3](https://github.com/siddsan7/Companion/issues/3) | D02-I03, D02-I06, D09-I01, D09-I02, D09-I03, D09-I04, D10-I03, D30-I01, D30-I02, D30-I03, D30-I04, D30-I05 |
| 5 | [#6 · Run intake every 24 hours with visible Windows task controls](https://github.com/siddsan7/Companion/issues/6) | [#3](https://github.com/siddsan7/Companion/issues/3) | D14-I01, D14-I04, D22-I01, D22-I02, D22-I03, D22-I04, D23-I01, D23-I02, D23-I03, D23-I04, D24-I01, D24-I02, D24-I03, D24-I04 |
| 6 | [#7 · Approve and refresh a source-backed MyTune brief](https://github.com/siddsan7/Companion/issues/7) | [#2](https://github.com/siddsan7/Companion/issues/2) | D01-I03, D08-I01, D08-I02, D08-I03, D20-I01, D20-I02, D20-I03, D20-I04, D20-I05 |
| 7 | [#8 · Connect managed Codex sign-in and verify the isolation gate](https://github.com/siddsan7/Companion/issues/8) | [#2](https://github.com/siddsan7/Companion/issues/2) | D07-I03, D35-I01, D35-I02, D35-I03, D35-I04 |
| 8 | [#9 · Find eligible sources and preview a bounded context package](https://github.com/siddsan7/Companion/issues/9) | [#4](https://github.com/siddsan7/Companion/issues/4), [#7](https://github.com/siddsan7/Companion/issues/7) | D05-I02, D07-I01, D07-I02, D16-I01, D16-I02, D16-I03, D16-I04, D25-I01, D25-I02, D25-I03, D25-I05, D36-I01, D36-I02, D36-I03, D36-I04 |
| 9 | [#10 · Chat about project ideas with durable history and explicit retry](https://github.com/siddsan7/Companion/issues/10) | [#8](https://github.com/siddsan7/Companion/issues/8), [#9](https://github.com/siddsan7/Companion/issues/9) | D01-I04, D01-I05, D07-I04, D08-I04, D13-I01, D13-I02, D13-I04, D17-I01, D31-I01, D31-I02, D31-I03, D31-I04, D32-I01, D32-I02, D32-I03, D32-I04, D35-I05, D37-I03 |
| 10 | [#11 · Save cited ideas and experiment proposals explicitly](https://github.com/siddsan7/Companion/issues/11) | [#10](https://github.com/siddsan7/Companion/issues/10) | D02-I05, D02-I07, D03-I04, D03-I05, D04-I01, D04-I02, D04-I03, D04-I04, D04-I05, D04-I06, D04-I07, D06-I03, D17-I02 |
| 11 | [#12 · Inspect historical conversations and enforce source revocation](https://github.com/siddsan7/Companion/issues/12) | [#11](https://github.com/siddsan7/Companion/issues/11) | D13-I03, D13-I05, D17-I03, D18-I03, D19-I04, D25-I04, D37-I01, D37-I02, D37-I04 |
| 12 | [#13 · Delete captures with dependency previews and persistent suppression](https://github.com/siddsan7/Companion/issues/13) | [#5](https://github.com/siddsan7/Companion/issues/5), [#12](https://github.com/siddsan7/Companion/issues/12) | D18-I02, D18-I04, D18-I05, D26-I01, D26-I02, D26-I03, D26-I04, D37-I05 |
| 13 | [#14 · Back up and restore local conversation history safely](https://github.com/siddsan7/Companion/issues/14) | [#6](https://github.com/siddsan7/Companion/issues/6), [#10](https://github.com/siddsan7/Companion/issues/10) | D17-I04, D38-I01, D38-I02, D38-I03, D38-I04, D38-I05 |
| 14 | [#15 · Compare direct and analogical reasoning on three authored cases](https://github.com/siddsan7/Companion/issues/15) | [#10](https://github.com/siddsan7/Companion/issues/10) | D01-I06, D21-I01, D21-I02, D21-I03, D21-I04, D21-I05, D28-I01, D28-I02, D34-I01, D34-I02, D34-I03, D34-I04, D39-I01, D39-I02, D39-I03, D39-I04, D39-I05 |
| 15 | [#16 · Verify the complete real-reel workflow and release gates](https://github.com/siddsan7/Companion/issues/16) | [#13](https://github.com/siddsan7/Companion/issues/13), [#14](https://github.com/siddsan7/Companion/issues/14), [#15](https://github.com/siddsan7/Companion/issues/15) | D01-I07, D28-I03, D28-I04, D40-I02, D40-I03, D40-I04, D40-I05 |

The current frontier is [issue 2](https://github.com/siddsan7/Companion/issues/2). Implement-spec can consume the parent and native task graph. Local planning documents remain uncommitted and must be included in the integration branch before isolated implementer worktrees start.
