# Local Second Brain and Idea Partner

## Problem Statement

I collect ideas in notes, conversations, links, and short videos. Later I must remember what I saved, find it again, decide whether it applies to a project, and distinguish supported observations from attractive speculation. Re-imports, external note edits, and changing project context can make that reasoning difficult to inspect.

I want a local Windows companion for my Obsidian vault that captures quickly, brings in eligible Reel to MD material on a predictable daily schedule, and helps turn useful connections into explicitly saved ideas and small experiments. I also want to compare explicit analogical reasoning with direct brainstorming without confusing a good demo with reliable evidence.

## Solution

Use the vault as the source of truth for notes, approved project briefs, and immutable imported revision snapshots. Keep resumable conversations and application settings in a separate local application-data store. Capture, intake, and browsing work without Codex. Selected chat input goes to hosted Codex inference through managed local App Server integration only after the configured Windows isolation boundary passes verification.

The first usable journey imports a real reel, relates it to an approved MyTune brief, and explicitly saves one cited experiment proposal that opens in Obsidian. Scheduled intake runs every 24 elapsed hours from setup under the signed-in Windows user, even with the UI closed. Missed checks catch up without intentionally waking the PC. First and manual checks are explicit exceptions that preserve the schedule anchor.

The first comparison uses three clearly authored synthetic cases against the same brief, covering plausible transfer, a weak connection, and a misleading analogy. A separate real Reel to MD smoke test verifies the producer handoff. Watches and a formal repeated study are later increments.

## User Stories

1. As a daily user, I want to save a rough thought without mandatory organization, so that I can capture it before I forget.
2. As a daily user, I want to save a link immediately while offline, so that I can avoid losing it during a network outage.
3. As a daily user, I want to edit a derived display title, so that I can recognize a capture later.
4. As a daily user, I want to reject empty captures visibly, so that I can avoid cluttering my inbox.
5. As a daily user, I want to see material first collected today, so that I can scan my daily intake.
6. As a travelling user, I want to see the timezone governing date views, so that I can understand changes in day groupings.
7. As a daily user, I want to browse and search older captures, so that I can recover material beyond Today.
8. As a Obsidian user, I want to choose Companion's parent folder in my vault, so that I can understand where its notes live.
9. As a Obsidian user, I want to open readable Markdown notes and links, so that I can keep using my usual editor.
10. As a Obsidian user, I want to move a note without losing its identity, so that I can organize my vault safely.
11. As a Obsidian user, I want to resolve duplicated or missing identities, so that I can preserve the correct note.
12. As a Reel to MD user, I want to connect draft and finalized-review locations, so that I can receive eligible material automatically.
13. As a Reel to MD user, I want to receive intake checks every 24 elapsed hours, so that I can limit background activity.
14. As a daily user, I want to run intake with the app window closed while signed in, so that I can avoid keeping the UI open.
15. As a daily user, I want to catch up after a missed check without waking my PC, so that I can receive accumulated material when available.
16. As a daily user, I want to see the schedule, last success and latest error, so that I can know whether intake is working.
17. As a daily user, I want to pause or disable scheduled intake, so that I can control background behavior.
18. As a Reel to MD user, I want to choose an initial scan and run Check now, so that I can test setup and use new material immediately.
19. As a Reel to MD user, I want to retain the original schedule after manual checks, so that I can keep the daily cadence predictable.
20. As a Reel to MD user, I want to import ready output without clicking a download link, so that I can avoid copying files manually.
21. As a Reel to MD user, I want to receive one capture for identical source bytes, so that I can avoid duplicate processing records.
22. As a Reel to MD user, I want to preserve attempts as revision history, so that I can inspect how source material changed.
23. As a Reel to MD user, I want to keep reviewed content current when a new draft arrives, so that I can avoid replacing reviewed material inadvertently.
24. As a Reel to MD user, I want to resolve ambiguous reviewed successors, so that I can choose the authoritative revision.
25. As a Reel to MD user, I want to inspect held imports and their reasons, so that I can repair unsupported or ambiguous inputs.
26. As a Reel to MD user, I want to continue independent imports after one failure, so that I can avoid blocking the whole inbox.
27. As a reader, I want to inspect source timestamps, locators and provenance, so that I can trace evidence back to its origin.
28. As a reader, I want to see completeness, extraction uncertainty and human review separately, so that I can understand the limits of a capture.
29. As a reader, I want to inspect review decisions and available claim findings, so that I can judge support for a proposal.
30. As a reader, I want to see rejection warnings on dependent ideas, so that I can revisit ideas whose evidence changed.
31. As a writer, I want to keep annotations separate from managed imports, so that I can preserve my writing during re-import.
32. As a writer, I want to resolve an external-edit conflict without losing either version, so that I can retain control of my notes.
33. As a writer, I want to keep unrelated intake running during a conflict, so that I can continue collecting material.
34. As a reader, I want to open the exact revision cited by an old idea, so that I can check the evidence used at the time.
35. As a daily user, I want to see missing-source or inaccessible-vault errors, so that I can distinguish missing evidence from deleted content.
36. As a project owner, I want to approve a MyTune brief grounded in its current documentation, so that I can work with real project constraints.
37. As a project owner, I want to explicitly add documents to a brief, so that I can control the scope of project context.
38. As a project owner, I want to review proposed brief updates, so that I can avoid silent context changes.
39. As a project owner, I want to keep an existing conversation on its original brief version, so that I can understand its reasoning later.
40. As a project owner, I want to see stale or missing brief inputs, so that I can decide whether to continue with older context.
41. As a vault owner, I want to keep personal notes outside discovery until explicitly included, so that I can control what Companion can find.
42. As a project owner, I want to inspect local search candidates and match reasons, so that I can judge whether the selected material is relevant.
43. As a project owner, I want to add and remove sources before sending, so that I can control context sent to Codex.
44. As a project owner, I want to explicitly search previous conversations, so that I can find earlier exploration of an idea.
45. As a project owner, I want to distinguish an empty search from an unsupported analogy, so that I can know whether to improve retrieval or abandon the connection.
46. As a project owner, I want to request clearly labeled speculation explicitly, so that I can explore beyond supplied evidence when I choose.
47. As a Codex subscriber, I want to connect through managed sign-in, so that I can use my existing supported Codex access.
48. As a vault owner, I want to require verified isolation before enabling chat, so that I can keep the agent within the selected-context boundary.
49. As a project owner, I want to preview the bounded outgoing question, history and excerpts, so that I can understand what leaves my PC.
50. As a project owner, I want to approve any shortening of an oversized package, so that I can avoid losing important context silently.
51. As a project owner, I want to remove derived context when a source is removed or rejected, so that I can prevent it reappearing through history.
52. As a project owner, I want to ask how a mechanism transfers to MyTune, so that I can judge whether a proposed analogy holds.
53. As a project owner, I want to receive citations for captured and project material, so that I can trace the proposed application.
54. As a project owner, I want to receive a small experiment with an observable result, so that I can evaluate an idea through action.
55. As a project owner, I want to see hypotheses and limitations explicitly, so that I can distinguish proposals from established claims.
56. As a daily user, I want to retain an incomplete reply after interruption, so that I can recover the useful part and understand its state.
57. As a daily user, I want to retry a failed request explicitly, so that I can control repeated generation and usage.
58. As a daily user, I want to resume locally retained conversations after closing the app, so that I can continue previous thinking.
59. As a writer, I want to preview an idea note and destination before saving, so that I can choose what becomes lasting vault content.
60. As a writer, I want to save a useful observation or failed analogy without inventing an experiment, so that I can preserve partial or negative conclusions.
61. As a writer, I want to save a complete experiment proposal separately from its sources, so that I can retain a testable plan without rewriting evidence.
62. As a writer, I want to retry a failed save without duplicating notes, so that I can recover safely.
63. As a daily user, I want to delete conversations independently from saved ideas, so that I can manage exploratory history.
64. As a vault owner, I want to preview capture deletion and dependent references, so that I can understand what will disappear.
65. As a vault owner, I want to remove a capture and its revisions without automatic re-import, so that I can make removal persist.
66. As a vault owner, I want to retain independent writing with missing-reference warnings, so that I can preserve my conclusions after deleting evidence.
67. As a daily user, I want to restore a suppressed capture explicitly, so that I can resume intake intentionally.
68. As a daily user, I want to paste an excerpt alongside a source URL, so that I can enrich a link without automatic webpage fetching.
69. As a reader, I want to see that a pasted excerpt is user supplied, so that I can avoid assuming the app verified the page.
70. As a daily user, I want to export a transcript explicitly, so that I can keep selected conversation history in my vault.
71. As a daily user, I want to back up app history and settings without credentials, so that I can recover local state safely.
72. As a daily user, I want to preview restore conflicts and reconnect the correct vault, so that I can avoid overwriting unrelated content.
73. As a evaluator, I want to compare direct brainstorming and explicit analogy on paired cases, so that I can inspect what the technique adds.
74. As a evaluator, I want to include plausible, weak and misleading connections, so that I can evaluate both useful transfer and abstention.
75. As a evaluator, I want to score shuffled outputs without method labels, so that I can reduce expectation bias.
76. As a evaluator, I want to rate usefulness, surprise, grounding and testability separately, so that I can inspect the trade-offs between them.
77. As a evaluator, I want to retain all results, failures and observed generation effort, so that I can avoid cherry-picking.
78. As a evaluator, I want to distinguish authored fixtures from a real producer smoke test, so that I can understand the limits of the evidence.

