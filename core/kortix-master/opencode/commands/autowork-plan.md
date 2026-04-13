---
description: "Plan before execution. Writes PRD + test spec artifacts under .kortix/docs/plans/ and stops before implementation."
agent: general
---

# Autowork Plan

You are in **autowork planning mode**.

This command is the planning half of the autowork system. Your job is to make the task execution-ready, not to implement it.

## What to produce

Create project-local planning artifacts under `.kortix/docs/`:

1. A context snapshot in `.kortix/docs/context/`
2. A PRD in `.kortix/docs/plans/prd-<slug>.md`
3. A test spec in `.kortix/docs/plans/test-spec-<slug>.md`
4. Optionally a launch hint in `.kortix/docs/plans/launch-hint-<slug>.json`

## Rules

- Read the code and current project context first.
- If the request is ambiguous, clarify only the highest-leverage unknowns.
- Keep the plan concrete: files, behaviors, constraints, verification, risks.
- Do **not** implement unless the user explicitly asks you to.
- If the task is already concrete, still write the artifacts — just keep them lean.

## Output contract

Your final response must include:

- the paths you wrote
 - the recommended execution mode:
   - `/autowork` for single-owner execution
   - `/autowork` with `task_create` for parallel work
- the key risks or open questions, if any
