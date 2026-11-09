# Ticket 13 verification

Goal: deliberate capture deletion with a default current-content and all-snapshot scope, durable suppression, preserved independent writing, source dependency revocation and intentional restoration. No expiry or disconnected-root deletion. Live authentication/inference stays deferred.

Approved seam: Electron desktop UI plus resulting persisted vault files and local history. Root owns tests, native actions, Git and release checks. Implementation proceeds one RED/GREEN vertical at a time.

First RED: root ran `npm.cmd test -- tests/deletion.spec.js`; one case failed after 30.4 seconds waiting for the absent Delete capture control. Initial import, two revision snapshots, independent annotation and identity checks reached the deletion step. Test commit `32ce855` preserves that RED. No live integration gate follows from this controlled fixture.

First GREEN candidate: raw preview and cancel create no durable authority; confirmation revalidates exact files and directories under Conversation then Intake then capture file ownership. A content-free ledger manifest, deleting source generation and source-hash suppression commit before unlink. Completed imported current/snapshot/source-only before-file copies are purged; mixed or unknown intake recovery data holds for review. Existing accepted attempts remain unchanged. Later verticals must extend recovery inventory, independent-writing preservation, explicit restoration, generation propagation and separately selected dependent removal before the ticket is complete.

First GREEN: root reran `npm.cmd test -- tests/deletion.spec.js`; one case passed, exit0, 20.5 seconds (case19.7 seconds). All preview/cancel, current plus two snapshots, annotation preservation, suppression and immutable-attempt assertions completed. Worker syntax checks and diff whitespace checks passed. This document does not claim ticket completion or release readiness.
