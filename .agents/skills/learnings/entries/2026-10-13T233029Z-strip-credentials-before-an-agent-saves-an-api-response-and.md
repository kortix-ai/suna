---
recorded: 2026-10-13T23:30:29Z
incident_date: 2026-10-13
---
# Strip credentials before an agent saves an API response, and delete its credential files when the check ends

**Rule:** Drop every credential field before you save an API response to a file. Credential fields include a managed repo push token, a JWT, a PAT and a key. Delete every file with a credential when your check ends: env files, cookie and JWT files, HAR captures, provision responses. Read named fields with `jq`. Never print a whole file to see what it holds.

**Trigger surface:** A worker, reviewer or dev verifier that calls `POST /v1/projects/provision`, mints a Supabase session or reads a secret with `dotenvx get`. An orchestrator whose verifiers share one scratch directory over a long session.

**Incident:** 2026-10-13, Session Log Plan orchestration. A verifier printed an expired managed-repo push token into its local transcript. An earlier verifier had left the full provision response in a shared scratch file. Nothing was published, and 103 credential files from finished runs were deleted the same day.

**Enforcement:** none yet: a save-response helper for agent checks that drops a field denylist (`token`, `push_token`, `access_token`, `refresh_token`, `key`, `secret`), and a scratch-directory sweep at the end of a check that fails on a credential pattern.
