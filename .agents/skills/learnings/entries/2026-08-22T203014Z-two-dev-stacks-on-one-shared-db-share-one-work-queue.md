---
recorded: 2026-08-22T20:30:14Z
commit: 34a69c7d18
---
# Two dev stacks on one shared DB share one work queue

2026-08-22. A `timeline-parity` worktree session's first prompt died inside
OpenCode with `Cannot connect to API …
subdivision-marine-acne-shorter.trycloudflare.com/v1/llm-gateway/v1/chat/completions`.
That host belonged to a different worktree (`mw-perf`) whose quick tunnel had
rotted. Both worktrees reuse the primary local Supabase, so prompt-inbox
delivery, session-lifecycle commands, and sandbox env sync form ONE queue.
`mw-perf`'s API grabbed the job, pushed its `KORTIX_URL`-derived gateway URL
into the other worktree's sandbox, and forwarded the prompt. The owning
worktree's log showed no env sync and no prompt POST, so nothing local
explained the failure.

**The rule.** A sandbox's gateway URL and credentials must come from the
instance that owns the sandbox, never from whichever instance dequeues work.
In local development, run one stack against the shared DB, or create the
worktree with `--db`. When an OpenCode error names a host, grep EVERY stack
log on the machine for that host before suspecting the branch.

**Second incident, same night (~23:00 UTC).** Same worktree, same symptom,
different culprit: the PRIMARY `pnpm dev` stack on `:8008`. Its quick tunnel
(`patches-….trycloudflare.com`) had died; its 1 s lifecycle drain tick still
claimed the worktree's queued prompt, its env sync pushed the dead
`patches…/v1/llm-gateway` URL into the worktree's sandbox, and OpenCode failed
the turn with `Cannot connect to API`. The worktree's log again showed no env
sync and no prompt POST. Two instances in one evening proves this is the
default failure mode of a shared DB, not a one-off.

**The enforcement.** Two layers, both shipped:
1. `pnpm worktree start` (`scripts/worktree/cli.ts`, `warnOnSharedDbCrosstalk`)
   warns at start when another stack is live on the same database, names it,
   and states the remedy.
2. **Instance scoping is the product fix.** `KORTIX_INSTANCE_ID`
   (`apps/api/src/config.ts`, optional, unset in every deployed env) is set by
   the launchers only: `scripts/dev-local.sh` exports `primary`,
   `scripts/worktree/lib/launch-env.ts` exports the worktree name.
   `provisionSessionSandbox` stamps `session_sandboxes.metadata.instanceId`;
   `sandboxBelongsToThisInstance()` (`apps/api/src/projects/instance-scope.ts`)
   is consulted by the lifecycle drain (`drainSessionLifecycleQueue` RELEASES a
   claimed command whose sandbox another instance owns — `queued`, due in 2 s,
   attempt given back, never dead-lettered), by the env-sync project fan-out
   (`propagateProjectSecretsToActiveSandboxes` skips foreign boxes), by the box
   reaper (`reapAndReconcileSandboxes` skips them) and by Platinum's
   `listManagedRunningSandboxes` (`kortix.instance` marker beside `kortix.env`).
   Unset id, or a row with no stamp (legacy), means "mine" — a strict no-op in
   production and never a stranded sandbox. HTTP-path work (proxy, `/start`,
   `prompt_async`) is deliberately unscoped: the browser talks to one stack on
   purpose.

*Incidents:* session `b090016e…` on worktree `timeline-parity` (20:16 UTC,
`mw-perf`'s dead `subdivision-marine-acne-shorter` tunnel) and the same
worktree at ~23:00 UTC (primary `pnpm dev`'s dead `patches…` tunnel); in both,
prompts after the owning instance's own env sync succeeded.