## Implementation Decisions

The repository currently contains guidance and design records with no application stack or existing runtime. Build the smallest Windows implementation that satisfies these contracts. Desktop framework, packaging, persistence libraries, readable folder names and ranking weights are reversible implementation choices. Record the chosen stack and lockfile during implementation. Do not replace accepted behavior with a technology shortcut.

The conceptual modules are the desktop shell and vault writer, producer intake adapter and shared reconciliation worker, local discovery and context assembler, project brief manager, Codex transport and readiness gate, local conversation/backup store, and comparison runner. Keep the desktop-plus-files workflow as the main test boundary; dependencies for time, producer artifacts and agent responses must be substitutable there.

Notes have stable item identities independent of paths, artifact type, schema version, absolute capture time, and relevant source/project relationships. Imported revisions additionally carry source hash where available, producer attempt/finalization identity, review information, provenance and evidence anchors. The intake adapter normalizes actual producer artifacts into that consumer contract. Missing or unsupported required identity/structure is held for resolution. Producer timestamps are not proof of an authoritative supersedes relationship. Source URLs are optional because local-video inputs may supply only local locators.

Journal or stage writes so publication, snapshots, import outcomes and suppression state stay consistent after crashes/retries. Shared locking covers all intake entry points, and destination-change detection protects external edits. Rebuildable search indices do not become the authority for vault note content.

The following requirements encode all accepted decisions. Later decisions refine earlier policies. Interview topic identifiers refer to resolved policies, not unanswered product choices.

### D01 · Deliver the complete capture-to-project workflow first

- **D01-I01**. Provide thought/link capture and a Today inbox backed by vault notes. Capture and import must remain usable when Codex is unavailable.
- **D01-I02**. Detect completed intake artifacts, validate the supported export contract, and create or update a capture with visible success or failure. Partial writes and unreadable input must not appear as successful imports.
- **D01-I03**. Build one MyTune brief from selected current project documents, retaining source references and the context version used for a conversation.
- **D01-I04**. Support a conversation using selected captures and the MyTune brief. The analogy output must explain the shared mechanism, project application, limitations, and a small test, with references to both source and project context.
- **D01-I05**. Allow an explicit no-useful-connection result. Label proposed applications as hypotheses and expose missing support.
- **D01-I06**. Provide a paired comparison using the same source material, project brief, model, candidate count, and approximately comparable generation budget. Record prompts, model, inputs, outputs, and comparison conditions. Rate usefulness, surprise, grounding, and ease of testing using the same rubric. Include a case where analogy may add little.
- **D01-I07**. Implement in verifiable steps. Establish capture/import first, then project context and a real signed-in Codex interaction, then saving and the paired comparison. Use fixture responses for repeatability and a real interaction for integration evidence.

