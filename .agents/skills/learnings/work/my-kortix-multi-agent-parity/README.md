---
title: My Kortix multi-agent parity with Claude Code
status: building on branch `my-kortix-v2` (PR #11240, held for Marko); contract 1e91106e5a
owner: Marko (decisions)
updated: 2026-10-30
---

# My Kortix multi-agent parity

**The problem.** My Kortix is the one agent a person talks to. It must hand
work to other agents, talk to other sessions, lead a team, and run workflows,
with the same tools and the same feel as Claude Code's subagents, agent view,
agent teams, cross-session messaging and dynamic workflows. The owner's
mandate: "flawless & async & non blocking so u can keep talking to MyKortix".
The person keeps talking to My Kortix while everything it started runs.

**The contract** is fixed in `packages/api-contract/src/multi-agent.ts`
(`@kortix/api-contract/multi-agent`): every route, body, result, limit and
metadata key. The delivered message text is
`packages/shared/src/peer-message-prompt.ts`. `RUNTIME_CAPABILITIES`
(`packages/api-contract/src/runtime-relay.ts`) gained `session.messaging` and
`session.team_tasks`.

## Parity table

| Claude Code | Kortix | Status |
| --- | --- | --- |
| `Agent` tool, custom subagents | `agent` tool; a project agent with `mode: subagent` or an inline `agent` spec | shipped before this work |
| Background subagents (default in the main conversation) | `run_in_background` defaults to `true` at depth 0 | building (kortixd) |
| Subagent `name`, message a running subagent | `agent({ name })` → metadata `agent_handle`; `send_message` to it | building (kortixd, API) |
| Fork (child with the parent's conversation) | `agent({ fork: true })` | building (kortixd); the parameter name is Track A's |
| `TaskStop` | `task_stop` | building (kortixd) |
| `SendMessage`, `ListAgents`, `/list-agents` | `send_message`, `list_agents`; `kortix sessions message`, `sessions reachable` | building (kortixd, API, CLI done) |
| `crossSessionInbound` accept / hold / refuse, approval dialog | session `inbound`; held messages approved in the session; `kortix sessions inbound` | building (API, UI, CLI done) |
| `notify_when_idle` | same name on `send_message` | building (API) |
| Agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) | flag `agent_teams` (off by default) | building |
| Shared task list (`TaskCreate`/`TaskList`/`TaskGet`/`TaskUpdate`), file-locked claim | `task_create`/`task_list`/`task_get`/`task_update`; table `session_tasks`; atomic claim, `409 task_taken`; `kortix tasks` | building (API, kortixd; CLI done) |
| Teammate idle notification with the final answer | idle notice into the lead (`projects/subagent-notice.ts`) | building (API) |
| Shutdown request / response | `send_message` `type: shutdown_request \| shutdown_response`, `approve` | building |
| Agent view (`claude agents`): states, needs input, peek, attach | `/projects/<id>/sessions?view=board`; `board_state`, `attention`, `result_excerpt`; `kortix sessions status --json` | building (API, UI; CLI done) |
| Agent panel under the prompt | agent strip in the session (subagents, teammates, workflows) | building (UI) |
| Dynamic workflows, `/workflows` progress view | `workflow` tool, live card | shipped before this work |
| Workflow pause / resume / restart agent / stop / save | card controls; `POST /kortix/runtime/workflows/:runId/control` | building (kortixd, UI) |
| `Large workflow` warning above 25 agents | `WORKFLOW_LARGE_AGENT_COUNT` = 25 | building (UI) |
| `ultracode` keyword | the word in a typed message means "run a workflow"; composer highlight | building (prompt done, UI) |
| `/deep-research` bundled workflow | not started | follow-up |

## Decisions (2026-10-30, Marko: "U decide")

1. Tool names are lower-case, like `agent` and `workflow`: `send_message`,
   `list_agents`, `task_create`, `task_list`, `task_get`, `task_update`,
   `task_stop`. Cards also map the Claude Code names.
2. `agent` runs in the background by default for separate-session calls at
   depth 0. Deeper children and workflow `agent()` calls stay foreground.
3. Agent teams sit behind a new feature flag `agent_teams` (experimental, off
   by default) with a new `session_tasks` table. Messaging ships unflagged: it
   reaches only sessions the person may prompt, with room limits.
4. Inbound default `accept`; message cap 16,000 characters; `list_agents`
   covers this project, another project only with an explicit `project_id`.

## Deliberate differences

- **Depth 2, not 3.** Separate children nest 2 levels
  (`KORTIX_PI_CLOUD_SUBAGENTS_MAX_DEPTH`). Each level is a real computer.
- **8 workflow agents at once, not 16** (`KORTIX_WORKFLOW_MAX_CONCURRENT`);
  50 agents per run, not 1,000; 2 hours per run.
- **No plan approval** for teammates: a teammate starts working at once.
- **No hooks** (`TeammateIdle`, `TaskCreated`, `TaskCompleted`).
- **Sessions are always cloud sessions.** Every child and teammate has its own
  computer and survives the parent's box. Nothing is local to one machine, so
  there is no socket inbox and no cross-machine mode.
- **Rate limits are the room limits:** 30 messages per minute per sender, a
  duplicate within 60 s is dropped.

## Async model (the live gate)

From My Kortix: start a 3-agent workflow, 2 background hand-offs and a team.
While they run, send 3 unrelated prompts.

- Each prompt is answered within 30 s with no wait on a tool.
- The workflow card keeps updating after its turn ends.
- Notices arrive coalesced into one wake-up; My Kortix reports each outcome in
  1-2 lines.
- The composer stays enabled throughout.

## Files

- Contract: `packages/api-contract/src/multi-agent.ts`, `packages/shared/src/peer-message-prompt.ts`.
- CLI: `apps/cli/src/commands/sessions-peer.ts`, `apps/cli/src/commands/tasks.ts`, test `apps/cli/src/__tests__/multi-agent.blackbox.test.ts`.
- My Kortix prompt: `apps/api/src/projects/lib/my-kortix-prompt.ts` (section "How you work").
- Docs: "Agents working together" and "Workflow controls" in `apps/web/content/docs/developers.mdx`; "Several agents at once" in `apps/web/content/docs/guide.mdx`; `packages/sdk/README.md`; `apps/kortix-sandbox-agent-server/src/harness/README.md`.

## Follow-ups

- A bundled deep-research workflow (`.kortix/workflows/deep-research.js` in new projects).
- Workflow pause from the model: today the person pauses from the card; My Kortix only stops (`task_stop`).
- Cross-project messages beyond `project_id` resolution: no listing across projects.
- Check the async live gate on dev after the deploy, and the notice coalescing under 5+ finished children.
- Promote `agent_teams` out of experimental once the task status lag (a teammate that forgets to mark done) is measured.
