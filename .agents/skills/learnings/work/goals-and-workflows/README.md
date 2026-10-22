---
title: Goals and durable workflows
status: stage 1 merged on dev (flag `goals`); stage 2 planning only
owner: Marko (decisions)
updated: 2026-10-21
---

# Goals and durable workflows

**The problem.** A user gives an objective once ("close my old bank account and
walk away", "secure EUR 2.5M of grant funding", "rank #1 for X", "rewrite the
service in Rust") and an agent owns it until it is verifiably true: over days
or months, chasing people on the project's connectors, waiting between steps,
surviving sandbox failures.

**The lesson that shapes everything.** In live runs, written rules failed 4 of
7 times (the model used the blocking question tool, approved its own work, set
the goal up by hand). Each failure was fixed only by code outside the model's
discretion. Every new rule is a code check.

## Files

| File | What it holds |
|---|---|
| `system.md` | stage 1 as built: flow, folder, lifecycle guards, platform parts, dev proof, weak spots |
| `runtime-design.md` | stage 2: a goal's program as durable TypeScript (`goal.ts`) on the Claude Code Workflow-tool model; where it runs; enforcement on effects in the API |
| `state-machines.md` | the kinds of state machine considered and why the recommendation moved from statechart to durable workflow |
| `decisions.md` | decided / recommended / open, dated. Update it whenever a decision changes |
| `live-runs.md` | the local runs behind the lesson above |

## What was discussed (2026-10-19 to 2026-10-21)

1. **Where goal state lives.** A folder in Files (`Goals/<slug>/`), not a DB
   table or a volume per goal. The CLI in a sandbox and the SDK outside read the
   same folder.
2. **State machine or workflow.** Statecharts (XState), durable workflows
   (Temporal, Restate, Inngest, Claude Code Workflows), DAGs, agent graphs,
   behavior trees, Petri nets. Recommendation: durable workflow code with
   name-keyed replay (`state-machines.md`).
3. **Same model as the Claude Code Workflow tool.** `agent`, `parallel`,
   `pipeline`, `phase`, typed results, plus what goals need and Workflows lacks:
   `waitFor` (events), `ask` (a person), `sleep` (weeks), `verify` (a gate).
   Exported from `@kortix/sdk/workflows`; `goal()` = `workflow()` + objective,
   criteria, constraints, verification. Two names: goal = the outcome,
   workflow = the program.
4. **Where it runs, how it is enforced, deployed, changed.** Runner in the API
   background loop with leader election, user code in QuickJS
   (`@earendil-works/pi-codemode`); alternatives a control session per wake or a
   Cloudflare Worker (rejected for now: new subprocessor, second deploy path).
   Enforcement on effects in the API. "Deploy" = save and validate `goal.ts`.
   Change = edit + validate; the owner approves changes to criteria,
   constraints, budget, irreversible actions (`runtime-design.md`).
5. **Rooms as the messaging layer.** Agents and people talk through rooms
   (flag `agent_rooms`); `ctx.ask` and worker results ride on it; an approval
   counts only from the person's verified identity.
6. **The software factory as a workflow.** One definition of what happens to an
   issue (found → groomed → worked → PR → merge gate → merged → verified on
   dev), one running copy per issue, instead of cron triggers plus skill prose
   in the company repo.
7. **TypeScript-first Kortix.** `kortix.config.ts` compiling to the manifest
   (the CDK / Pulumi pattern). A separate initiative, tied to the
   `kortix.yaml` v3 redesign.
8. **Not now:** a per-goal "Kortix Machines" primitive was started without a
   design and stopped. New primitives get a written design and an explicit
   decision first.

## Pick it up

1. Read `decisions.md`, then `system.md`.
2. Stage 1 follow-ups (small, mechanical):
   - `kortix goals check --enforce` re-arms a missing heartbeat and writes
     `reminder_id` itself instead of prompting;
   - dev proof of a Slack round trip, a successor after a real box failure, a
     multi-day wait;
   - a Goals view in the web app (design on a canvas first).
3. Stage 2: get the open items in `decisions.md` decided, then build the
   smallest `goal.ts` runner that runs one real goal end to end.