### D02 · Manage imported content and preserve user writing separately

- **D02-I01**. Resolve a logical export identity independently from its path and revision identity. Retry or relocation must not create a second current capture for the same export.
- **D02-I02**. Validate an import envelope carrying logical identity, revision identity, content, available source locators/timestamps, provenance, and review information. Do not infer human approval from a successful export or a content completeness field.
- **D02-I03**. Update only the managed capture. Link annotations and saved ideas using a stable capture identity so import updates do not break their relationship.
- **D02-I04**. Make import publication atomic from the user's perspective. Detect changed destination content before replacing it and preserve conflicting user content. A failed or retried import must leave a recoverable state.
- **D02-I05**. Record the source revision and evidence location used by each saved idea. Make that cited revision inspectable after a later import using D06 immutable snapshots. D18, D26 and D37 govern retention and deletion.
- **D02-I06**. Show source content, annotations, linked ideas, and review information together or through direct navigation. Explain the ownership of managed notes before direct editing.
- **D02-I07**. Preserve original captures. Saving an interpretation or experiment creates its own note and does not rewrite the source to agree with the proposal.

### D03 · Distinguish captures, project briefs, saved ideas, and experiment proposals

- **D03-I01**. Represent stable capture identity, type, captured time, content, and available provenance. Use type-specific metadata for imports without requiring invented source metadata on a rough thought.
- **D03-I02**. Keep source occurrence time, import time, and captured time distinct when available. Apply D11 first-capture semantics to Today. D27 governs timezone and day-boundary behavior.
- **D03-I03**. Provide access to earlier captures and connected ideas. Changing the day must not delete, resolve, or hide older captures from all navigation.
- **D03-I04**. Represent source-to-idea links as many-to-many relationships and retain the relevant evidence revision. Keep project context references distinguishable from capture references.
- **D03-I05**. Treat Experiment Proposal as a saved idea with experiment fields. Avoid mandatory experiment fields for other saved ideas.

### D04 · Save structured ideas explicitly, with experiments when ready

- **D04-I01**. Provide a save action that builds a proposed standalone note and shows its content and destination. Commit only after the explicit save confirmation.
- **D04-I02**. Include a title, explanation, source/project references where available, and uncertainty or limitations. Clearly disclose missing support rather than generating citations.
- **D04-I03**. When an experiment is present, include the hypothesis, borrowed mechanism, project application, smallest test, and observable result. Validate completeness before labeling the note an Experiment Proposal.
- **D04-I04**. Retain capture identities, cited revisions, evidence locations, and project context references in the saved artifact. Distinguish source claims from proposed applications.
- **D04-I05**. Write the note safely, avoid overwriting unrelated files, and make retries recoverable without duplicate successful saves. Preserve the proposed content after failure so the user can retry.
- **D04-I06**. Handle a useful negative conclusion such as an analogy breaking down as a normal Saved Idea. A no-useful-connection response does not require a saved artifact.
- **D04-I07**. Apply D13 local history and restart/resume behavior independently from explicit note saving. Set remaining retention, storage, and recovery details under the settled policies below.

### D05 · Admit valid draft and reviewed exports

- **D05-I01**. Validate supported artifacts before publishing an import. Separate processing completeness, validation, extraction uncertainty, and human review information.
- **D05-I02**. Expose status and limitations both in the capture view and in context sent to Codex.
- **D05-I03**. Do not label incomplete transfers, failed processing, or unreadable review metadata as a successful reviewed import. Use the settled scheduled ready-artifact handoff.

### D06 · Retain immutable imported text revisions in the vault

- **D06-I01**. Publish an immutable snapshot for every accepted imported revision while preserving the current capture identity.
- **D06-I02**. Store source text and metadata with revision identity and evidence anchors. Keep snapshots accessible from citations and outside Today.
- **D06-I03**. Resolve a saved idea's evidence link to its cited revision after an update. Detect snapshot damage and report unavailable evidence rather than substituting newer text.
- **D06-I04**. Do not infer authorization to copy original videos. Store their available locators. Apply the settled snapshot and deletion policies.

### D07 · Send visible bounded context to Codex

- **D07-I01**. Build each outgoing context package in Companion with selected excerpts, provenance, and relevant history.
- **D07-I02**. Present included sources and support removing them before dispatch. Send only the reviewed package after the user's send action.
- **D07-I03**. Keep vault and project folders outside direct agent tool access and test the effective boundary on Windows.
- **D07-I04**. Expose unavailable authentication, offline operation, usage limits, interruption, and other failed turns while preserving local capture and existing notes. Set exact context bounds and integration under the settled policies below.

### D08 · Approve project brief refreshes and pin conversation context

- **D08-I01**. Record selected documents and their versions with each proposed brief and retain source references.
- **D08-I02**. Require approval to activate a newly generated or refreshed brief.
- **D08-I03**. Detect changes to selected inputs and offer a new brief before starting a conversation; visibly mark outdated inputs.
- **D08-I04**. Pin the approved brief version when starting a conversation and preserve access to the cited context. Resolve missing inputs, limits, and refresh failures under the settled policies below.

### D09 · Pause per-capture updates on managed note conflicts

- **D09-I01**. Detect destination changes against the last managed version before applying an update.
- **D09-I02**. Preserve local and incoming content and mark the capture conflicted. Continue independent intake.
- **D09-I03**. Present local changes for user-controlled transfer to an annotation before applying the incoming revision.
- **D09-I04**. Keep unresolved conflicts recoverable across restart and identify the exact content used in any conversation. Resolve rename/deletion/concurrency details under the settled policies below.

### D10 · Use a dedicated structured vault folder

- **D10-I01**. Set up an explicit user-selected parent folder with distinct artifact areas.
- **D10-I02**. Persist stable item identities independently from paths and readable filenames.
- **D10-I03**. Use ordinary Markdown links and reconcile identity when notes move or are renamed.
- **D10-I04**. Keep managed content ownership clear and avoid overwriting unrelated notes. Determine schema and repair rules under the settled policies below.

### D11 · Base Today on the first capture date

