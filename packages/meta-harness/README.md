# @kortix/meta-harness

The harness of the **Kortix Agent**, the platform-owned agent a user talks to
(wire name `meta`). This package is an OpenCode config folder, like the
project starter template, but it belongs only to the Kortix Agent.

```
opencode/
  plugin/kortix-goals.ts   goal tools, the goal loop, goal memory
  command/goal.md          /goal <outcome> | /goal resume | /goal
  lib/goals.ts             pure goal state and loop rules (tested)
test/                      bun tests for the rules and the plugin
scripts/build.ts           builds dist/opencode/ (plugins bundled to .js)
```

## Goals

A goal is an outcome the agent keeps working on until it is truly done.

- **Tools:** `goal_create`, `goal_task`, `goal_update`, `goal_wake`, `goal_list`.
- **Loop:** when the goal's session goes idle, the plugin sends a continuation
  prompt that re-states the goal, the acceptance criteria and the task board.
- **Memory:** every turn's system prompt carries the live board, and
  compaction keeps it. A reset context restarts from the truth.
- **State:** `~/.local/share/kortix/goals.json` on the box (override with
  `KORTIX_GOALS_FILE`). It is outside the workspace, so it never dirties a repo.

The harness enforces these rules, not the model:

| Rule | Effect |
| --- | --- |
| The user presses Stop | Every active goal of the session is `paused`. |
| A user prompt arrives within 2.5 s of idle | The loop yields to it. |
| 3 turns in a row with no tool call | `blocked`, and the agent reports. |
| Task board unchanged for 3 turns | The next continuation demands a re-plan. |
| Task board unchanged for 8 turns | `blocked`. |
| `max_continuations` reached (default 200) | `limited`. |
| `goal_wake` set in the future | No continuation until due. |
| `complete` | Needs one evidence item per acceptance criterion. |

Kill switch: `KORTIX_GOAL_LOOP=0` in the sandbox environment stops
continuations. The tools keep working.

## How it ships

1. `pnpm --filter @kortix/meta-harness build` writes `dist/opencode/`. The
   plugin is bundled with its dependencies, so the sandbox needs no
   `node_modules` and no network at boot.
2. The API image builds the same folder in its `meta-harness` stage.
3. The meta image copies it into `/ephemeral/kortix-master/opencode/`, the
   OpenCode config dir of the meta sandbox
   (`packages/shared/src/sandbox/meta-dockerfile.ts`).
4. The meta image fingerprint hashes `opencode/`. A change here rebuilds the
   image on the next Kortix Agent session.

`pnpm worktree start` builds it with the other runtime artifacts.

## Commands

```
pnpm --filter @kortix/meta-harness test
pnpm --filter @kortix/meta-harness typecheck
pnpm --filter @kortix/meta-harness build
```

## Known limits

- A goal wake timer lives in the OpenCode process. A sandbox that is stopped
  while it waits does not wake by itself. The next user message or a
  platform trigger resumes it, and the loop continues on the next idle.
- The continuation cap counts turns, not money. Worker spend is not counted
  here.
