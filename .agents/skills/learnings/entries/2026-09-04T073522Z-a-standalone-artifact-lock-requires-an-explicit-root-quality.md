---
recorded: 2026-09-04T07:35:22Z
incident_date: 2026-09-04
commit: 77681271d3
---
# A standalone artifact lock requires an explicit root quality gate

**When:** a workspace package builds its production artifact from a nested package-manager lockfile.
**Incident:** `apps/kortix-worker` had 155 tests, but root and package lanes ran none of them;
its real-bundle API suites also passed as skipped whenever `dist/` was absent.
**Rule:** include the package in the workspace, then run its standalone install, test, typecheck,
build, and required bundle proof explicitly from the artifact lock.
**Enforcer:** `worker-quality.ts`, root lane contracts, and the worker-triggered CI build job.