- **D11-I01**. Store the initial capture time immutably and preserve it across imports and revisions.
- **D11-I02**. Filter Today using the capture time and local calendar day under the selected timezone policy.
- **D11-I03**. Store source and revision times separately and surface an update indicator.
- **D11-I04**. Maintain historical browsing/search. Set travel, timezone changes, and backdating rules under the settled policies below.

### D12 · Keep quick capture minimal and offline

- **D12-I01**. Provide thought/link entry with no mandatory organization fields.
- **D12-I02**. Validate nonempty text and persist it locally with capture time without waiting for Codex or a network request.
- **D12-I03**. Derive a display title that the user can edit without changing capture identity.
- **D12-I04**. Keep links as entered and require explicit fetching. Specify entry shortcuts and enrichment behavior under the settled policies below.

### D13 · Retain resumable conversations locally

- **D13-I01**. Persist messages, per-turn context references, and turn completion/interruption state locally.
- **D13-I02**. Resume locally retained history after restart without presenting an interrupted response as complete.
- **D13-I03**. Support explicit conversation deletion without deleting independent saved ideas.
- **D13-I04**. Do not create a saved idea merely because conversation history was retained.
- **D13-I05**. Set retention, provider-side thread behavior, removed-source handling, and historical search under the settled policies below.

### D14 · Reconcile intake on a 24-hour schedule

- **D14-I01**. Configure explicit draft and optional review roots and reconcile on a persisted 24-hour schedule.
- **D14-I02**. Admit drafts only after validated readiness and reviews only after bundle validation and the applicable review policy.
- **D14-I03**. Persist artifact identities and outcomes so repeat runs do not duplicate captures or snapshots.
- **D14-I04**. Preserve the user's 24-hour cadence. Do not silently retain the earlier startup-plus-periodic recommendation. Specify scheduler registration, missed runs, overlap, first scan, and manual checks under the settled policies below.

### D15 · Group identical source bytes and prefer reviewed revisions

- **D15-I01**. Map processing attempts to capture identity using verified source hashes when available.
- **D15-I02**. Record attempts and finalizations as distinct revision identities while applying reviewed-over-draft precedence.
- **D15-I03**. Detect ambiguous reviewed successors and request an explicit current revision choice without discarding either revision.
- **D15-I04**. Require explicit user linking for different source bytes. Define missing hashes, manual linking, and legacy artifacts under the settled policies below.

### D16 · Limit automatic discovery to Companion-managed material

- **D16-I01**. Maintain an explicit eligible corpus based on managed artifact types and separately included vault notes.
- **D16-I02**. Exclude unapproved brief drafts and unselected personal notes from automatic discovery.
- **D16-I03**. Provide an explicit action to include another vault note as a source.
- **D16-I04**. Apply eligibility before ranking and context assembly. Define index, ranking, and historical search under the settled policies below.

### D17 · Store conversation history in local application data

- **D17-I01**. Persist resumable chat state in a local application-data location and expose that location to the user.
- **D17-I02**. Keep deliberate idea-note saving independent from chat persistence.
- **D17-I03**. Offer explicit transcript export to a chosen vault destination.
- **D17-I04**. Define application-data backup/restore, storage format, provider histories, and removed-source behavior under the settled policies below.

### D18 · Retain material until explicit deletion and warn about dependencies

- **D18-I01**. Apply no automatic expiry to retained notes, snapshots, and conversations.
- **D18-I02**. Inspect dependencies and show affected items before deleting referenced evidence. Preserve missing-evidence markers in dependents when deletion is confirmed.
- **D18-I03**. Treat conversation deletion independently from saved ideas.
- **D18-I04**. Persist capture suppression so scheduled scans do not recreate removed captures until explicit restoration.
- **D18-I05**. Define external Obsidian deletion, deletion scope, removal of stored excerpts, backups, and restoration behavior under the settled policies below.

### D19 · Separate completeness, uncertainty, and human review judgments

- **D19-I01**. Carry independent processing, extraction, and human-review fields through capture storage, display, snapshots, and context assembly.
- **D19-I02**. Show available claim-level findings when inspecting evidence.
- **D19-I03**. Record rejection metadata against the associated capture even though a rejection bundle has no reviewed Markdown export.
- **D19-I04**. Exclude rejected support from automatic evidence selection and flag dependent ideas for review without silently rewriting them.
- **D19-I05**. Map producer fields faithfully without claiming that acceptance proves every claim. Define unknown/legacy mappings and historical-use behavior under the settled policies below.

### D20 · Start the MyTune brief from the current README

- **D20-I01**. Select the current MyTune README as the initial source and record its version.
- **D20-I02**. Generate the specified brief sections with passage references and explicit gaps.
- **D20-I03**. Require explicit selection for additional documents and approval under D08 for a refreshed brief.
- **D20-I04**. Retain and mark the approved brief outdated when a source is missing; block approval of a refresh until the source issue is resolved.
- **D20-I05**. Define size limits, refresh errors, and context excerpt selection under the settled policies below.

### D21 · Compare three cases with hidden method labels

- **D21-I01**. Prepare three identifiable cases covering the specified fit conditions with identical source/project context across paired methods.
- **D21-I02**. Produce one final candidate per method per case using the same recorded model. Retain every output, failure, prompt, and generation-effort difference.
- **D21-I03**. Present paired results with hidden method labels and shuffled order while preserving a private method mapping.
- **D21-I04**. Collect the four ratings for every result and inspect shortcomings without applying an unselected numerical gate.
- **D21-I05**. Choose the actual materials, rubric anchors, prompts, and budget tolerance under the settled policies below.

### D22 · Run a per-user worker on a fixed 24-hour schedule

- **D22-I01**. Register an identifiable per-user task only as part of authorized intake setup, using the signed-in user context and a fixed 24-hour repetition anchor.
- **D22-I02**. Launch a worker independently from the UI and expose schedule, last success, latest error, and pause/disable state.
- **D22-I03**. Preserve the anchor across normal runs and manual checks. Define task repair and cleanup as part of scheduler lifecycle implementation.
- **D22-I04**. Verify actual Windows behavior, permissions, and source access before declaring scheduling ready.

