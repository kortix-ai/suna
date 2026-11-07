---
title: Goals production readiness — master plan
status: M1–M5 built on branch goals-prod (2026-11-06); M6 partly proven locally; M7 not started
owner: Jay (decision owner for Goals since 2026-11-06)
updated: 2026-11-06
branch: goals-prod (worktree ../suna-goals-prod)
---

# Goals production readiness — master plan

## Status (2026-11-06)

- M1–M5 are built on `goals-prod`: `project_goals` + `project_goal_events`,
  the goal routes, the admission gate, successor adoption, the reconciler job,
  the CLI on the API, the rewritten skill, the SDK on the routes, and the
  web/TUI controls driven by `capabilities`.
- Proven on a local stack with real Platinum sandboxes: a goal went
  create → activate → evidence → verify → independent PASS → done in 75 s;
  a goal whose owner failed in draft became `owner_lost` and Restart gave it a
  new owner; stop on a live goal (stale revision → 409, retry → 200, heartbeat gone).
- Three defects the mocked tests missed were found that way and fixed: goal
  sessions had a `system` origin (Files mounted nothing), the default agent
  fallback picked My Kortix (422), and a failed draft owner stayed "Draft"
  forever.
- Open: M6 on dev (Slack round trip, multi-day wait, break matrix B1–B14 on
  dev), M7 (release approval, remove `wip`).

## 1. The problem

Goals is usable on the happy path and is not safe to put in front of users.

- Two independent read-only audits on `dev` at `8e042a60fb` (GPT-6.1 Sol, code
  audit; GPT-6 Astra, architecture and product) score it **45 % ready**.
- 26 gaps, 1 P0 and 20+ P1. The UI scores 65 %. The engine scores 35–40 %.
- The P0: **the agent can mark its own goal done.** It writes `state: done`, a
  matching transition, an invented verifier and the word `PASS`;
  `kortix goals check` reports no violation and the UI shows "verified".
  Reproduced locally by the Sol audit with the real CLI guard code.
- The flag `goals` is off by default, `wip: true`, `enforcement: 'ui-only'`
  (`apps/api/src/feature-flags/registry.ts:325`). Staging has the code. Prod
  does not.

## 2. The bar: what "prod-ready" means here

Owner definition (2026-11-06): **the whole Goals feature works and does not
break when someone uses it — in the UI and in the backend.**

- The flag `goals` stays. Its default stays **off**. A project turns it on in
  Settings. Nothing about the rollout changes; the quality bar does.
- "Does not break" covers every path a user can take, not only the happy
  path: failures, retries, two people at once, a dead sandbox, no credits,
  a goal that waits for days, the flag turned off mid-goal.

A user who turns the flag on can rely on 8 backend promises (below) and the UI
promises in section 2.1. Each one is a code check, never a skill rule
(`live-runs.md`: written rules failed 4 of 7 runs).

| # | Promise | Today | Gap ids |
|---|---|---|---|
| P1 | Only an independent verifier can set done, and it checks every criterion against the current evidence. | broken | G01, G02 |
| P2 | Only a person can pause, resume or stop a goal. Pause and stop take effect at once: no new paid turn starts after them. | broken | G05, G06 |
| P3 | A goal survives the death of its sandbox. A successor session takes over the goal, not only the reminder. | broken | G03, G04 |
| P4 | A goal never costs more than its caps. Caps are checked before a turn starts, and the agent cannot raise them. Waiting does not burn a model turn every 4 h. | broken | G13, G14, G20 |
| P5 | Every control (create, pause, resume, stop, restart, answer) either completes or can be retried to completion. No half-applied state. | broken | G07, G11 |
| P6 | Each goal has one identity. Events wake the right goal. Everyone with access sees it in the list. | broken | G08, G09, G17, G18 |
| P7 | The assigned person learns, without opening the page, when the goal needs them, is blocked (credits, caps, failure), or is done. | missing | G15, G21, G22 |
| P8 | Turning the flag off stops all goal work, not only the UI. | broken | G10 |

