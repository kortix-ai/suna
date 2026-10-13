---
recorded: 2026-10-13T23:30:29Z
incident_date: 2026-10-13
---
# Strip credentials before an agent saves an API response, and delete its credential files when the check ends

**Rule:** An agent that verifies a change (a worker, a reviewer, a dev verifier) saves an API response to a file only after it drops every credential field, such as the managed repo push token, a JWT, a PAT or a key. When its check ends, it deletes every file it wrote that holds a credential: env files, cookie and JWT files, HAR captures, provision responses. It never prints a file's contents to find out what is in it. It reads named fields with `jq` instead.

**Trigger surface:** Dev and stack checks that call `POST /v1/projects/provision`, mint a Supabase session, or read secrets with `dotenvx get`. Also orchestrators that run many verifiers against one shared scratch directory over a long session.

**Incident:** 2026-10-13, Session Log Plan orchestration. A dev verifier saved a full `POST /v1/projects/provision` response, which includes a short-lived managed-repo push token, to a scratch file and left it there. A later verifier read old scratch files and printed that token into its own transcript. The token had already expired and stayed in a local, private transcript. Nothing was published. The same scratch directory then held 103 credential-bearing files from finished runs, all deleted the same day.

**Enforcement:** none yet. The enforcer to build is a small helper for agent checks that saves an API response through a field denylist (`token`, `push_token`, `access_token`, `refresh_token`, `key`, `secret`), plus a scratch-directory sweep at the end of a check that fails on a credential pattern.
