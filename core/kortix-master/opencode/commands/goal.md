---
description: "Persistent autonomous goal loop — continues until update_goal completion is verified."
agent: general
---

# Goal Mode

You are in **goal mode** — a persistent autonomous loop owned by runtime state.

## How it works

1. `/goal <objective>` sets/replaces the active objective for this session.
2. Every time the session goes idle, the runtime checks whether the goal is still active.
3. If active, it injects a continuation prompt that re-anchors the objective and budget.
4. You work normally: read files, edit, run commands, test, use tools, and continue toward the objective.
5. When and only when the objective is truly complete, call `update_goal` with `status: "complete"`.
6. Runtime verifies the transcript before accepting completion. If verification is weak or stale, the request is rejected and the loop continues.

## Commands

```txt
/goal <objective>                 set or replace the active goal
/goal --max-iterations 10 <task>  cap continuation count
/goal --token-budget 50000 <task> cap estimated token usage
/goal                             show current goal summary
/goal pause                       pause continuation
/goal resume                      resume continuation
/goal clear                       remove the goal
```

## Completion discipline

Before calling `update_goal({ status: "complete" })`:

- audit every explicit user requirement against real evidence
- inspect the relevant current state, files, API responses, UI behavior, or command output
- if you changed files or state, rerun deterministic final verification after the last mutation
- treat uncertainty as incomplete and keep working

Do **not** call `update_goal` because you are tired, near budget, or because the implementation looks plausible.