### D23 · Catch up missed checks without waking the PC

- **D23-I01**. Configure missed-run catch-up without enabling intentional wake.
- **D23-I02**. Coalesce missed intervals into one reconciliation and leave the original trigger cadence intact.
- **D23-I03**. Use a common application-level lock for scheduled, catch-up, initial, and manual workers; do not run imports concurrently.
- **D23-I04**. Treat missing roots as visible failures without interpreting them as source deletions or deleting existing captures.

### D24 · Offer explicit first and manual intake checks

- **D24-I01**. Offer but do not silently force a first scan during folder connection.
- **D24-I02**. Expose Check now and route it through the shared worker, lock, validation, and import ledger.
- **D24-I03**. Keep manual runs independent from the recurring task anchor.
- **D24-I04**. On UI launch, show intake state; initiate catch-up only when due under the scheduled policy.

### D25 · Start with inspectable local text retrieval

- **D25-I01**. Search only the eligible corpus established by D16 and apply rejected-evidence exclusion before ranking.
- **D25-I02**. Rank local text matches with links and project associations, and show matching passages with reasons.
- **D25-I03**. Support explicit addition/removal before the outgoing context package is sent.
- **D25-I04**. Keep history search opt-in for a request and label conversation excerpts as historical dialogue.
- **D25-I05**. Evaluate exact matches, paraphrased relevant material, no-match cases, stale references, and removed sources.

### D26 · Default capture deletion to current content and revision history

- **D26-I01**. Build a deletion preview with current capture, all snapshots, affected dependents, and re-import suppression.
- **D26-I02**. Select the capture and all retained revisions by default and require confirmation of the displayed scope.
- **D26-I03**. Preserve independent annotations, ideas, and conversations, mark their broken references, and retain suppression until restoration.
- **D26-I04**. Keep deletion of independent artifacts and erasure of embedded quotations as separately scoped actions. Define these workflows under the settled policies below.

### D27 · Use current PC timezone for calendar views

- **D27-I01**. Persist an absolute initial capture instant and keep source occurrence and revision instants separate.
- **D27-I02**. Compute Today with the current PC timezone and its local midnight boundaries.
- **D27-I03**. Show the timezone where date grouping matters and refresh grouping when the timezone changes.
- **D27-I04**. Preserve the capture instant during updates, travel, and imported old source dates.

### D28 · Use authored comparison fixtures and a separate real import smoke test

- **D28-I01**. Author three versioned, explicitly synthetic fixture cases with inspectable source passages, limitations, and the same pinned MyTune brief.
- **D28-I02**. Run both methods on each fixture under D21 and label all recorded results as synthetic.
- **D28-I03**. Run a separately identified real Reel to MD import-to-saved-proposal smoke test with actual producer artifacts.
- **D28-I04**. Keep fixture and real-source evidence separate in reports and do not present authored fixtures as real reels.

### D29 · Hold unsupported or ambiguous imports for resolution

- **D29-I01**. Validate identity, structure, and revision precedence before publication.
- **D29-I02**. Persist held-import reasons and expose a resolution action without modifying original producer artifacts.
- **D29-I03**. Continue independent items and retry a held item only after the relevant issue is resolved or on a later eligible check without duplicating successful imports.
- **D29-I04**. Require explicit identity resolution rather than a filename-based guess.

### D30 · Resolve external identity and missing-note issues explicitly

- **D30-I01**. Reconcile known identities against accessible vault files and distinguish verified moves, missing notes, duplicated identities, and unreadable roots.
- **D30-I02**. Repair known relationships after a verified move without changing item identity.
- **D30-I03**. Pause updates to missing managed notes and preserve existing metadata/history pending explicit restore or confirmed removal.
- **D30-I04**. Preserve identity collisions for explicit resolution without overwriting either note.
- **D30-I05**. Do not infer per-note deletion from a root access failure.

### D31 · Require explicit retry for failed or interrupted agent requests

- **D31-I01**. Persist request input, selected context references, partial output, and terminal failure/interruption state.
- **D31-I02**. Never automatically replay a failed or interrupted user turn after reconnection or restart.
- **D31-I03**. Offer explicit retry or edit with inspectable context and a distinct request identity.
- **D31-I04**. Keep capture/import available and keep existing note writes independent from agent request failure.

### D32 · Distinguish retrieval failure from unsupported transfer

- **D32-I01**. Expose separate no-relevant-context and no-supported-connection outcomes.
- **D32-I02**. Offer source selection or re-search on missing context without inventing evidence.
- **D32-I03**. Explain unsupported transfer mechanisms against the available material.
- **D32-I04**. Require an explicit beyond-evidence request and label resulting suggestions as speculative without invented citations.

### D33 · Enrich links with user-pasted excerpts first

- **D33-I01**. Provide an explicit excerpt-entry action on a link capture and retain the supplied URL.
- **D33-I02**. Record user-supplied provenance separately from verified imports and preserve the original entered link.
- **D33-I03**. Include pasted text in local discovery with its provenance and limitations.
- **D33-I04**. Do not automatically fetch pasted links; keep general-purpose fetching outside first-release scope.

### D34 · Score four dimensions separately with material-error flags

- **D34-I01**. Record four independent integer ratings from 1 through 5, explanatory text, and material-error status per output.
- **D34-I02**. Define the accepted dimensions and anchor examples in the evaluation materials.
- **D34-I03**. Score every output with hidden method labels under D21 and retain the mapping for later inspection.
- **D34-I04**. Keep errors visible alongside scores and do not convert ratings into an unapproved numeric release gate.

### D35 · Use managed Codex App Server with isolated fresh-turn threads

- **D35-I01**. Authenticate through managed App Server account state without scraping desktop tokens or exporting credentials.
- **D35-I02**. Use a new model thread per app turn and reconstruct only the approved context, including allowed local history.
- **D35-I03**. Control working directory, read roots, tools, connectors, hooks, instructions, and memories to prevent unselected content access or injection.
- **D35-I04**. Gate chat readiness on a real successful signed-in interaction and denied reads of known vault/project canaries under the effective Windows configuration.
- **D35-I05**. Expose setup and authentication failures while preserving local capture/import; never silently widen permissions to make the gate pass.

