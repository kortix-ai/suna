# Live runs

Local stack, real Platinum sandboxes, default model `kortix/deepseek-v4.1-flash`,
synthetic users and goals. Scripts lived in the session scratchpad; the HTTP
calls are the public API (`/projects/provision`, `/projects/:id/sessions`,
`/drives/:id/files`, `/sessions/:id/prompts`, `/sessions/:id/reminders`).

## Goal loop (goal: an approved four-line poem saved in Files)

| Run | Result | What happened | Fix |
|---|---|---|---|
| 1 | stuck 20 min | The agent asked with the blocking question tool, then approved its own work, and logged "removed heartbeat" while the reminder stayed active | skill rules (did not hold) |
| 2 | stuck | The same blocking question despite the new rule | `unattended=true`, released by the server |
| 3 | failed | The local tunnel changed address mid-run | none; local-only |
| 4 | passed, 266 s | ask → answer → separate verifier PASS → done → heartbeat removed | — |

## Enforcement (heartbeat deleted on purpose through the API)

| Run | Result | What happened | Fix |
|---|---|---|---|
| 1 | failed | The agent had the new skill on disk and still set up the goal by hand; no hook installed | the daemon runs the goal check for any coordinator, no install needed |
| 2 | failed | The check found the problem but never ran: OpenCode settles turn ends in its own relay | call the hook from `open-code/turn-relay.ts` too |
| 3 | passed | one `[GOAL CHECK]` prompt; heartbeat re-armed 16 s later; `goal.json` converged | — |

## Drives

API write → sandbox read, and sandbox write → API read, both in 30.5 s from
session create. Platinum answered `share_effective: private`,
`share_fallback_reason: flag_off` for the requested node share.

## Lesson

Written rules failed 4 times out of 7. Each failure was fixed only by code
outside the model's discretion. Design every new rule as a code check.