### 2.1 UI promises (web, desktop shell, TUI)

The Sol audit scores the web UI 65 %: the screens exist, but they break at the
edges. Each promise below gets a DOM + network assertion in M5.

| # | Promise | Today | Gap ids |
|---|---|---|---|
| U1 | A person sees only the controls they may use. A read-only viewer sees no pause/stop. A control never fails with a permission error after it was shown. | broken | G16 |
| U2 | Every control has a pending, success and error state. An error says what failed and offers a retry that finishes the operation. Double-click sends one request. | partial | G07 |
| U3 | Every goal the person may see is in the list and its link opens — company, personal, shared folders. An inaccessible or deleted goal shows a clear empty state, not a crash or a blank page. | broken | G17 |
| U4 | The page states the true situation: verified vs agent-reported criteria, waiting on whom, next wake, `blocked_reason` (credits, caps, storage, failure), spend vs caps. A green check never means "verified" unless the verifier passed it. | partial | G15, G22 |
| U5 | The page stays correct while things change under it: the agent edits the brief, another person pauses, the goal finishes, the flag is turned off. No stale control acts on old state (revision check, `409` → refresh). | broken | G11 |
| U6 | Create never leaves an orphan. A failed create shows a retry; a retried create makes one goal. | broken | G07 |
| U7 | It looks and works the same in light and dark, at 720 × 480, in the desktop shell, with keyboard only. Local times everywhere. | partial | G23 |
| U8 | TUI and CLI do the same operations as the web, through the same API. | broken | G24 |

Out of this plan (section 9): flag default-on, non-Platinum self-host, native
mobile Goals screens, stage 2 `goal.ts`, a dollar-priced plan.

## 3. The decision: where goal state lives

Three options were evaluated by both audits.

| | A. Harden GOAL.md authority | **B. Server goal record (recommended)** | C. Stage 2 `goal.ts` first |
|---|---|---|---|
| Forgery | Prevented only if the agent cannot write the file. The file is on its mount. Detect-after-the-fact stays. | The API owns lifecycle, verifier, caps, pause. File edits change nothing protected. | Needs B's protection anyway, plus a journal. |
| Sandbox death | Owner repair still a file write race. | Owner generation is a DB row; adoption is one transaction. | Strong, once replay and versioning work. |
| Idle cost | 6 turns/day while waiting. | `waiting_for` + `next_due_at`; zero turns until an event or deadline. | Native. |
| Multi-replica | Last-write-wins Drive sync is wrong for lifecycle. | Compare-and-set revision, worker job under the leader lease. | Same as B plus replay concurrency. |
| Time to ship | Unclear; real anti-forgery grows into B. | Medium. Reuses reminders, sessions, Review Center, SDK, UI. | Longest. New runtime. |

**Decided: B** (Jay, 2026-11-06). Both audits reached it independently.

- This reverses the 2026-10-19 decision "a goal is a folder in Files, not a
  table". What changed: the agent being evaluated can edit the evaluation.
  Pause provenance, caps, a project-wide inventory and independent completion
  all need atomic, queryable server state. Rebuilding that inside protected
  files is a database with extra steps.
- What stays: the folder. `GOAL.md` stays the human-readable brief that the
  agent and people edit. `log.md` and `evidence/` stay artifacts. The server
  writes a read-only lifecycle block into `GOAL.md` for inspection and never
  reads it back as truth.
- The reversal is recorded in `decisions.md` (2026-11-06).

## 4. Target architecture

### 4.1 Data (one migration, additive; load the **migration** skill)