### D36 · Bound the inspectable context package at 32000 characters

- **D36-I01**. Compute a deterministic character count over the application package using a documented convention.
- **D36-I02**. Display package count, limit, included passages, and proposed reductions before dispatch.
- **D36-I03**. Reject an oversized package until the user removes material or approves a smaller selection; do not silently drop selected evidence.
- **D36-I04**. Reserve room separately for harness instructions, reasoning, and output under the verified integration. Enforce any stricter supported input bound and record actual usage where available.

### D37 · Exclude removed-source derivatives from subsequent requests

- **D37-I01**. Track each turn's source dependencies and propagate them to derived messages and summaries.
- **D37-I02**. When a source is removed/rejected, invalidate affected derived context and expose exclusions in the preview.
- **D37-I03**. Send the rebuilt package in a fresh model thread so old provider-thread history cannot be implicitly resumed.
- **D37-I04**. Keep warned local history inspectable; distinguish exclusion, selected local deletion, and separately managed backups/exports.
- **D37-I05**. Offer separately scoped user selection of dependent writing to remove quoted copies without promising automatic semantic erasure.

### D38 · Back up local chat state and settings explicitly

- **D38-I01**. Export app-controlled conversations, settings, and vault identity metadata to a user-selected local archive without auth credentials.
- **D38-I02**. Validate archive integrity/version and preview destination conflicts before restore.
- **D38-I03**. Preserve existing state and require explicit conflict choices; do not silently replace a vault or overwrite unrelated history.
- **D38-I04**. On another installation require explicit vault matching and scheduled-task reconnection rather than automatic task registration.
- **D38-I05**. Clearly identify the archive as separate from vault backups and apply D37 copy lifecycle disclosures.

### D39 · Use one bounded comparison turn per method and retain effort differences

- **D39-I01**. Version the two prompt conditions with identical grounding/output requirements and an analogy-only explicit mechanism mapping instruction.
- **D39-I02**. Use one generation turn per method/case, the same pinned model and supported settings, the same source/brief package, and the accepted application limit.
- **D39-I03**. Request a final answer up to 600 words and record deviations without selectively discarding results.
- **D39-I04**. Record prompts, source revisions, settings, outcomes, observed usage availability, and elapsed time; retain failures without automatic regeneration.
- **D39-I05**. Present results for D34 scoring without method labels and preserve the pairing/method mapping.

### D40 · Verify the desktop/file workflow with separate real integration gates

- **D40-I01**. Build a desktop acceptance harness over a disposable vault with injectable time, producer artifacts, and agent transport responses.
- **D40-I02**. Assert observable UI outcomes and resulting Markdown/history state through realistic failure, retry, restart, and concurrency workflows.
- **D40-I03**. Run independent real Windows scheduler, signed-in isolated Codex, and real producer handoff checks before release readiness.
- **D40-I04**. Report skipped/failed real gates explicitly; never substitute mocks for integration evidence.
- **D40-I05**. Publish the synthesized specification to the configured issue tracker after this confirmed shared understanding.

### Final contract clarifications

- The dedicated vault parent has separate areas for captures, annotations, saved ideas, approved project briefs and imported revision history. Exact folder names remain readable implementation defaults.
- The MyTune brief explicitly covers project purpose, current behavior, constraints, known limitations and questions worth exploring, each grounded in selected document passages with gaps marked.
- Count application context characters as Unicode code points after constructing the actual outgoing package, including the question, approved brief text, selected history, excerpts and their visible provenance. The default maximum is 32,000 characters. Account separately for transport/harness overhead and enforce a smaller verified model bound if necessary. This is not a monetary ceiling or a proven generation-token ceiling.
- Review and send a stable package snapshot. If source eligibility or dependencies change before dispatch, rebuild and re-present it. A removed or rejected source invalidates dependent messages and summaries for subsequent requests. If dependency attribution is unavailable, conservatively exclude that historical material and show the exclusion. Never resume a provider thread that would reintroduce omitted history.
- For a conflicted capture, the preview names the exact selected local or imported revision. Do not silently treat an unresolved local edit as producer evidence. Missing or damaged evidence is displayed as unavailable rather than replaced with newer text.
- Approved brief refreshes retain selected source versions and references. A failed refresh preserves the prior approved brief with its stale indicator. Shortened excerpts require explicit approval under the same context rule as other sources.
- Legacy and unknown review metadata do not become reviewed by default. Supported drafts without human review remain unreviewed; structurally unsupported artifacts are held. Rejected evidence remains locally inspectable with warnings and is excluded, together with its derivatives, from subsequent supporting context.
- A failed/interrupted request has its own durable identity and terminal state. Explicit retry creates a new request. Saving a partial useful conclusion still uses an explicit preview and preserves its incomplete/uncertain provenance.
- Capture removal and restore operate through dependency previews and re-import suppression. Preserved writing may contain quotations. Further removal uses an explicit selection of dependent messages/notes; semantic erasure from independent text and provider records is not implied. Original video files and unrelated vault content are outside capture deletion scope.
- An inaccessible source root or vault preserves existing notes, import outcomes and suppression state. It does not trigger mass deletions. Intake performs local validation and reconciliation; it does not initiate background model generation.

## Testing Decisions

Test external behavior at the desktop workflow and resulting files/history state. Prefer a small acceptance harness that controls time, producer artifacts and agent responses over many internal implementation assertions. A correct test states a user-visible outcome, drives normal entry points, and checks the resulting note/state after restart where relevant. Use disposable vaults and fixtures; preserve real user content.

The current repository has no executable app tests to reuse. Prior art is Reel to MD's storage, pipeline, export validation and human-review checks, plus MyTune's browser journey, duplicate acceptance, stale-state handling and failure-injection scenarios. Reuse compatible producer fixtures and contract patterns without treating their tests as proof that Companion's handoff works.

### Acceptance and regression coverage

The following examples map each decision to observable acceptance checks. The requirements above also govern failure and recovery behavior covered by the combined scenarios below.

