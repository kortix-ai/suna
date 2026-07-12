# Execution prompt — `@kortix/sdk` v2

> Paste everything below the line into a fresh session. Nothing else is needed.

---

Execute the `@kortix/sdk` v2 restructure using **subagent-driven development**.

**Read these four first, in order. They are the contract; do not re-derive them:**

1. `packages/sdk/PROGRESS.md` — **what is already done and what is next.** Other sessions may be running. Claim your task in its own commit before working, and update the file before you finish.
2. `docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md` — the 10 tasks, with exact code and commands. Follow it literally.
3. `docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md` — why each decision was made, and the evidence behind it.
4. `packages/sdk/AGENTS.md` — the package's hard rules. Auto-loads for subagents working in `packages/sdk`.

Invoke `superpowers:subagent-driven-development`. Work in this worktree (`suna-ts-sdk`, branch `ts-sdk`).

## Prime directive

**We are shipping an SDK that strangers will `npm install`. A broken release cannot be fixed forward — it lands in their build, on their schedule.**

Correctness beats speed, every time. There is no deadline that justifies a green suite you got by weakening a test. If you are unsure whether something is right, stop and say so. **"NOT YET" is always an acceptable answer. A wrong "YES" is not.**

## Non-negotiables

- **TDD.** Invoke `/tdd`. RED → GREEN → REFACTOR. Write the failing test, **run it and watch it fail for the right reason**, then implement. *A test you have never seen fail is not a test.*
- **Never hand back a red suite.** Loop: run → read → fix → re-run, until green.
- **Loop on the CODE, never on the TEST.** Deleting, `skip`-ing, weakening an assertion, filtering the run, re-recording a snapshot, or `catch {}`-ing the throw to reach green is **forbidden**. If the test itself is wrong, that is a decision — stop and tell me.
- **Finish on the full suite.** `pnpm --filter @kortix/sdk test`. Check the count against the **1046** baseline. `Ran 0 tests` is not a green run. `typecheck` is **not** verification.
- **Never edit `version` in `packages/sdk/package.json`.** It is inert; the release stamps it.
- **Exported names are the public API — including types.** Rename ⇒ breaking. Alias, never replace.
- Commit after each task, on this branch. **Do not push, do not open a PR** without asking.

## End every task with

> **Shippable to production: YES / NO / NOT YET**
> - **Verified:** what you ran, and its real output (paste it).
> - **Unverified:** every surface you did not exercise, and why.
> - **Risk:** what could still be wrong, concretely.

## Delegation map

Model: **Fable orchestrates. Sonnet 5 executes.** But not uniformly — the plan is a *chain*, not a fan-out. Task 3's snapshot is the only test Task 4 has, because a file move has no behaviour to assert. **Parallelising removes the safety nets. Do not fan out.**

> **One session owns this chain.** `PROGRESS.md` is a handoff across *time*, not a work queue across *space*. Do not run a second top-level session against `packages/sdk` — Tasks 4 and 5 touch both export maps, `src/index.ts`, the tripwire, and 146 moved files, so there is no non-colliding task to give it. Sessions in one worktree also share a filesystem and a git index: a `bun test` during a `git mv` reads files that no longer exist. Throughput comes from **subagents inside this session**, sequenced against the chain.

**Model selection is explicit, not automatic.** There are no agent definitions in this repo, so a subagent with no `model` argument **inherits the parent's model** — you would get a fleet of Fable orchestrators. When dispatching, pass `model: "sonnet"` on the `Agent` call for every task marked Sonnet below. Omit `model` only where the table says *orchestrator* (that work runs in the main loop, on Fable).

| Tasks | Who | How to dispatch | Why |
|---|---|---|---|
| 1, 2, 3, 6, 7, 8, 10 | Sonnet 5 subagent, one per task | `Agent(model: "sonnet", …)` | Scoped, mechanical, locally gated. Task 6's e2e is hermetic (mock upstream, no live stack). |
| **4** (the 29.5k-LOC move) | **One long-lived agent, or the orchestrator** | one `Agent(model: "sonnet", …)` for the *whole* task, or do it in the main loop | 146 files moved (97 source + 49 colocated tests), hundreds of import repairs. **Do not split its three commits across three fresh subagents** — each would re-learn the import graph from scratch and thrash. |
| **5** (root canonical, aliases) | **Orchestrator (Fable) — do not delegate** | run in the main loop; no `Agent` call | Resolves `TS2308` and names aliases — public API judgment. An agent told "make the errors go away" will rename a symbol to satisfy the compiler. |
| 9 | Sonnet 5 for steps 1–5; **step 6 needs a browser** | `Agent(model: "sonnet", …)` for 1–5, then stop | See hard stops. |

## Hard stops — come back to me, do not decide alone

1. **Task 2, first run.** Nothing has ever installed and imported the tarball. If the smoke test fails, that is a **real pre-existing bug**, not something to loop on. Report it.
2. **Task 3, before committing the snapshot.** Show me it. It becomes ground truth for everything after.
3. **Task 5, Step 12 — the snapshot diff.** Additions are fine. **A removal or rename means a broken consumer.** Never accept that diff to get green.
4. **Task 9, Step 6.** Loading `dist/kortix.global.js` in a real browser, streaming through a live stack, asserting `instanceof Kortix.ApiError` under the bundle. Needs `pnpm dev` + a real PAT + a real sandbox. Do not claim D2a/D3 without it.

Also stop if: the same failure survives three different fixes (invoke `superpowers:systematic-debugging` instead of guessing), or you are about to change what a test asserts.

## Known unknowns — do not paper over these

- Task 5's barrel resolves **7 ambiguities** found by a `tsc` probe run *before* the restructure. New `TS2308`s may appear. Each is new information: resolve with an explicit re-export, or an alias if it is genuinely two concepts. Note it in the CHANGELOG.
- Task 6 names facade methods (`tokens.createCliToken`, `gateway.sessions`) that are **unverified**. `grep` for the real names first.
- Task 7's regex may flag a guarded read whose `typeof` guard sits on the previous line. Widen the window; **do not weaken the pattern**.

## Out of scope — do not start

React Native transport seam · migrating `apps/web`'s 340 import sites · Lumen productionisation (JSON-file ownership store, in-memory rate limiter, anonymous sandbox cost). All three are recorded at the bottom of the plan.

## Start

**Step 1 — commit the docs**, so Task 1 starts from a clean tree. Exactly these seven, and nothing else:

```bash
git add AGENTS.md \
        packages/sdk/AGENTS.md \
        packages/sdk/CLAUDE.md \
        packages/sdk/PROGRESS.md \
        docs/superpowers/specs/2026-07-10-sdk-v2-structure-and-distribution-design.md \
        docs/superpowers/plans/2026-07-10-sdk-v2-structure-and-distribution.md \
        docs/superpowers/plans/2026-07-10-sdk-v2-execution-prompt.md
git status --short          # verify NOTHING else is staged
git commit -m "docs(sdk): v2 spec, plan, execution prompt, agent rules, and progress tracker"
```

`packages/sdk/CLAUDE.md` is a **symlink** to `AGENTS.md` (git mode `120000`). Commit it as-is; do not dereference it.

**Step 2 — verify the baseline before changing anything:**

```bash
pnpm --filter @kortix/sdk typecheck    # expect exit 0
pnpm --filter @kortix/sdk test         # expect 1046 pass, 0 fail, 65 files
```

If that is not what you see, **stop and say so.** Something changed under us, and every number in these documents is suspect until you know what.

**Step 3 — begin Task 1.** Do not ask permission to begin; just stop at the hard stops above.