| Table | Holds |
|---|---|
| `project_goals` | `goal_id`, project, `drive_id` + canonical folder path (locator, not identity), title, assigned user, agent, `state`, `revision` (CAS), `generation` (execution epoch, bumped by pause/stop/owner change), `owner_session_id`, `verifier_session_id`, `paused_at/paused_by_user_id`, `stopped_at/stopped_by`, `waiting_for` (jsonb: question id / event filter), `next_due_at`, caps (`max_wakes_per_day`, `max_sessions`, `max_credits`), counters (`wakes_today`, `wake_day`, `sessions_used`, `credits_used`), `blocked_reason`, `criteria_revision`, timestamps. |
| `project_goal_criteria` | `goal_id`, `criteria_revision`, criterion id, text, kind (`check` / `human_acceptance`). Immutable per revision. |
| `project_goal_events` | Append-only: every transition, control, wake admitted/refused, verdict, adoption, with `actor_kind` (`user` / `session` / `platform`) and server-derived actor id. Source of `log.md`. |
| `project_goal_verifications` | Attempt per verifier session: criteria revision, evidence manifest (path + hash), per-criterion result `pass/fail/inconclusive`, decided_at. |

Human approvals reuse **Review Center** (`review_items`, kind `approval`;
`apps/api/src/projects/review-items.ts`, `lib/approval-authority.ts`). No new
approval table.

### 4.2 API (`apps/api/src/projects/goals/`, routes registered explicitly)

- Services take an `Actor` (`middleware/actor.ts`). The server derives the
  actor. A request body never sets `by`, `paused_by` or a role.
- `POST /projects/:id/goals` — create (idempotency key): row + owner session +
  first prompt + brief, as one durable operation (outbox steps, retried by the
  worker until done).
- `GET /projects/:id/goals`, `GET …/goals/:goalId` — inventory from the table,
  filtered by Files ACL of the folder. Replaces the SDK folder scan (G17, G18).
- `POST …/goals/:goalId/{pause,resume,stop,restart}` — **user actors only**.
  Bump `generation`, cancel queued goal wakes, write the event. Session
  credentials get `403`.
- `POST …/goals/:goalId/answer` — attributes the answer to the authenticated
  user; resolves `waiting_for`.
- Session-only (owner capability): `…/transition` (draft→active,
  active⇄waiting_on_user), `…/request-verification`, `…/handover`. The owner
  cannot reach `done`, `stopped` or `paused`.
- Verifier-only (capability bound to goal + criteria revision + attempt):
  `…/verdict` with one result per current criterion and evidence hashes. The
  server checks completeness, hashes and regular files under `evidence/`,
  then commits `done` + heartbeat removal + notification in one transaction.
- Every lifecycle write is compare-and-set on `revision` and checks
  `generation`.

### 4.3 Scheduling and admission

- Keep the trigger scheduler and its reminder rows as the delivery substrate
  (scores 75 %: leader lease, CAS slots, idempotency keys).
- Bind each goal reminder to `goal_id` (first-class column), not a folder
  string. `wakeGoal` resolves by `goal_id` and carries a stable idempotency
  key `goal:<id>:<source>:<event_id>` and the rendered reason (G08, G09).
- **Admission gate** in `trigger-fire.ts` before a goal prompt dispatches:
  flag on, state active/waiting/verifying, not paused, generation current,
  wake cap and session cap and credit cap reserved atomically. Refusal writes
  an event and sets `blocked_reason` (G10, G13, G15).
- **No idle model tax:** in `waiting_on_user`, the reminder is suspended; the
  answer endpoint or `next_due_at` (chase deadline the agent sets, bounded)
  wakes it. Heartbeat runs only while `active`.
- New worker job `worker/jobs/goal-reconciler.ts` (leader only, one tick per
  60 s, bounded per item): finishes pending outbox steps, detects orphan
  owners (owner session failed, no successor), stale verifiers (>24 h),
  goals with no progress, and emits notifications. Listed in
  `worker/jobs/index.ts`.

### 4.4 Sandbox side

- The CLI (`apps/cli/src/commands/goals.ts`) stops writing lifecycle fields.
  `transition`, `verify`, `verdict`, `handover`, `check` call the API. Local
  file writes are limited to the brief, `log.md` notes and `evidence/`.