- **D01**. With a test vault and supported reel export, import once, discuss its application to MyTune, and explicitly save a cited experiment proposal that opens in Obsidian. Re-importing the same logical export leaves one current capture.
- **D02**. Import revision A, add an annotation and saved idea, then import revision B. There is one current capture, user writing is intact, and the old idea's evidence from A remains inspectable. Retry an interrupted import without duplicates or false success.
- **D03**. Create a thought, a bare link, and a reel import. Each appears as a capture with its type and available metadata. Find a capture from a previous day.
- **D04**. Generate a useful idea and verify that it becomes a vault note only after an explicit save confirmation. Review note content and destination before writing.
- **D05**. A valid partial draft appears as unreviewed with its limitations. A reviewed import preserves the decision and findings.
- **D06**. Import A, cite A, import B, and open both A and B independently. Retry A without an extra accepted snapshot.
- **D07**. Remove a source before sending and verify its text is excluded from the outgoing context, including reintroduced history. Verify bounded context and visible sources correspond to the actual outgoing package.
- **D08**. Change an input document and verify a refresh is offered without silently replacing the active brief. An existing conversation retains its original brief while a new conversation can use an approved refresh.
- **D09**. Edit a managed note, re-import, and verify both versions survive. Import an unrelated capture during a conflict.
- **D10**. Create each artifact type under the selected parent folder. Open notes and relationships in Obsidian.
- **D11**. Import an old reel and find it in Today. Update it on the next day and verify its initial capture date is retained.
- **D12**. Capture text and a link while offline. Reject empty input without creating an item.
- **D13**. Restart after a completed turn and restore the conversation with its context references. Restart during a reply and show its interrupted state.
- **D14**. With a controlled clock, verify scheduled checks are 24 hours apart under the selected scheduling policy. An eligible artifact is imported on a scheduled run without requiring browser download.
- **D15**. Reprocess identical video bytes under a different configuration and retain one capture with revision history. Import a draft after a reviewed revision and preserve the reviewed current revision.
- **D16**. Search for a phrase present only in an unselected vault note and verify it is absent from automatic discovery. Include that note and verify it can be discovered.
- **D17**. Resume a conversation from the application-data store after restart. Verify normal conversation persistence does not create a vault transcript.
- **D18**. Advance time and verify retained material does not expire automatically. Cancel deletion after a dependency warning and verify all artifacts remain.
- **D19**. Display a partial capture with uncertain extraction and an accepted-with-edits review without collapsing the judgments. Import rejection metadata, inspect it against the capture, and exclude the rejected evidence from automatic selection.
- **D20**. Generate the initial brief from the README and inspect references for each supported section. Verify unselected documents are not silently incorporated.
- **D21**. Verify three cases and six final output slots, including recorded failures rather than selective omission. Verify matched inputs/model and retained generation-effort differences.
- **D22**. Close the UI while signed in and verify a scheduled worker can run. Verify fixed 24-hour scheduling rather than a daily local clock trigger.
- **D23**. Miss several intervals and perform one catch-up scan on availability. Verify sleep is not intentionally interrupted.
- **D24**. Accept the first-scan offer and import eligible material. Decline the offer and retain the scheduled scan.
- **D25**. Inspect candidate text matches and reasons before sending. Add a source and remove a candidate, then inspect the outgoing package.
- **D26**. Delete with default scope and remove current capture plus all snapshots. Verify independent notes and conversations remain with missing-reference warnings.
- **D27**. Test near-midnight captures across a timezone change and preserve absolute timestamps. Test daylight-saving day boundaries where applicable.
- **D28**. Inspect all fixture labels, passages, limitations, and brief versions. Verify comparison records identify synthetic material.
- **D29**. Missing identity is held with an actionable reason. Invalid structure and competing reviewed revisions remain inspectable.
- **D30**. Move a note and repair its links by verified identity. Copy an identity and preserve both notes pending resolution.
- **D31**. Interrupt a turn and retain a visibly incomplete reply and its question. Reconnect or restart without generating another reply automatically.
- **D32**. An empty search offers sources or a new search. A misleading analogy explains its broken mechanism.
- **D33**. Paste an excerpt, retain its URL, and find its text through local discovery. Inspect provenance and verify no page-verification claim appears.
- **D34**. Record independent ratings, a reason, and an error flag for each output. Reject scores outside the scale.
- **D35**. Reuse account sign-in across fresh threads without resuming hidden history. Verify known outside-context canaries cannot be read.
- **D36**. Send a package exactly at the application limit and block one above it. Require approval for proposed shortening.
- **D37**. Remove a source and verify its excerpt, dependent messages, and summaries are excluded from the next outgoing request. Reject a source and prevent it from returning through historical search or cached context.
- **D38**. Export and restore a local history archive without credentials. Detect a mismatched vault manifest and block silent rebinding.
- **D39**. Inspect six result slots across the three cases including failures. Verify only the analogy condition requests mechanism mapping.
- **D40**. Complete the import-to-cited-experiment acceptance journey and open the saved note in Obsidian. Exercise captured edits, interrupted imports/turns, explicit retry, conflict repair, deletion/suppression, and restart.

### Controlled failure and concurrency checks

- Fail a note save, retain the proposed content, retry explicitly, and produce exactly one successful saved note without overwriting an unrelated file.
- Resolve a managed-note conflict by transferring local edits into an annotation and then applying the incoming revision. Separately restart with an unresolved conflict and recover both versions and its paused state.
- Remove a selected brief input, preserve the outdated approved brief, and block refresh approval until the source issue is resolved. Restore or explicitly replace the input before approving the new brief.
- Verify that historical conversation search is opt-in. Include relevant differently worded material in retrieval checks, record lexical misses, and show no-match/source-selection outcomes rather than inventing support.
- Interrupt intake before publication and after staging, then restart. Verify one coherent capture/revision outcome, preserved user content, and no false successful import. Overlap scheduled/manual checks and external note edits under the same realistic workflow.
- Exercise invalid/partial artifacts, identical-byte reprocessing, changed-byte clips, reviewed-versus-draft precedence, ambiguous reviewed successors, legacy records, rejection bundles, inaccessible roots and relocated producer stores.
- Inspect real serialized outgoing packages for size, selected passages, source removals and derived-history exclusions. Simulate auth failure, offline operation, limits, partial replies, cancellation and restart. Verify no automatic replay and no unrelated note mutation.
- Exercise deletion cancellation/confirmation, snapshot dependency warnings, suppression/restoration, identity collision, verified move repair, source damage, and backup restore against mismatched/conflicting state.
- Test exact context-boundary counts and Unicode, timezone transitions and local midnight, stable original capture instants, and explicit first/manual scans without schedule reset.

