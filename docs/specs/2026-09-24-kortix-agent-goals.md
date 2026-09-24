# Kortix Agent goals — harness level

Status: slice 1 built, 2026-09-24. Branch `kortix-agent` (PR #7602).
Code: `packages/meta-harness` (see its README).

## Problem

The Kortix Agent works one turn at a time. When the turn ends, the work
stops. A user cannot hand it an outcome that takes hours or days and walk
away.

## Decision

Goals live in the **agent harness**, not in the platform API. The harness is a
standalone package, `packages/meta-harness`: an OpenCode config folder for the
Kortix Agent only, baked into the meta sandbox image as its config dir. It
needs no database table, no route and no daemon change.

This is the model of Codex `/goal` (continue when the thread goes idle) and
Claude Code's `/goal` and `/loop` (Stop-hook continuation), which both run in
the harness.

## Mechanism

| Concern | Harness mechanism |
| --- | --- |
| State | `~/.local/share/kortix/goals.json`, written by the goal tools |
| Continue | OpenCode plugin `event` hook: `session.idle` → `promptAsync` continuation |
| Memory | `experimental.chat.system.transform` injects the board every turn; `experimental.session.compacting` keeps it through compaction |
| Stop | `session.error` with `MessageAbortedError` pauses the goals |
| Stuck | `tool.execute.after` counts actions; unchanged board → re-plan, then block |
| Waiting | `goal_wake` defers continuation; workers are awaited with `kortix sessions wait-for` |

The continuation reaches OpenCode directly, so the platform sees it as a
runtime-initiated turn. The daemon announces it (`turn_begin`), so the turn
ledger and the sandbox deadline renewal apply as to any turn.

## Prior art

Research notes (Codex source at `c19dcd975d8c`, Claude Code docs, Ralph loop,
Anthropic long-running harness posts) are in the session scratchpad of
2026-09-24; the rules adopted are: re-state the goal on every continuation,
completion needs evidence per criterion, the harness (not the model) enforces
stuck and cap limits, and "blocked" is never "this is hard".

## Next slices

1. Live verification on a real Kortix Agent session (this branch).
2. Wake across sandbox stop: schedule a pinned one-off trigger from
   `goal_wake` when the wait exceeds the idle window.
3. Show goals in the web session view (read the goal file through the daemon).
4. Count worker spend against a goal budget.
