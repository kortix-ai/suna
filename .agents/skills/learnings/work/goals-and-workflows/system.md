# Stage 1 as built: the goal loop

Merged on `dev`: #10314 (`b6d7c82ca7`), the flag gate #10589 (`4693ec3103`),
the CLI help coverage #10591 (`2fdff2edba`). Production gets it with the next
release. Web UI behind the same flag (see "Goals UI" below).

## Turn it on

Project flags `goals` (default off), `volumes` (default off) and `reminders`
(default on). `kortix goals new` refuses and prints the enable commands while
one is off. With `goals` off nothing of Goals shows: the `kortix goals` group is
hidden and refused (CLI command table `featureFlag: 'goals'`), kortixd withholds
the `kortix-goals` skill (frontmatter `kortix-feature-flag: goals`), and kortixd
runs no after-turn goal check (`harness/shared/on-idle-hook.ts`).

## Flow

1. The coordinator session runs `kortix goals new "<objective>" [--shared]`. It
   creates `Goals/<slug>/` in `/drives/me` (or `/drives/company`), marks the
   session unattended, arms a daily heartbeat reminder
   (`Goal wake: <folder>. Load the kortix-goals skill and run one wake.`), and
   writes `goal.json` with status `draft`.
2. It writes 2 to 6 checkable success criteria and runs
   `kortix goals transition active --reason "…"`.
3. Each wake (heartbeat, a reply, a worker finishing) runs one cycle: read the
   folder, do the next item, chase what is overdue, write back.
4. After every turn end, kortixd runs `kortix goals check --enforce` for a
   session that coordinates a goal (or `~/.kortix/hooks/on-idle` when
   installed). A broken invariant queues one `[GOAL CHECK]` prompt with the
   exact fix, at most 3 per goal per 6 hours. OpenCode and pi both call it
   (`open-code/turn-relay.ts`, `shared/turn-relay.ts`).
5. When every criterion has evidence, a fresh verifier session checks them and
   writes `evidence/verification.md`. Only its PASS allows `done`. `done` and
   `abandoned` remove the heartbeat.

## The goal folder

| File | Content |
|---|---|
| `goal.json` | only these keys: `version, objective, status, summary, success_criteria, items, sessions, reminder_id, transitions, verified_by, next_wake_at`. Items: `id, kind (task/ask/wait), title, status (open/doing/done/dropped), owner, due`. Unknown keys are a `check` violation |
| `notes.md` | `## Request`, `## Constraints`, `## Threads` (one Slack thread per person), `## Learned` |
| `log.md` | append-only timeline |
| `docs/`, `evidence/` | inputs, outputs, proof |

Visibility is the folder's Files grants. There is no other permission system.

## Lifecycle (guards in `apps/cli/src/commands/goals.ts`)

`draft → active → waiting_on_user | waiting_external | verifying → done`;
`verifying → active` on FAIL; any open status → `abandoned`.

| Edge | Guard |
|---|---|
| draft → active | 2 to 6 criteria, exactly one active heartbeat, session unattended |
| → waiting_on_user | an open `ask` with `owner` and `due` |
| → waiting_external | an open `wait` with `due` |
| → verifying | every criterion `met` with an existing evidence file; a verifier session in `sessions` |
| verifying → done | `evidence/verification.md` PASS on every criterion; `verified_by` is a listed verifier, not a coordinator |

`check` also flags: a status that differs from the last transition (edited by
hand), a missing or stale `reminder_id`, more than one heartbeat, a closed goal
with a heartbeat, a coordinator that is not unattended.

## Platform parts (generic, not behind `goals`)

| Part | Where |
|---|---|
| Unattended sessions: the server answers a blocking question at once | `apps/api/src/channels/question-release.ts` (`isUnattendedSessionMetadata`) |
| `unattended` metadata only by the session creator or the session itself (403 otherwise) | `routes/project-sessions.ts`, flow SCOPE-11 |
| Heartbeat successor: a reminder into a failed session starts a successor, re-pins the reminder, adopts the Slack threads | `projects/lib/trigger-fire.ts` (`fireReminderSuccessor`), post-create actions `repin_reminder`, `adopt_chat_threads` |
| Drive mounts request Platinum node share; mount slots follow Platinum limits | `apps/api/src/drives/volumes.ts` (node share is off on every Platinum lane) |

## Goals UI and health (flag `goals`)

| Surface | What it shows | Source |
|---|---|---|
| Sidebar row "Goals" | count of goals that need a person (open ask or a health issue) | `packages/ui/src/workspace/sidebar/footer/project-goals-nav.tsx` |
| `/projects/<id>/goals` | Needs you / Open / Closed; per goal: health dot, objective, next wake or the issue, criteria met, scope, status | `apps/web/src/features/workspace/goals/goals-page.tsx` |
| `/projects/<id>/goals/<scope>/<slug>` | health + heartbeat (next/last wake), open asks, criteria with evidence links into Files, items, sessions, status timeline, verification, notes, log | `goal-detail.tsx` |
| Session header "Goal" button | the session's role in the goal, status, health, progress, next wake, open asks; an orange dot when the goal needs attention | `packages/ui/src/session/header/session-goal-indicator.tsx` |
| Sidebar session row | a target marker on a goal's main session | `project-session-list.tsx` (`SessionGoalMark`) |

Data: `@kortix/sdk` `listProjectGoals` reads `/Company/Goals/*` and the caller's own
`Goals/*` through the Files API, and matches each goal's heartbeat in
`GET /projects/:id/reminders` (by `reminder_id`, else by the folder in the
prompt). No new API route. `goalHealth()` turns that into `healthy`,
`attention` or `closed` with issues `no_heartbeat`, `heartbeat_paused`,
`heartbeat_failed`, `missed_wake` (> 15 min late), `ask_overdue`,
`verification_stalled` (> 24 h) and `unreadable`. A mounted list re-reads
every 60 s, so "is it still running?" is answered from the real reminder, not
from what the agent wrote.

## Proof (dev, 2026-10-20, build `4693ec3103`, Platinum)

| Scenario | Result |
|---|---|
| Flag off | `kortix goals new` refused with the enable hint (exit 1), absent from `kortix --help`, skill not on disk, no folder |
| Autonomous goal (a file with the first 20 primes) | draft → active → verifying → done in 99 s; separate verifier PASS; file checked independently; heartbeat removed |
| Heartbeat deleted through the API, then a turn | `[GOAL CHECK]` delivered, heartbeat re-armed about 50 s later |
| Abandon | status `abandoned`, no active heartbeat |
| "A person approved" as a criterion | verifier FAIL: it cannot read the coordinator's transcript, and the coordinator's own `approval.md` is not proof |

## Known weak spots

- The model decides goal vs task. A short objective that needs one answer ran
  as a plain task with the blocking question card (correct result, no goal).
- The model picks statuses: a goal that waited for a date stayed `active` with
  a `task` item instead of `waiting_external` with a `wait` item.
- The agent can write `goal.json`. `check` detects a forged status after the
  fact; nothing prevents it.
- The heartbeat belongs to the coordinator session, not to the goal.
- Every wake costs a model turn, including pure waiting.
- Not run on dev yet: a Slack round trip with a real person, a successor after a
  real box failure, a multi-day wait.

Stage 2 (`runtime-design.md`) addresses these.