### Required real integration gates

- Windows Task Scheduler must launch the worker while the UI is closed and the user is signed in, keep the fixed 24-hour anchor, respect pause/disable, avoid intentional wake, coalesce missed checks, and prevent overlap. Verify target-machine catch-up and file access; do not infer exact timing from documentation.
- The actual installed Codex integration and intended managed account must complete a synthetic interaction with effective isolation. Verify denied reads of known out-of-context vault/project canaries, controlled injected instructions/tools/memory, source removal on fresh threads, interruption and terminal status, expired/cancelled sign-in, offline and usage-limit handling. If isolation fails, chat remains unready and local workflows remain available.
- Complete a real Reel to MD ready-artifact import, project conversation and explicit saved experiment in a test vault. Preserve available evidence/review metadata and open the resulting note in Obsidian. Authored comparison fixtures do not substitute for this producer handoff.
- A release report records each gate as passed, failed or skipped with concrete evidence. Mocks, schema checks and documentation review never count as a passed live integration. Merges and deployments still require the user's review.

### Exploratory comparison protocol

Use versioned synthetic source passages and a pinned MyTune brief. Author the three fit conditions and document intended limitations. The plausible case can model spaced retrieval applied to revisiting a previously learned chord change, with an observable clean-play result. The weak case should lack a meaningful transfer to current project constraints. The misleading case should tempt a transfer whose mechanism conflicts with the supplied conditions. These examples are authored fixtures, not claims about actual reel contents or guitar-learning outcomes.

The direct prompt asks for a grounded useful project idea or justified abstention using supplied context, citations, limitations and a small test when appropriate. The analogy prompt keeps those requirements and adds explicit mapping of a source mechanism to the project's conditions and where the mapping may fail. Each method gets one model turn per case, identical source/brief packages and model/settings, and a request for a final answer up to 600 words. Record actual output length, elapsed time and usage where available. Retain all six outcome slots, including failures. Do not reroll results automatically or claim equal consumption.

Shuffle presentation and hide method labels during scoring. Record separate 1–5 scores, a short explanation and a material-error flag. Use 2 and 4 for intermediate cases. Anchor examples are implementer-authored applications of the accepted definitions.

| Dimension | 1 · Poor | 3 · Mixed | 5 · Strong |
| --- | --- | --- | --- |
| Usefulness | No concrete project decision is helped | A relevant direction needs substantial clarification | Helps a concrete current MyTune decision |
| Surprise | Restates supplied material | Makes a modest non-obvious connection | Provides a distinct, non-obvious connection worth inspecting |
| Grounding | Invents support or transfers a broken mechanism | Partially supported with identifiable gaps | Claims and transfer follow from supplied evidence and expose limits |
| Ease of testing | No feasible observable check | A test exists but needs substantial narrowing | A small feasible test has a clear observable result |

Flag unsupported claims or broken analogies even when novelty scores highly. A supported abstention can score well for grounding; mark usefulness/testability according to the decision it helps, with an explanation. Review every result and observed effort difference. No composite score or numerical release threshold is selected, and three authored cases do not establish statistical reliability.

## Out of Scope

- Hosted/multi-user operation, cross-device sync and mobile clients.
- Replacing Obsidian's editor, an initial Obsidian plugin, and live voice conversation.
- Changing Reel to MD extraction, synthesis or training. Adapt existing ready-artifact contracts in Companion.
- Watches, prospective-memory alerts, continuous web monitoring, full PM-Bench implementation and a formal repeated human study in this increment.
- Automatic project changes, experiment execution, background idea generation and automatic publication of ideas into the vault.
- General-purpose webpage fetching, authenticated/dynamic-page ingestion and automatic link fetching. First-release enrichment is user-pasted text plus its source URL.
- Automatic semantic merging of edited/re-encoded clips, automatic ambiguous-review resolution, or silent overwrite of user content.
- Running intake while signed out, intentionally waking the PC, or replacing the chosen 24-hour cadence with continuous polling.
- Automatic retention expiry, automatic erasure of independent backups/exports/provider records, or guarantees of original-media availability.

## Further Notes

The design interview is complete and all 40 decision IDs are accepted. The user confirmed the external-behavior test boundary and authorized publication through to-spec. The decision/trade-off record retains alternatives, accepted consequences and the complete approval history. The implementation requirements in this issue are planned work, with live isolation and scheduling explicitly gated.

The source inspection established that current Reel to MD readiness and review bundles can be consumed without a browser-download receipt. Draft metadata supplies input hashes and attempt information. Finalized review bundles supply review identity, manual clip key, decision, finalization identity/time and integrity information, but no guaranteed cross-bundle supersedes ordering. A source hash identifies equal bytes, not a semantic clip identity. The existing real clips inspected during design were not the authored spaced-retrieval example.

Local source storage does not make hosted inference local. Selected packages go to Codex; the accepted fresh-thread and restricted configuration boundary must be verified on the installed Windows setup. Documentation review has not established a passed live gate. [Codex App Server](https://learn.chatgpt.com/docs/app-server), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

Fixed repetition, signed-in execution and missed-run handling have distinct Windows semantics. Preserve the accepted behavior and verify effective scheduling on the target machine. [Task security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks), [repetition intervals](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-interval-repetitiontype-element), [missed runs](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable)

The analogy paper motivates an exploratory comparison; it does not establish usefulness for this product or improved learning outcomes. The prospective-memory paper motivated deferred watches. Keep those inspirations distinct from Companion evidence. [Analogical reasoning paper](https://arxiv.org/abs/2605.11258), [PM-Bench](https://arxiv.org/abs/2607.12385)
