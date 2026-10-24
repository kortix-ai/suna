---
title: Apps as the compute platform (Lambda + EventBridge on Platinum microVMs)
status: planning — branch apps-lambda, nothing merged
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