- The after-turn hook (`harness/shared/on-idle-hook.ts`) always runs the goal
  check, also when a custom hook exists, and finds the owner from the API by
  session id, not a regex on the file (G12). The check is idempotent per turn
  id.
- Successor adoption (`trigger-fire.ts:593`, `create-session.ts:493`): when a
  reminder successor is created for a goal owner, the same transaction sets
  `owner_session_id`, bumps `generation`, writes the event. Handover and
  verifier start: create the session idle, register it, then queue the first
  prompt (G03, G04).
- `kortix-goals` skill: rewrite to the new contract. Remove every rule that
  is now a code check, so the skill does not claim protection it lacks (G25).

### 4.5 SDK and clients (load the **sdk** skill; TDD mandatory)

- `packages/sdk` goal client methods keep their exported names and types.
  Their internals call the new routes instead of composing Files + reminders
  + prompts. Fix `setProjectGoalBinding` (reads legacy `goal.json`, G24).
- `useGoals` keeps polling for now; add the `capabilities` per goal from the
  API so the UI shows only allowed controls (G16).
- Web: show `blocked_reason`, spend vs caps, verified vs agent-reported
  criteria (a green check from the file must not read as verified), and the
  exact pause/stop semantics.
- TUI create uses `createProjectGoal`, not a model prompt (G24).
- Mobile: no native Goals screens in this plan. Notifications deep-link to the web page.

### 4.6 Notifications (P7)

Goal events `needs_you`, `blocked` (credits / caps / failure), `verified_done`,
`verification_failed` go through the existing notification job
(`worker/jobs/notification.ts`) to the assigned user and goal subscribers,
deduplicated per event. Independent of the `notification_center` flag default.

### 4.7 Migration of existing goals

Prod has none (the flag never shipped there). Dev and staging have test goals.

- One idempotent importer (a script under `apps/api/scripts/`): scan goal
  folders, create rows with `legacy_unverified` provenance, bind reminders.
- Imported `done` stays labeled "done before verification" until re-verified.
- After import, file lifecycle fields are inert.

## 5. Milestones

One canonical branch `goals-prod`. Each milestone lands as one PR into `dev`,
complete on its own, behind the `goals` flag (off by default, so no user sees
a half state). Order matters: M1 is the foundation of everything else.

| M | Scope | Closes | Proof (targeted, real surfaces) |
|---|---|---|---|
| **M1 Authority** | Migration + `project_goals*` tables, API routes, Actor rules, CAS + generation, verifier verdict gate, CLI calls API, importer, skill rewrite. | P1, P2 (authz), P5 (create/stop), G01 G02 G05 G14 G24-bind G25 | Failing tests first for the forgery probes from the Sol audit (forged done, PASS-only report, self-pause, `unlimited` caps). New flows GOAL-1 (create/idempotency), GOAL-2 (real CLI lifecycle), GOAL-3 (authz matrix: owner, member, read-only, admin, session token, verifier token, anonymous). |
| **M2 Admission + cost** | Admission gate in trigger fire, caps reserved before dispatch, credit cap via gateway spend attribution, no-heartbeat waits, `blocked_reason`, flag-off gate, pause/stop cancel queued wakes. | P2 (effect), P4, P8, G06 G10 G13 G15 G20 | GOAL-4 (pause/stop/flag-off during queued, running, verifying), DB suite `integration-goal-admission` (two claimants, lease expiry, fake clock across UTC midnight, cap exhaustion). |
| **M3 Durability** | Successor adoption, idle-first handover/verifier, outbox + reconciler job, mandatory idempotent after-turn check. | P3, P5, G03 G04 G07 G11 G12 | GOAL-6 (real Platinum sandbox killed → successor owns goal → answer reaches it → verified done), DB suite `integration-goal-outbox` (crash after each step). |
| **M4 Identity + inventory + notify** | `goal_id` on reminders and wakes, event idempotency, table-backed inventory with ACL, capabilities per goal, notifications. | P6, P7, G08 G09 G16 G17 G18 G21 G22 | GOAL-5 (two same-slug personal goals; CR wake hits the right one; duplicate event = one wake), notification assertion per event kind. |
| **M5 UI that does not break** | U1–U8: capabilities-driven controls, pending/error/retry on every control, revision `409` → refresh, full inventory + empty/404 states, verified vs reported criteria, `blocked_reason` + spend, TUI on the SDK. Docs (`apps/web/content/docs/guide.mdx` Goals section, `developers.mdx`, `packages/sdk/README.md`), operator runbook in this skill's `references/`. | U1–U8, G23 G25 G26 | One Playwright journey `goals — create, answer, pause, verify` (template → waiting → answer → pause/resume → verified done; read-only viewer sees no controls; a forced `409` refreshes; a forced create failure retries to one goal). agent-browser demo video, both themes, 720 × 480, desktop shell. |
| **M6 Break it on dev** | Deploy each milestone to dev. Run every failure path on purpose, then dogfood ≥ 10 real goals in the Kortix org. | the bar | Break matrix (section 5.1) all green on dev. Slack round trip with a real person, a killed sandbox, one goal waiting ≥ 3 UTC days across a deploy. Record wakes, credits, events. |
| **M7 Ship** | Flag stays, default off. Remove `wip: true` (its "Not recommended yet" label contradicts the bar). Promote to Production (needs the explicit release approval). Verify in prod on a Kortix-org project. Tell the team. | — | Release suite green incl. GOAL-1…6 tagged `deployed` where safe; prod `/health` at release SHA; one goal created, answered, paused, resumed and verified done in prod. |

