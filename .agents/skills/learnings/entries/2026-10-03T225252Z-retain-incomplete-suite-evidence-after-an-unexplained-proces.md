---
recorded: 2026-10-03T22:52:52Z
incident_date: 2026-10-03
---
# Retain incomplete suite evidence after an unexplained process kill

**Rule:** Retain logs from a killed test suite and report it as incomplete. Verify owned listeners and surviving processes before recovery. Do not classify exit 137 as an out-of-memory event without supporting evidence. Do not substitute completed lane results for a completed gate.

**Trigger surface:** A local repository gate ends without its summary or attestation.

**Incident:** On 2026-10-03, the second full verification attempt started on `99e35ca1cd` and exited 137 during the browser stage. Core lanes had already failed. Nine browser tests completed successfully before the process ended. The browser and package stages did not complete. Both owned app listeners and the root runner were absent afterward. The cause of the process termination is unknown. Logs remain in the ignored local evidence directory.

**Enforcement:** The pre-push hook requires a complete passing attestation. The interrupted run wrote no new attestation. No process-kill cause detector exists. Inspect the process tree, listener ownership, and operating-system evidence before retrying.
