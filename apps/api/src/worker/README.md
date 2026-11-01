# The worker: scheduled jobs off the web servers

The API runs as two process kinds from one codebase and one image:

| Process | Entry | Runs | Production |
| --- | --- | --- | --- |
| web | `src/index.ts`, `KORTIX_PROCESS_ROLE=web` | HTTP, WebSockets, per-process loops (`replica/`) | ECS service `<env>`, autoscaled, behind the ALB |
| worker | `src/worker.ts` | the scheduled jobs (`worker/jobs/`), the caches they read | ECS service `<env>-worker`, one task, no load balancer |
| all | `src/index.ts`, default role | both, in one process | self-host, local dev, previews, the test stack |

A scheduled job runs only on the process holding the leader lease
(`shared/leader-election.ts`). A web process never joins the election. A deploy
overlaps two worker tasks: the new one waits for the lease, and the old one
releases it on SIGTERM.

## Layers

```
 app       src/index.ts, src/worker.ts, src/bootstrap.ts    composition roots
   ↓
 http      routes, domain index.ts    │   jobs   worker/jobs/*       (neither imports the other)
   ↓
 services  projects/, billing/, audit/ …                     the job logic lives here
   ↓
 shared    lib/, shared/, config.ts, worker/runtime/*
```

## Folders

| Folder | Contents |
| --- | --- |
| `worker/jobs/index.ts` | The registry: every scheduled job, in start order, with the `runWorkerTick` names its ticks use. |
| `worker/jobs/<name>.ts` | One job: its timer and start/stop. The tick is a service function in its domain. |
| `worker/runtime/jobs.ts` | Starts every job on lease acquire, stops them on release. Every stop runs before the first await. |
| `worker/runtime/heartbeat.ts` | Watches every job tick. Once a minute it writes one JSON line (`kortix_metric: worker_jobs`); a CloudWatch metric filter turns it into `Kortix/Worker` `StaleJobs`. |
| `worker/runtime/job.ts` | The `Job` type. |
| `replica/` | Loops every web process runs: message delivery, the job queue, event polls, the tunnel, caches. |

## Rules and their enforcement

- A scheduled job is in the registry and nowhere else:
  `__tests__/unit-worker-scope-wiring.test.ts`.
- A per-process loop is in `replica/` with the reason one process cannot run it
  (`PER_PROCESS` in the same test).
- The worker loads no route and no middleware beyond the known leaks, a list
  that only shrinks: `__tests__/unit-worker-entry-imports.test.ts`.
- Web, worker and `all` start the right things: `__tests__/unit-bootstrap-workers.test.ts`.
- Lease flaps never leave a job stopped: `worker/runtime/jobs.test.ts`,
  `__tests__/unit-leader-election-flap.test.ts`.

## When the worker stops

| Stop | What happens | Jobs pause for (measured on dev, 2026-11-01) |
| --- | --- | --- |
| Deploy, SIGTERM | The replacement is already running. The old task stops its jobs (15 s budget) and deletes its lease row; the new task takes the lease on its next try (every 15 s). | 2.6 s (API leader → worker at the switch) |
| The only task stops (ECS stop-task, host retirement) | It releases the lease on SIGTERM; ECS starts a replacement, which takes the lease once it boots. | 66 s (Fargate placement, image pull, boot) |
| Crash, OOM, host loss | The 60 s lease expires; ECS starts a replacement, which takes the lease once it boots. | about 60–70 s: the expiry and the replacement's boot overlap |
| Hang | The lease renew stops; the leader steps down after 50 s; the container health check fails and ECS replaces the task. | as a crash |

Work a job had in flight is safe to repeat: cron fires are durable execution
rows with a 2-minute lease and a per-slot idempotency key, long passes keep
their cursor in the database, and billing rotations are idempotent per account
and month.

Alarms (`infra/terraform/modules/ecs-api`): the worker service runs no task for
5 minutes, or `StaleJobs` stays at 1 or more for 5 minutes. The kill switch puts
the jobs back on the web servers: `infra/scripts/ecs-deploy.sh <env> <image>
--service api --process-role all`.

## Run it locally

```bash
# one process, everything (the default)
bun run src/index.ts
# split: web + worker against the same database
KORTIX_PROCESS_ROLE=web PORT=8008 bun run src/index.ts
PORT=8009 bun run src/worker.ts
```