### 5.1 Break matrix (M6 exit gate)

Each row is run on purpose on dev, with the expected result asserted on the
API read-back and on the page.

| # | Break | Expected |
|---|---|---|
| B1 | Agent writes `state: done` / `paused_at` / caps into GOAL.md | No effect on the record; page unchanged; event `ignored_file_edit` |
| B2 | Verifier report with `PASS` only, missing a criterion, or stale evidence | `422`; goal stays `verifying`; page shows why |
| B3 | Kill the owner sandbox mid-goal | Successor owns the goal within 10 min; answers reach it; done still possible |
| B4 | Pause while a turn runs; stop while a wake is queued | Pause: no new turn after the running one; stop: queued wake cancelled, running turn aborted |
| B5 | Two people pause and stop the same goal at once | One wins; the other gets `409` and the page refreshes to the true state |
| B6 | Credits run out mid-turn; top up | `blocked_reason: credits`, one notification; one continuation after top-up |
| B7 | Wake cap hit; event wake arrives | Refused before dispatch; no turn; next day resumes |
| B8 | Flag turned off with goals active, waiting and verifying | Zero goal turns afterwards; page read-only; flag on again → owner resumes explicitly |
| B9 | Two same-slug goals by two people; a CR merges for one | Only the right goal wakes, once |
| B10 | Create fails after each step (network cut) | Retry yields exactly one goal, one session, one reminder |
| B11 | Goal waits on a person for 3 days | Zero model turns until the answer or the deadline |
| B12 | API worker restarts / leader moves during a due wake | One wake delivered, one counter increment |
| B13 | Read-only viewer, removed member, session token on human-only routes | No control shown; `403` on direct call; no side effect |
| B14 | Drive unavailable | Lifecycle keeps working; `blocked_reason: storage`; page explains |

Every milestone also: T0 (`tsc`/lint) for touched packages, the named test
files only, the route manifest regenerated
(`bun run apps/api/scripts/dump-routes.ts`), flows' `meta.routes` synced,
`tests/spec/end-to-end.md` updated with the GOAL-* contracts.

## 6. Product brief

