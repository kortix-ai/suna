---
recorded: 2026-11-01T00:20:27Z
incident_date: 2026-11-01
---
# Never roll an ECS service from a laptop while a deploy workflow can run: the workflow's concurrency queue does not see a local roll

**Rule:** Before you run `infra/scripts/ecs-deploy.sh` from a laptop, list the environment's deploy runs (`gh run list --workflow deploy-dev.yml --status in_progress` and `--status queued`; the same for staging and prod) and start only when none runs. The `concurrency:` block of `deploy-*.yml` orders GitHub runs only. A local roll and a workflow roll of the same service supersede each other: the later revision becomes PRIMARY, and the earlier roll's wait fails.

**Trigger surface:** a manual roll, a kill-switch drill (`--process-role all`), or any `ecs-deploy.sh` call outside a workflow, on any environment.

**Incident:** 2026-11-01 00:15–00:20Z, dev, near-miss. A kill-switch drill for the worker split (PR #11367) rolled the dev API to `KORTIX_PROCESS_ROLE=all` (revision 925) from a laptop while another session's Deploy Dev run, dispatched at 00:03Z, reached its own worker and API rolls. The workflow's revision 926 (`web`) superseded 925; the drill's wait exited 1 and, by design, did not scale the worker to 0. The workflow run left dev correct (web + worker on its build). No job ran twice and no process was left without the lease.

**Enforcement:** none yet. To build: `ecs-deploy.sh`, when `GITHUB_ACTIONS` is not `true`, refuses to roll while `gh run list` shows an in-progress or queued deploy run for that environment, unless `--allow-concurrent-deploy`.
