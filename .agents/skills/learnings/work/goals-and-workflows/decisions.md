# Decisions

Update this file whenever a decision is made or changes. Newest first inside
each section. "Marko" = the decision owner.

## Decided

- 2026-10-20 · **Ship the simple goal loop first, behind a flag; workflows
  next.** Stage 1 merged (#10314, #10589, #10591), flag `goals` off by
  default. (Marko)
- 2026-10-20 · **A flag gates every surface.** Off: nothing of Goals shows
  except the flag. On: everything shows and loads. Same as Rooms. (Marko)
- 2026-10-20 · **`reminders` on by default; `volumes` stays off by default.**
  (Marko)
- 2026-10-20 · **Persist plans and open thoughts in the repo**, under
  `.agents/skills/learnings/work/`, so another person can pick them up. (Marko)

- 2026-10-19 · A goal is a **folder in Files**, not a table or a separate
  volume. Visibility is the folder's grants. (Marko)
- 2026-10-19 · Chase people on **whatever connectors the project has**; no
  hardcoded channel. (Marko)
- 2026-10-19 · **Full autonomy inside the goal's constraints.** (Marko)
- 2026-10-19 · **Never Daytona** for goal sessions or tests. (Marko)
- 2026-10-20 · **Plan before building new primitives.** A state machine or
  workflow runtime gets a written design and Marko's explicit decision before
  code. (Marko)
- 2026-10-20 · **Rooms is the one messaging layer** for agents and people
  (flag `agent_rooms`, PR #10308). (Marko)

## Recommended, waiting for a decision

- **Human approvals:** do not use "a person approved" as a success criterion
  in stage 1 (the verifier cannot read the coordinator's transcript, so it
  cannot see the approval; dev run 2026-10-20). Stage 2: the platform records
  approvals (a rooms message from the person's verified identity, or an
  approve button).
- **`check --enforce` repairs mechanically:** re-arm a missing heartbeat and
  write `reminder_id` itself instead of prompting the model.
- **Stage 2 model:** durable TypeScript workflow (`goal.ts`), name-keyed replay,
  enforcement on effects in the API (`runtime-design.md`).
- **Runner location:** the Kortix API background loop, inside QuickJS.
  Alternative: a control session per wake.
- **Names:** `goal` (the outcome) and `workflow` (the program), both exported
  from `@kortix/sdk/workflows`; `goal()` = `workflow()` + objective, criteria,
  constraints and the verification gate.
- **Goals area:** a top-level `Goals/` area in the project drive (like
  `Users/` and `Company/`), not a volume per goal.
- **Who may change a running goal's program:** the coordinator, freely for new
  steps, retries and waits; the owner approves changes to criteria,
  constraints, budget and irreversible actions; nothing may remove the
  verification.

## Open

- On-demand agent definitions in the session create API.
- How a person in Slack becomes a verified room member (asked the rooms
  session, 2026-10-20).
- Whether the API goal runtime can receive room messages and idle notices as
  events directly (asked the rooms session).
- TypeScript-first Kortix (`kortix.config.ts` compiling to the manifest): a
  separate initiative, related to the `kortix.yaml` v3 redesign.
- Software factory as a workflow: one definition, one running copy per issue.
- Node share on Platinum prod: a Kortix-org canary after all 6 prod hosts run
  the new host agent; Marko schedules.
