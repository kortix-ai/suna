---
title: Apps as the compute platform (Lambda + EventBridge on Platinum microVMs)
status: building — branch apps-lambda (type app triggers committed c2a108c29d), nothing merged
owner: Marko Kraemer (decisions), agent sessions (build)
updated: 2026-10-24
---

# Apps as the compute platform

## Problem

Agents must react the moment something changes, 24/7: app events with no
webhook, logs, processes, a page state, "the user finished signing in". Today
three unrelated systems cover parts of it:

| System | Where it runs | Limit |
|---|---|---|
| Composio events (`event_triggers`, source `composio`) | Composio webhooks | Only Composio's catalog |
| Kortix MCP polling (source `mcp`, `trigger-events/mcp-poll.ts`) | Inside the API | Curated events only, no custom code |
| Monitors (flag `monitors`, `projects/lib/monitor-box*.ts`) | One persistent microVM per project | One box, no failover, shell + stdout contract, repo clone, agents cannot deploy one quickly |

## Decision (2026-10-24, Marko)

- One compute noun: **Apps**. No Cloudflare Workers, no second runtime for now:
  100% Platinum microVMs.
- Make Apps Lambda-like end to end, and add an EventBridge-Scheduler-like
  scheduler. Always-on stays a choice (priced as a full-time machine).
- Any App can start or continue an agent session; any trigger source can
  target an App. Agents build and deploy their own Apps (monitors, crons,
  webhook receivers, bots).
- The monitor box stays untouched until Marko decides its retirement.
- Rejected for now: Cloudflare Workers for Platforms (needs a purchase, a
  subprocessor purpose change, a second runtime) and Platinum `celld` cells
  (WIP; celld is single-tenant, so it needs one VM per tenant plus a Platinum
  wake-on-alarm feature). Both remain options behind the same App contract.

## Facts this plan rests on (verified 2026-10-24)

- App machine root disk is replaced on every release; volumes outlive releases
  and machines (`apps/web/content/docs/apps.mdx`).
- Session sandboxes keep their disk across stop; processes and memory are lost.
- Kortix calls Platinum `/stop` (disk kept, memory lost,
  `platform/providers/platinum.ts`). Platinum also has `pause`/`resume`
  (memory kept); Kortix does not use it yet.
- Size floors: Kortix Apps `cpu >= 1`, `memory_gb >= 1` (integer GB). Platinum
  `limits.min_cpu = 1`, `limits.min_ram_mb = 256` (configurable to 128),
  `limits.min_disk_gb = 1`.
- On-demand Apps already wake on the first request (`public-proxy-runtime.ts`)
  and idle-stop after `idle_timeout_seconds` (120–86400).
- A process group with no service is a worker and never idle-stops
  (`release-config.ts` `groupAlwaysOn`).

## Scope

| # | Piece | What it adds |
|---|---|---|
| 1 | Small sizes | `memory_mb` (256 and up; 128 when the Platinum floor allows it), `disk_gb` from 1 |
| 2 | Fast wake | Idle on-demand machines pause (memory kept) instead of stop; stop stays the fallback. Lower idle timeout floor. Measure resume before setting defaults |
| 3 | Invoke | `POST /v1/apps/:id/invoke`: sync, or async with queue, retries and a dead-letter list |
| 4 | Scheduler | `schedules` on an App: `cron(...)`, `rate(...)`, one-time `at(...)`, timezone, payload, retry policy (attempts, max event age), dead-letter list. Target: an App path. Runs on the API's 24/7 worker loop |
| 5 | App → agent | App token (`kortix_app_…`), `POST /v1/apps/:id/events`, trigger `type: app` |
| 6 | Event → App | A trigger may target an App instead of an agent |
| 7 | Surfaces | CLI, web, SDK, docs (`apps.mdx`, `connect/triggers.mdx`), agent skill + templates (poller, webhook, cron, wait-until) |

Build order: 5 + 4 first (they ship the agent-built monitor on today's
machines), then 3, then 1 and 2.

## Open questions

- Platinum pause/resume latency for a 256 MB App machine (decides the idle
  default and whether a 1-minute schedule can scale to zero).
- Billing of paused machines on Platinum (memory snapshot storage vs running).
- Whether `event_triggers` app events and the monitor box later become
  built-in Apps.

## Where the code is

- Apps: `apps/api/src/apps/` (deploy `deployment-worker.ts`, machines
  `machines.ts`, idle `idle-reaper.ts`, wake `public-proxy-runtime.ts`,
  provider `hosting.ts`).
- Triggers: `apps/api/src/projects/routes/triggers.ts`,
  `apps/api/src/projects/trigger-events/`, contract
  `packages/api-contract/src/index.ts` (`type: cron | webhook | monitor | event`).
- Monitor ingest to reuse for App events: `apps/api/src/projects/lib/monitor-ingest.ts`.

## Unified automation model (Marko, 2026-10-24)

One engine, separate concepts: **sources** (when) → **the trigger engine**
(`project_trigger_runtime` + `project_trigger_executions`: dedupe, retries,
jitter, max_lateness, run caps, overlap, pause-all, run history, alerts) →
**targets** (then).

| Sources | Targets |
|---|---|
| schedule: `cron`, `every`, `at` (one-off; reminders and App `runAfter` are rows like this) | agent: new / reuse / keyed / pinned session + prompt |
| webhook: signed HTTP POST | session: prompt into one session (today's reminder) |
| event: connector (Composio push) or App (`emit`) | app: `target: { app, path, method }`, wakes the App and sends the payload |

Decisions:
- No second scheduler. A draft `app_schedules` table + worker was built and
  removed the same day: App schedules are triggers with an App target.
- Remove, do not port: the monitor box (`projects/lib/monitor-box*`, the agent
  server monitor runner, `type: monitor` with `run`) and the Kortix MCP poll
  loop (`trigger-events/mcp-poll.ts`, `poll-store.ts`, its worker). Their jobs
  become schedule rows on the one engine: a monitor is an App, and connector
  checks are schedules whose target checks the connector and emits events.
- `kortix.yaml` sections `schedules:` / `webhooks:` / `events:` with a
  `target:`; `triggers:` stays a legacy alias. Waiting on Marko's go for the
  public rename.

## Tracker (every ask, in order)

| # | Ask | State |
|---|---|---|
| 1 | event_triggers flag text | shipped #10872 (e67722ab12); relabel to "Connector event triggers" pending with 3 |
| 2 | `type: app` triggers (App → agent) | committed c2a108c29d, live-verified on Platinum |
| 3a | App target on the trigger engine | code done, needs integration test + commit |
| 3b | `every` schedules, one-off runs from Apps (`runAfter` / `runAt`) | next |
| 3c | remove the MCP poll loop; connector checks as schedules | after 3b |
| 3d | remove the monitor box and `type: monitor` `run` | after 3c; check prod usage first |
| 3e | `schedules:` / `webhooks:` / `events:` manifest + CLI/API/SDK/UI rename | waits for Marko's go on the shape |
| 4 | Lambda-style Apps: `memory_mb` sizes, pause/resume, invoke | after 3 |
| 5 | `/apps` shows only Apps with `display.listed: true` + rendering pass | needs `next dev`; when the laptop has RAM |
| 6 | docs (`apps.mdx`, `connect/triggers.mdx`), agent skill + templates | with each piece |
| 7 | Platinum template build stuck in `building` (kortix-appimg-dev-06b5823eb6aab7bb5d209061) | reported to the Platinum session, passed to Marko |