```md
Job: A team member hands an agent a bounded outcome (1–14 days) once and wants
  to be pulled in only when they are needed, then trust the proof that closes
  it. Today they babysit a chat session, set reminders by hand, and check the
  result themselves.
Change: Goals with a server-owned lifecycle, still behind the `goals` flag
  (default off); no new surface beyond the existing Goals page, composer
  entry, CLI group and SDK methods.
Reuse: trigger scheduler + reminders (delivery), Review Center (approvals),
  notification job, session successors, Drive (brief + evidence), existing
  Goals UI and SDK exports. New: 4 tables, one route group, one worker job.
Metric (does it break): break matrix B1–B14 green on dev and staging; in prod,
  0 goal-route 5xx per 1,000 requests above the API baseline, 0 goals stuck
  > 24 h without a valid wait, 0 unhandled errors from the Goals page.
Metric (does it work): verified-done rate — % of activated goals that reach
  verified done within 14 days inside their caps; ≥ 60 % on ≥ 10 dogfood
  goals, 0 false-done.
Guardrails: 0 forged done/pause accepted; 0 turns started after pause/stop;
  0 turns while waiting on a person; 99 % of due wakes dispatched in 5 min;
  < 1 % of open goals stuck > 24 h without a valid wait.
Compat: flag `goals` default off; SDK exported names unchanged; legacy
  GOAL.md/goal.json imported as unverified.
Kill: any accepted forged done/approval or turn after stop → suspend goal
  execution (flag-off gate) the same day. Verified-done rate < 30 % after 30
  activated goals → stop expansion, fix scope before more automation.
```

## 7. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Goal-state authority | **Decided 2026-11-06: B, server goal record** (section 3). |
| D2 | Does pause/stop abort a turn already running? | Abort for stop; let a running turn finish for pause, but it cannot commit lifecycle changes or start effects (generation check). |
| D3 | Default caps | 12 wakes/day, 10 sessions, a credit cap per goal shown at create (default from real dev cost data in M6). Agent cannot raise; owner can. |
| D4 | Who may answer for a goal | Assigned user and project admins; others get `403`. Approvals only through Review Center. |
| D5 | Verifier | Platform-created session with read-only evidence access, excluded from owner lineage; a `human_acceptance` criterion needs a Review Center approval. |
| D6 | Supported deployment | Platinum-backed projects only. Self-host without Platinum shows "unavailable" (already the flag rule). |

## 8. Risks

- **Scope.** M1–M4 are mostly backend: 4 tables, ~10 routes, one job, CLI and
  hook rewiring. This is the 90 % of the work the UI-first passes skipped.
- **SDK contract.** Method signatures must not change; behavior moves server
  side. SDK TDD rules apply to every method touched.
- **Old daemons.** A warm box with an old CLI writes file lifecycle fields.
  After M1 those are inert, so the worst case is a stale display until the
  box restarts. The admission gate keeps cost safe.
- **Platinum dependence.** Drive outages block brief and evidence reads; the
  lifecycle keeps working and the goal shows `blocked_reason: storage`.

D2–D6 use the recommendation unless the owner overrides it before the
milestone that needs it (D2, D3 → M2; D4, D5 → M1; D6 → M7).

## 9. After this plan

- Flag default-on for eligible projects, after 2 × 30-day windows that meet
  the guardrails and ≥ 100 matured goals.
- Native mobile Goals list and answer.
- Mediated external effects (every connector write goal-scoped and
  idempotent) before advertising high-stakes outcomes.
- Stage 2 `goal.ts` on top of the B record (`runtime-design.md`), after a
  benchmark of custom QuickJS vs Temporal / Restate / Inngest. Correction from
  the Astra audit: Restate does not allow free step reordering; step identity
  needs name + iteration, not name alone.

## Sources

- Sol code audit and Astra architecture report, 2026-11-06 (session scratch,
  summarized here; gap ids G01–G26 are from the Sol audit).
- `system.md`, `decisions.md`, `runtime-design.md`, `live-runs.md` in this
  folder.
- 2026-10-12 planning sync: stateless sandboxes on Platinum volumes,
  harness-agnostic transcripts, verifiable-eval loops dogfooded on Kortix.
  Goals is the product form of that loop; the engineering loop is the first
  dogfood goal in M6.
