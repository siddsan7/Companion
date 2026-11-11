# Reconcile intake every 24 hours with a per-user worker

The user chose a cron-like 24-hour check, then accepted a per-user Windows scheduled task anchored to setup time. The worker runs while the user is signed in even if the app window is closed. Missed checks coalesce into one catch-up scan without intentionally waking the PC, and scheduled and manual workers must not overlap.

This accepts delayed intake while signed out or asleep and local clock-time shifts at daylight-saving transitions. First and manual scans are explicit exceptions that preserve the original schedule. See D14 and D22–D24 in [the decision record](../decisions-and-tradeoffs.md). Actual scheduler registration, catch-up timing, and access controls require target-machine verification. This interview has not installed a scheduled task.

Each producer connection records the identity of its ordinary directory. A missing, replaced, linked, or previously connected folder with no recorded identity needs explicit reconnection. Select the existing draft or review connection and enter the current ordinary folder, even if its path is the same. Reconnection keeps the source ID, artifact kind, and daily schedule. Select Check now to verify access and update the last success.
