# Sandbox mid-session stop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** the sandbox mid-session-stop spec — read its kill-path and constraints sections before starting any task.

**Goal:** Stop killing sandboxes that a user still legitimately owns, and stop rendering the legitimate kills as OpenCode crashes — without letting a sandbox mint its own lifetime.

**Architecture:** `deadline_at` stays the single stop authority. We add *control-plane-attested* observations for the three states that currently earn nothing (waiting on a human, LLM-silent tool work, a reopened session being read), make every park record *why*, and make `/start` own the wake so a parallel health 503 is never read as terminal failure.

**Tech stack:** Bun + Hono + Drizzle (`apps/api`), node-pg-migrate (`packages/db`), React + `@kortix/sdk` (`packages/sdk`, `apps/web`).

**Baseline:** branch `sandbox-mid-dead`, HEAD `f7e5601a5a`.

---

## Global Constraints

Every task inherits these. They come from Spec §8 and are non-negotiable.

1. `deadline_at` remains the **only** stop authority for a running box.
2. A **sandbox-authored** signal may only ever SHORTEN a box's life. Gate every new extend with `isSandboxAuthored(c.get('apiKeyType'), callerKortixSessionId(c))` — and take the session id from `callerKortixSessionId`, never the raw `c.get('sessionId')` (that is the Supabase auth session under `supabaseAuth` and reads every browser user as the sandbox).
3. Session-data ports (8000 / 4096) stay **non-waking on GET** and **non-extending for passive traffic**. Never make `GET /kortix/health` wake-capable.
4. `ABSOLUTE_RUN_CAP_MS` (24h) still clamps every new grant. New grants go inside the existing `LEAST(active_since + CAP, GREATEST(...))` statement — do not add a second SQL writer for `deadline_at`.
5. Do **not** reintroduce the deleted execution lease or any in-box busy probe as a stop authority.
6. **TDD is mandatory** (repo `testing` skill; `packages/sdk/AGENTS.md` for SDK work). Failing test first, watch it fail, then implement.
7. `apps/api` tests are co-located `bun:test`. **`mock.module` is process-global** — see Task 1.
8. Secrets only via `dotenvx set`. Never write a plaintext secret into a tracked file.
9. **Do not merge to `main` without asking Jay.** Open the PR, report it, wait.

---

## File structure

| File | Responsibility | Tasks |
| -- | -- | -- |
| `apps/api/src/projects/reaping/test-support/mock-config.ts` | *(new)* complete `config` module stand-in for `mock.module` | 1 |
| `apps/api/src/projects/stop-reason.ts` | *(new)* the `StopReason` union — one closed vocabulary | 2 |
| `apps/api/src/projects/reaping/sandbox-state-sync.ts` | `applyStoppedState` — require a reason | 2 |
| `apps/api/src/projects/reaping/stop-box.ts` | deadline vs run-cap reason at the stop site | 2 |
| `apps/api/src/projects/reaping/box-reaper.ts` | reconcile reason | 2 |
| `apps/api/src/projects/session-lifecycle/stop.ts` | manual-stop reason | 2 |
| `apps/api/src/projects/runtime-identity.ts` | Path D2 reason (`provider_removed`) | 2 |
| `apps/api/src/projects/sandbox-deadline-policy.ts` | new grants + the stale comment | 4, 5, 6 |
| `apps/api/src/projects/sandbox-deadline.ts` | `observeWaitingOnHuman` writer | 4 |
| `apps/api/src/projects/routes/r4.ts` | turn-question / answer observation | 4 |
| `apps/api/src/sandbox-proxy/routes/preview.ts` | mid-turn + reopen observation | 5, 6 |
| `packages/sdk/src/react/use-session.ts` | `/start` owns wake; resumable predicate | 7 |
| `packages/sdk/src/core/http/opencode-errors.ts` | dormancy vs failure mapping | 8 |

---

## Delivery order and the gate

```
Task 1 (test repair)  ──┐
Task 2 (stopReason)   ──┴─→ Task 3 (CLASSIFY — GATE) ─┬─→ Task 4 (waiting grant)
                                                       ├─→ Task 5 (mid-turn work)
                                                       ├─→ Task 6 (Path A′ reopen)
                                                       └─→ Task 7 (/start owns wake) ─→ Task 8 (copy)
                                                                                          ↓
                                                                             Task 9 (prove on dev)
```

**Task 3 is a hard gate.** Tasks 4–6 each add a grant; which of them ship, and with what default, is decided by Task 3's measured path distribution. Do not start 4, 5 or 6 before Task 3 reports. Task 7 is a correctness fix independent of the rates, but still sequenced after 3 so its rollout can be judged against real numbers.

---

### Task 1: Make the reaping suite runnable

No dependencies — start here.

**Problem:** `bun test src/projects/reaping/` fails. `sandbox-state-sync.test.ts:28` replaces the whole `config` module with `{ config: {...} }`, dropping every other named export. `snapshots/hash.ts:31` imports `SANDBOX_VERSION`, so any sibling suite that transitively reaches it dies with `SyntaxError: Export named 'SANDBOX_VERSION' not found`. The file cannot be run alone either — bare `config.ts` validates dotenvx ciphertext at import and rejects it.

**Files:**
- Create: `apps/api/src/projects/reaping/test-support/mock-config.ts`
- Modify: `apps/api/src/projects/reaping/sandbox-state-sync.test.ts:28`
- Modify: `apps/api/src/projects/sandbox-deadline-policy.test.ts:12`
- Modify: `apps/api/src/projects/maintenance.test.ts:12`
- Modify: `apps/api/src/projects/sandbox-deadline.test.ts:29`
- Modify: `apps/api/src/projects/sandbox-reaper.test.ts:123`

**Interfaces:**
- Produces: `mockConfigModule(overrides?: Partial<Record<string, unknown>>): Record<string, unknown>` — a complete stand-in for the `config` module, carrying every named export the module has.

- [ ] **Step 1: Reproduce the failure**

Run: `cd apps/api && bun test src/projects/reaping/`
Expected: `SyntaxError: Export named 'SANDBOX_VERSION' not found in module .../src/config.ts`, with `1 fail, 1 error`.

- [ ] **Step 2: Write the failing guard test**

Create `apps/api/src/projects/reaping/test-support/mock-config.test.ts`:

```ts
// A mock.module factory for `config` must carry EVERY named export the real
// module has. Returning only `{ config }` is what broke the whole reaping
// directory: mock.module is process-global in bun, so one partial factory
// removes `SANDBOX_VERSION` from every sibling suite in the same process.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockConfigModule } from './mock-config';

/** Every `export const NAME` / `export function NAME` in src/config.ts. */
function realConfigExportNames(): string[] {
  const src = readFileSync(join(import.meta.dir, '../../../config.ts'), 'utf8');
  return [...src.matchAll(/^export\s+(?:const|function|async function)\s+(\w+)/gm)].map(
    (m) => m[1],
  );
}

describe('mockConfigModule', () => {
  test('carries every named export the real config module has', () => {
    const mocked = mockConfigModule();
    for (const name of realConfigExportNames()) {
      expect(mocked).toHaveProperty(name);
    }
  });

  test('applies overrides onto the config object without dropping siblings', () => {
    const mocked = mockConfigModule({ KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15 });
    expect((mocked.config as Record<string, unknown>).KORTIX_SANDBOX_AUTOSTOP_MINUTES).toBe(15);
    expect(mocked).toHaveProperty('SANDBOX_VERSION');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && bun test src/projects/reaping/test-support/mock-config.test.ts`
Expected: FAIL — `Cannot find module './mock-config'`.

- [ ] **Step 4: Implement the helper**

Create `apps/api/src/projects/reaping/test-support/mock-config.ts`:

```ts
/**
 * A COMPLETE stand-in for the `config` module, for use with `mock.module`.
 *
 * `mock.module` in bun is process-global and replaces the module wholesale, so a
 * factory returning `{ config: {...} }` deletes every other named export for
 * every suite in the same process. `src/config.ts` also exports `SANDBOX_VERSION`,
 * which `src/snapshots/hash.ts` imports — that is the exact break that made
 * `bun test src/projects/reaping/` unrunnable.
 *
 * Importing the real module here is not an option: it validates env at import
 * time and rejects dotenvx ciphertext outside `dotenvx run`.
 */
export function mockConfigModule(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    config: {
      KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
      ALLOWED_SANDBOX_PROVIDERS: ['daytona'],
      ...overrides,
    },
    SANDBOX_VERSION: 'test',
  };
}
```

- [ ] **Step 5: Run the guard test**

Run: `cd apps/api && bun test src/projects/reaping/test-support/mock-config.test.ts`
Expected: PASS, 2 tests.

> If it fails naming an export the helper lacks, add that export to `mockConfigModule` — the test is the inventory, and it is doing its job.

- [ ] **Step 6: Switch the five suites onto the helper**

In each of the five files, replace the inline factory. For `sandbox-state-sync.test.ts:28`:

```ts
// was: mock.module('../../config', () => ({ config: { KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15 } }));
import { mockConfigModule } from './test-support/mock-config';
mock.module('../../config', () => mockConfigModule());
```

The four files under `src/projects/` import from `'./reaping/test-support/mock-config'` and mock `'../config'`.

- [ ] **Step 7: Run the whole directory**

Run: `cd apps/api && bun test src/projects/reaping/ src/projects/sandbox-deadline-policy.test.ts src/projects/sandbox-deadline.test.ts`
Expected: PASS, **0 fail, 0 error**. Record the test count.

- [ ] **Step 8: Delete the stale "run this file on its own" comments**

`sandbox-deadline-policy.test.ts:8` and `sandbox-state-sync.test.ts:10-11` both tell the reader to run the file alone. That is no longer true and a stale instruction is worse than none.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/projects/reaping/test-support apps/api/src/projects/reaping/sandbox-state-sync.test.ts apps/api/src/projects/sandbox-deadline-policy.test.ts apps/api/src/projects/maintenance.test.ts apps/api/src/projects/sandbox-deadline.test.ts apps/api/src/projects/sandbox-reaper.test.ts
git commit -m "test(api): make the reaping suite runnable as a directory

mock.module is process-global in bun, so a factory returning only { config }
stripped SANDBOX_VERSION from every sibling suite. Replace the five inline
factories with one complete module stand-in."
```

---

### Task 2: Record WHY every box parked

Depends on Task 1 (needs a runnable reaping suite).

**Why first:** Task 3 classifies stops by reason. It cannot group on a column nothing writes. `applyStoppedState` already accepts a merged `metadata` patch (`sandbox-state-sync.ts:57-78`), so this is a vocabulary plus four call sites, not new machinery.

**Files:**
- Create: `apps/api/src/projects/stop-reason.ts`
- Create: `apps/api/src/projects/stop-reason.test.ts`
- Modify: `apps/api/src/projects/reaping/sandbox-state-sync.ts:24-31,57-78`
- Modify: `apps/api/src/projects/reaping/stop-box.ts:27-56,72-83`
- Modify: `apps/api/src/projects/reaping/box-reaper.ts:139-147`
- Modify: `apps/api/src/projects/session-lifecycle/stop.ts:77`
- Modify: `apps/api/src/projects/runtime-identity.ts:195-200`
- Modify: `apps/api/src/projects/reaping/sandbox-state-sync.test.ts`

**Interfaces:**
- Produces: `type StopReason = 'deadline_expired' | 'run_cap' | 'idle_grace' | 'boot_floor_expired' | 'provider_reconcile' | 'provider_removed' | 'manual'`
- Produces: `StoppedStateWrite.stopReason: StopReason` — **required**, not optional.

- [ ] **Step 1: Write the failing test for the vocabulary**

Create `apps/api/src/projects/stop-reason.test.ts`:

```ts
// The stop vocabulary is CLOSED. The classification query groups on
// it, and a free-text reason makes that query silently incomplete rather than
// loudly wrong.
import { describe, expect, test } from 'bun:test';
import { STOP_REASONS, isStopReason } from './stop-reason';

describe('STOP_REASONS', () => {
  test('covers every park path the reaper and request path can take', () => {
    expect([...STOP_REASONS].sort()).toEqual(
      [
        'boot_floor_expired',
        'deadline_expired',
        'idle_grace',
        'manual',
        'provider_reconcile',
        'provider_removed',
        'run_cap',
      ].sort(),
    );
  });

  test('rejects anything outside the union', () => {
    expect(isStopReason('deadline_expired')).toBe(true);
    expect(isStopReason('whatever')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && bun test src/projects/stop-reason.test.ts`
Expected: FAIL — `Cannot find module './stop-reason'`.

- [ ] **Step 3: Implement the vocabulary**

Create `apps/api/src/projects/stop-reason.ts`:

```ts
/**
 * WHY a sandbox parked. Written to `session_sandboxes.metadata.stopReason` by
 * every path that stops a box, and read by the path-classification query.
 *
 * CLOSED on purpose. The classification query groups on this value, so a
 * free-text reason does not produce a wrong answer — it produces a quietly
 * incomplete one, which is worse.
 */
export const STOP_REASONS = [
  /** deadline_at passed with a normal grant behind it. Spec Path A/B. */
  'deadline_expired',
  /** Burned the whole 24h continuous stretch. Spec Path C. */
  'run_cap',
  /** Terminal turn end pulled the deadline to the idle tail, then it passed. */
  'idle_grace',
  /** Only ever held the 20-minute stopped->active boot floor. Spec Path A'. */
  'boot_floor_expired',
  /** Provider said stopped; we synced our row. Spec Path D. */
  'provider_reconcile',
  /** Provider said REMOVED; identity preserved, NOT resumable. Spec Path D2. */
  'provider_removed',
  /** A human stopped or deleted it. */
  'manual',
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export function isStopReason(value: unknown): value is StopReason {
  return typeof value === 'string' && (STOP_REASONS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && bun test src/projects/stop-reason.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing test that every stop writes a reason**

Append to `apps/api/src/projects/reaping/sandbox-state-sync.test.ts`:

```ts
describe('applyStoppedState — stopReason', () => {
  test('merges the reason into the sandbox metadata patch', async () => {
    reset();
    await applyStoppedState({
      sandboxId: 'sb-1',
      sessionId: 'se-1',
      externalId: 'ext-1',
      stopReason: 'deadline_expired',
    });
    const sandboxUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sandboxUpdate).toBeDefined();
    // The write must be a jsonb MERGE, never a whole-object assign — a concurrent
    // writer's runtimeWakeId / lastAliveAt live in the same column.
    expect(sandboxUpdate!.updates.metadata).toBeDefined();
    expect(JSON.stringify(sandboxUpdate!.updates)).toContain('deadline_expired');
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd apps/api && bun test src/projects/reaping/sandbox-state-sync.test.ts`
Expected: FAIL — `stopReason` is not an accepted property, and the metadata patch is empty.

- [ ] **Step 7: Make the reason required on the write**

In `sandbox-state-sync.ts`, change the interface and fold the reason into the patch:

```ts
import type { StopReason } from '../stop-reason';

export interface StoppedStateWrite {
  sandboxId: string;
  sessionId: string;
  externalId: string | null;
  /** WHY this box parked. Required — the classification query groups on it. */
  stopReason: StopReason;
  /** Extra keys to record about the stop. Merged, never assigned. */
  metadata?: Record<string, unknown>;
  now?: Date;
}
```

and in `applyStoppedState`, replace the `patch` line:

```ts
  const patch = { ...(write.metadata ?? {}), stopReason: write.stopReason, stoppedAt: now.toISOString() };
```

The `Object.keys(patch).length` guard below can now go — the patch is never empty.

- [ ] **Step 8: Fix the four call sites the compiler now rejects**

Run: `cd apps/api && bunx tsc --noEmit` and fix each error.

`reaping/stop-box.ts` — the deadline stop needs to distinguish the run-cap park from an ordinary expiry, so thread the reason through:

```ts
export async function stopExpiredBox(
  row: StoppableBox,
  now: Date,
  stopReason: StopReason = 'deadline_expired',
): Promise<StopBoxOutcome> {
```

```ts
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId: row.externalId,
    stopReason,
    now,
  });
```

and in `parkBoxAtRunCap`:

```ts
  const outcome = await stopExpiredBox(row, new Date(), 'run_cap').catch((err) => {
```

`reaping/box-reaper.ts:139` — the reconcile branch: add `stopReason: 'provider_reconcile',`.

`reaping/sandbox-state-sync.ts:96` (`reconcileSandboxStoppedByExternalId`) — add `stopReason: 'provider_reconcile',`.

`session-lifecycle/stop.ts:77` — add `stopReason: 'manual',`.

- [ ] **Step 9: Write Path D2's reason**

`preserveEstablishedRuntime` (`runtime-identity.ts:195-200`) does not go through `applyStoppedState`. Add `stopReason` to the metadata it assigns:

```ts
  Object.assign(metadata, {
    runtimeIdentityState: 'unavailable',
    runtimeUnavailableReason: reason,
    runtimeUnavailableAt: now.toISOString(),
    preservedExternalId: externalId,
    // Path D2. NOT resumable in place — /start must branch on
    // runtimeIdentityState, not on the bare `stopped` status (see Task 7).
    stopReason: 'provider_removed' satisfies StopReason,
    stoppedAt: now.toISOString(),
  });
```

- [ ] **Step 10: Run the suites**

Run: `cd apps/api && bun test src/projects/ && bunx tsc --noEmit`
Expected: PASS, 0 fail. Paste the counts.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/projects
git commit -m "feat(api): record stopReason on every sandbox park

applyStoppedState now requires a closed-vocabulary StopReason and merges it
into the metadata jsonb alongside stoppedAt. preserveEstablishedRuntime writes
provider_removed for the Path D2 branch, which does not route through
applyStoppedState. Prerequisite for classifying stop paths."
```

---

### Task 3: Classify real stops — THE GATE

Depends on Task 2 shipping to dev **and** enough elapsed time for reasons to accumulate (allow ≥ 48h of dev traffic, or query prod once Task 2 is promoted).

This task writes **no product code**. Its deliverable is a number per path, and those numbers decide the defaults in Tasks 4–6.

**Files:**
- Create: `apps/api/scripts/classify-stop-paths.sql`
- Modify: the Spec doc, §6.1 — replace "NOT GATHERED" with the measured table.

- [ ] **Step 1: Write the classification query**

Create `apps/api/scripts/classify-stop-paths.sql`:

```sql
-- Path distribution for sandbox parks. Spec §3.3.
-- Run against the dev/prod replica. Window is deliberately a parameter: a
-- 24-hour slice hides the Path C (24h run cap) population entirely.
--
-- Path A' is separated from A by the boot floor: a box whose ENTIRE life was
-- the 20-minute stopped->active floor never received a turn-start or LLM
-- observation, so active_since to deadline_at is <= 20 minutes.
SELECT
  coalesce(s.metadata->>'stopReason', '(unrecorded)') AS stop_reason,
  CASE
    WHEN s.metadata->>'stopReason' = 'provider_removed'   THEN 'D2'
    WHEN s.metadata->>'stopReason' = 'provider_reconcile' THEN 'D'
    WHEN s.metadata->>'stopReason' = 'run_cap'            THEN 'C'
    WHEN s.metadata->>'stopReason' = 'manual'             THEN 'manual'
    WHEN s.deadline_at - s.active_since <= interval '21 minutes' THEN 'A-prime'
    WHEN EXISTS (
      SELECT 1 FROM kortix.session_pending_questions q
       WHERE q.session_id = s.session_id AND q.answered_at IS NULL
    ) THEN 'B-waiting'
    WHEN NOT EXISTS (
      SELECT 1 FROM kortix.usage_events u
       WHERE u.session_id = s.session_id
         AND u.created_at > s.updated_at - interval '4 hours'
    ) THEN 'B-silent-tools'
    ELSE 'A'
  END AS path,
  count(*) AS stops,
  round(avg(extract(epoch FROM (s.deadline_at - s.active_since)) / 60)::numeric, 1) AS avg_life_min
FROM kortix.session_sandboxes s
WHERE s.status = 'stopped'
  AND s.updated_at > now() - :'window'::interval
GROUP BY 1, 2
ORDER BY stops DESC;
```

> Table and columns verified against `packages/db/src/schema/kortix.ts:2803-2843`: the table is `session_pending_questions`, and "still open" is `answered_at IS NULL` (which is also the partial-index predicate, so the subquery is cheap).

- [ ] **Step 2: Run it against dev**

```bash
psql "$DEV_DATABASE_URL" -v window="'7 days'" -f apps/api/scripts/classify-stop-paths.sql
```

- [ ] **Step 3: Pull one annotated timeline per path**

For the highest-count path and for `sbx_01KZ75J3983X1RQF9Q9GEV2SF5`, assemble: `active_since`, every `deadline_at` change, `usage_events` timestamps, pending-question rows, and the `/start` vs health request order from API logs. One timeline per path, in the Spec.

- [ ] **Step 4: Write the numbers into the Spec and decide**

Replace Spec §6.1's "NOT GATHERED" with the measured table, then record the decision explicitly:

- Path A′ dominant → Task 6 ships first, and its grant is sized from `avg_life_min`.
- Path B-waiting dominant → Task 4 ships first; set `KORTIX_SANDBOX_WAITING_GRANT_MINUTES` from the observed answer latency, not from a guess.
- Path B-silent-tools dominant → Task 5's spike is justified; otherwise **defer Task 5**, since it is the one task whose safe seam may not exist.
- `(unrecorded)` still dominant → Task 2 has not reached the environment you queried. Stop and fix that first.

- [ ] **Step 5: Publish the result and close this task out**

No commit — this task's artifact is the query file plus the Spec edit.

```bash
git add apps/api/scripts/classify-stop-paths.sql
git commit -m "chore(api): add the sandbox stop-path classification query"
```

---

### Task 4: Waiting-on-human deadline grant

**Blocked by Task 3.** Ship only if Path B-waiting is material.

**Problem:** A turn blocked on a `question` makes no LLM call, so it earns no extend and the reaper stops it mid-ask. The control plane *already knows* — `recordPendingQuestion` (`lib/pending-questions.ts:45`) persists the ask — but `r4.ts:3340-3342` deliberately declines to touch the deadline, because a box that renews itself by saying "still waiting" is the self-renewal this design deleted.

**The distinction that makes this safe:** a *one-shot floor* on the FIRST record of a pending ask is not self-renewal, because the box cannot repeat it — a retried relay for the same `requestId` must earn nothing. **That property does not exist yet** and is the single most important thing to get right in this task: `recordPendingQuestion` is an upsert that happily returns a row every time (Step 6). Re-extension then comes only from the answer route, which already denies agent tokens outright (Step 7).

**Files:**
- Modify: `apps/api/src/projects/sandbox-deadline-policy.ts` (add `waitingGrantMs`, rewrite the stale comment at 47-55)
- Modify: `apps/api/src/projects/sandbox-deadline.ts` (export `observeWaitingOnHuman`)
- Modify: `apps/api/src/projects/routes/r4.ts:3343-3358` (one-shot floor) and the answer route (re-extend)
- Modify: `apps/api/src/projects/sandbox-deadline-policy.test.ts`

**Interfaces:**
- Consumes: `extendSandboxDeadline(target, grantMs)` from Task 0 baseline (`sandbox-deadline.ts:108`).
- Produces: `waitingGrantMs(): number`, `observeWaitingOnHuman(target: DeadlineTarget): Promise<void>`.

- [ ] **Step 1: Write the failing grant test**

Append to `apps/api/src/projects/sandbox-deadline-policy.test.ts`:

```ts
describe('the waiting-on-human grant', () => {
  test('defaults to 90 minutes — long enough to answer, far under the 24h cap', () => {
    expect(waitingGrantMs()).toBe(90 * 60_000);
  });

  test('is env-tunable like every other grant', () => {
    process.env.KORTIX_SANDBOX_WAITING_GRANT_MINUTES = '120';
    expect(waitingGrantMs()).toBe(120 * 60_000);
  });

  // The whole point of the bound: a wedged box with nobody watching must still
  // die. The grant is a floor, not a renewal, so it can never out-run the cap.
  test('never exceeds the absolute run cap', () => {
    process.env.KORTIX_SANDBOX_WAITING_GRANT_MINUTES = '100000';
    expect(waitingGrantMs()).toBeGreaterThan(0);
    expect(Math.min(waitingGrantMs(), ABSOLUTE_RUN_CAP_MS)).toBe(ABSOLUTE_RUN_CAP_MS);
  });
});
```

Add `'KORTIX_SANDBOX_WAITING_GRANT_MINUTES'` to the `KNOBS` array at line 29 so `afterEach` cleans it up.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && bun test src/projects/sandbox-deadline-policy.test.ts`
Expected: FAIL — `waitingGrantMs is not a function`.

- [ ] **Step 3: Implement the grant**

Add to `sandbox-deadline-policy.ts`:

```ts
/**
 * Granted ONCE when the control plane first records a pending question or
 * permission — the turn is blocked on a human, which is a legitimate reason to
 * live and the one state with no other observation.
 *
 * WHY THIS IS NOT SELF-RENEWAL. The sandbox authors the turn-question relay, so
 * on its face this looks like the lease this design deleted. Two things make it
 * bounded: it is a ONE-SHOT floor keyed on the pending ask (a second relay for
 * the same requestId writes nothing new), and every RE-extension comes from
 * principal traffic on the answer routes, which the box cannot author. A wedged
 * box with nobody watching therefore gets exactly one 90-minute reprieve and
 * then dies.
 *
 * 90 minutes: above the observed answer latency, well under the 4h turn grant
 * (a blocked turn is worth less than a running one), and clamped by
 * ABSOLUTE_RUN_CAP_MS like everything else.
 */
export function waitingGrantMs(): number {
  return positiveEnvInt('KORTIX_SANDBOX_WAITING_GRANT_MINUTES', 90) * 60_000;
}
```

Re-export it from `sandbox-deadline.ts`'s export block (lines 48-62).

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && bun test src/projects/sandbox-deadline-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing call-site test**

`sandbox-deadline-call-sites.test.ts` already asserts that extend call sites are sandbox-gated. Add:

```ts
test('the turn-question one-shot floor is NOT gated on isSandboxAuthored', () => {
  // Deliberate and load-bearing: the relay is BY DEFINITION sandbox-authored, so
  // gating it would make the grant dead code. It is bounded instead by being
  // one-shot per pending ask — see waitingGrantMs.
  const body = routeBody('turn-question');
  expect(body).toContain('observeWaitingOnHuman');
  expect(body).not.toContain('isSandboxAuthored');
});
```

- [ ] **Step 6: Implement the writer and wire the one-shot floor**

Add to `sandbox-deadline.ts`:

```ts
/**
 * Observe that a turn is BLOCKED ON A HUMAN. See waitingGrantMs for why this one
 * observation may be sandbox-relayed without rebuilding self-renewal.
 * Best-effort: losing it costs a waiting turn its reprieve, never correctness.
 */
export async function observeWaitingOnHuman(target: DeadlineTarget): Promise<void> {
  await extendSandboxDeadline(target, waitingGrantMs()).catch((err) =>
    console.warn('[deadline] waiting-on-human observation failed:', err instanceof Error ? err.message : err),
  );
}
```

In `r4.ts`, inside the `recordPendingQuestion` block (3343-3358), extend **only when the record is new**:

```ts
    if (resolvedAccountId) {
      const recorded = await recordPendingQuestion({ /* …unchanged… */ }).catch((err) => {
        console.warn('[turn-question] could not persist pending question:', err);
        return null;
      });
      // ONE-SHOT floor, and only for a genuinely NEW ask. A retried relay for the
      // same requestId grants nothing, which is what keeps this from being the
      // renewal loop the deadline model deleted.
      if (recorded?.inserted) void observeWaitingOnHuman({ sessionId });
    }
```

**`recordPendingQuestion` cannot report this today** — it is an `onConflictDoUpdate` upsert (`lib/pending-questions.ts:53-88`) and always returns a row, so `recorded != null` is true for a retry as well as a first ask. Wiring the floor to that would hand a retrying relay an unbounded renew loop: exactly the self-renewal this design deleted.

Fix it with the Postgres upsert discriminator. `xmax` is `0` on a genuine INSERT and non-zero on the UPDATE half of an upsert:

```ts
    .returning({
      id: sessionPendingQuestions.id,
      // …existing fields unchanged…
      /** True only on a real INSERT. `xmax` is 0 for an inserted row and the
       *  locking transaction id for the UPDATE half of an upsert — the standard
       *  way to tell the two apart in one statement. The waiting grant depends
       *  on it: a retried relay must earn nothing. */
      inserted: sql<boolean>`(xmax = 0)`,
    });
```

and add `inserted: row.inserted` to the returned `PendingQuestion`.

- [ ] **Step 6b: Test the discriminator before relying on it**

```ts
test('a retried relay for the same requestId reports inserted:false', async () => {
  const first = await recordPendingQuestion({ ...input, requestId: 'q-1' });
  const retry = await recordPendingQuestion({ ...input, requestId: 'q-1' });
  expect(first?.inserted).toBe(true);
  expect(retry?.inserted).toBe(false); // ← the grant must NOT fire again
});
```

This one needs a real database — put it with the integration tests, not the mocked unit suite. A mocked `xmax` proves nothing.

- [ ] **Step 7: Re-extend on principal answer traffic**

The answer route is `POST /{projectId}/sessions/{sessionId}/question` (`r4.ts:3428`). At the top of its handler, after `loadVisibleSession` succeeds:

```ts
    // The human showed up. Push the deadline out so a long back-and-forth does
    // not park the box between question and answer.
    void extendSandboxDeadline({ sessionId }, waitingGrantMs());
```

**No `isSandboxAuthored` gate here, deliberately.** This route already denies agent-session tokens outright — see its own comment at `r4.ts:3441-3450`: *"if it could POST here it would answer itself and resume, and the tool would be decorative… Answering is a human operation."* The route's auth is the gate; adding a second one would imply the first is untrusted. **Add a test pinning that dependency**, so removing the agent-token denial cannot silently open a renewal loop:

```ts
test('the answer route still denies agent-session tokens', () => {
  // The waiting-grant extend on this route is ungated BECAUSE of this denial.
  // If this test fails, the extend needs an isSandboxAuthored gate before the
  // denial is relaxed.
  const body = routeBody('sessions/{sessionId}/question');
  expect(body).toMatch(/agent[- ]session token|assertAgentScope|Answering is a human operation/);
});
```

- [ ] **Step 8: Run everything**

Run: `cd apps/api && bun test src/projects/ && bunx tsc --noEmit`
Expected: PASS, 0 fail.

- [ ] **Step 9: Rewrite the stale comment**

`sandbox-deadline-policy.ts:47-55` claims the relay "returns early unless the box has Slack context" and that the fix "is a change to the sandbox agent, not to this file". Both are false as of `main.ts:1284-1297`. Replace with a description of what this task actually built.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/projects
git commit -m "feat(api): bounded waiting-on-human deadline grant

A turn blocked on a question earns a one-shot 90-minute floor when the control
plane first records the pending ask, and re-extends only on principal traffic
against the answer routes. Also corrects the policy comment, which described
the pre-park-and-restore relay behaviour."
```

---

### Task 5: Mid-turn work observation — SPIKE FIRST

**Blocked by Task 3.** This is the one task allowed to conclude "no safe seam exists".

**Problem:** a long local tool run (build, test suite, migration) emits no `usage_events`, so after the 4-hour turn grant the reaper stops a genuinely running turn.

**The trap:** every obvious signal is sandbox-authored. Do not accept any signal the box can mint. Spec §11 non-goal 5 is explicit.

- [ ] **Step 1: Timebox the spike to one day and write the finding first**

Before writing code, write down the answer to this: **is there any request the control plane sees end-to-end that proves a turn is doing real work, which the sandbox's own credentials cannot produce?**

Candidates to evaluate, with the reason each may fail:
- Proxied opencode tool/event traffic on 8000 — *likely sandbox-authored; check `isSandboxAuthored` against a real captured request before assuming either way.*
- The `chat_turn_stream` unfinalized row — *written by the API, but its mere existence does not prove progress; a wedged turn has one too.*
- Gateway request **start** (not completion) — *already control-plane-attested and strictly earlier than the `usage_events` write; may cover part of the gap for free.*

- [ ] **Step 2: If a seam exists, implement it with the throttle**

Reuse `createExtendThrottle` (`sandbox-deadline-policy.ts:290`) so a chatty signal becomes one UPDATE per window. Grant `llmActivityGrantMs()`. Gate on `!isSandboxAuthored(...)`.

- [ ] **Step 3: If no seam exists, say so and stop**

Record the finding in the Spec under §11.1b and close this task as `WON'T DO (no attested seam)`. **Do not** ship a partial signal the box can influence. A documented gap beats a rebuilt lease.

---

### Task 6: Path A′ — a reopened session must survive being read

**Blocked by Task 3.**

**Problem:** the DB trigger grants a reopened box exactly 20 minutes (`20260730000452547_sandbox_deadline.sql:216-219`). Reading a transcript extends nothing, so the box dies again with the tab open.

**Decision to make in Step 1 — do not skip it.** Two candidate shapes, and they are not equivalent:

- **(a) Observe principal transcript reads.** Narrow, honest, and it makes "the user is here" a real signal. Risk: it walks up to the line that `isPreviewUseObservation` draws at session-data ports. It stays legal only if it is *non-waking* (a stopped box still 503s) and *principal-only*.
- **(b) Raise the reopen floor to `idleGraceMs()`.** One trigger change, no new observation, no new attack surface. Risk: it only moves the cliff from 20 minutes to 15 — strictly worse unless paired with (a).

Recommendation: **(a)**, with the floor left alone. (b) alone does not solve the reported problem.

**Files:**
- Modify: `apps/api/src/projects/sandbox-deadline-policy.ts` (`isTranscriptReadObservation`)
- Modify: `apps/api/src/sandbox-proxy/routes/preview.ts` (directly after the turn-start observation block, which starts at ~line 938)
- Modify: `apps/api/src/projects/sandbox-deadline-policy.test.ts`

- [ ] **Step 1: Record the decision before coding**

One paragraph: which shape, and why the rejected one loses.

- [ ] **Step 2: Write the failing classifier test**

```ts
describe('isTranscriptReadObservation', () => {
  const base = { isPrincipal: true, sandboxAuthored: false, method: 'GET', upstreamPort: 8000 };

  test('a principal reading the transcript counts', () => {
    expect(isTranscriptReadObservation({ ...base, path: '/session/ses_1/message' })).toBe(true);
  });

  // The three that must NOT count, each a real regression:
  test('the sandbox reading its own transcript does not count', () => {
    expect(isTranscriptReadObservation({ ...base, sandboxAuthored: true, path: '/session/ses_1/message' })).toBe(false);
  });

  test('a health poll does not count — it is not evidence a human is present', () => {
    expect(isTranscriptReadObservation({ ...base, path: '/kortix/health' })).toBe(false);
  });

  test('a share-link forward does not count — no attributable human', () => {
    expect(isTranscriptReadObservation({ ...base, isPrincipal: false, path: '/session/ses_1/message' })).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && bun test src/projects/sandbox-deadline-policy.test.ts`
Expected: FAIL — `isTranscriptReadObservation is not a function`.

- [ ] **Step 4: Implement the classifier**

```ts
/** Transcript reads: the conversation itself, not the health/liveness surface. */
const TRANSCRIPT_READ = /^\/session\/[^/]+(?:\/message|\/part)?(?:$|[/?#])/;

/**
 * Is this a HUMAN READING the conversation, and therefore evidence the session
 * is still wanted?
 *
 * The narrow exception to "session-data ports never extend". That rule exists to
 * stop PASSIVE traffic — an open tab's SSE, /start polls, background reconnects —
 * from keeping idle boxes alive (1,597 phantom-active rows, 2026-06-21). A
 * principal GET against the transcript is not passive: somebody is reading it.
 *
 * Without this, a reopened box holds only the 20-minute DB boot floor, so a user
 * reading a long transcript loses their session mid-read (Spec Path A').
 *
 * NON-WAKING, and that separation is the whole safety argument: this only
 * extends a box that is ALREADY active. `shouldAutoResumeStoppedSandbox` still
 * refuses to resume on GET, so a stopped box stays stopped and this can never
 * become passive resurrection.
 */
export function isTranscriptReadObservation(opts: {
  isPrincipal: boolean;
  sandboxAuthored: boolean;
  method: string;
  upstreamPort: number;
  path: string;
}): boolean {
  if (!opts.isPrincipal || opts.sandboxAuthored) return false;
  if (opts.method.toUpperCase() !== 'GET') return false;
  if (!SESSION_DATA_PORTS.has(opts.upstreamPort)) return false;
  return TRANSCRIPT_READ.test(opts.path.replace(/^\/proxy\/\d+(?=\/)/, ''));
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd apps/api && bun test src/projects/sandbox-deadline-policy.test.ts`
Expected: PASS, 4 new tests.

- [ ] **Step 6: Wire it into the proxy, throttled**

In `preview.ts`, directly after the existing turn-start observation block (which begins at `if (!sandboxAuthored && isTurnStartRequest(...))`, ~line 938):

```ts
  // Throttled: a transcript view issues many GETs. One UPDATE per window is
  // enough, because every extend is GREATEST(deadline_at, now + grant).
  if (
    isTranscriptReadObservation({
      isPrincipal: access.kind === 'principal',
      sandboxAuthored,
      method,
      upstreamPort,
      path: remainingPath,
    }) &&
    transcriptReadThrottle.take(sandboxId)
  ) {
    void extendSandboxDeadline({ externalId: sandboxId }, previewGrantMs());
  }
```

Declare `const transcriptReadThrottle = createExtendThrottle(60_000);` at module scope.

> **`externalId`, not `sandboxId`.** `forwardToSandbox`'s first parameter is named `sandboxId` but carries the **external** id — the neighbouring turn-start call is `observeTurnStart({ externalId: sandboxId })` for exactly this reason. Passing `{ sandboxId }` builds the predicate `s.sandbox_id = '<external>'::uuid`, which matches nothing (or throws on the cast), so the grant would silently never land and the whole task would look shipped while doing nothing.

> Grant is `previewGrantMs()` (30 min), **not** the 4-hour turn grant. Reading is worth less than running, and 30 minutes past the last read is the same bound a preview tab already gets.

- [ ] **Step 7: Run everything**

Run: `cd apps/api && bun test src/projects/ src/sandbox-proxy/ && bunx tsc --noEmit`
Expected: PASS, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): keep a reopened session alive while a human reads it

A principal GET against the transcript is a control-plane-attested observation
that the session is still wanted, throttled to one extend per minute and worth
the 30-minute preview grant. Non-waking: a stopped box still 503s, so this
cannot become passive resurrection. Closes Spec Path A'."
```

---

### Task 7: `/start` owns the wake

**Blocked by Task 3.** SDK package — `packages/sdk/AGENTS.md` rules apply: TDD mandatory, exported names are a public contract, never bump `version`.

**Problem:** `use-session.ts:855` forces `phase: 'error'` on any runtime error, with no check that the `/start` poll is still in flight. A parallel health 503 during a legitimate wake therefore renders "OpenCode failed to load".

**And the trap from Spec Path D2:** the fix must not treat *every* `stopped` row as resumable. A row with `metadata.runtimeIdentityState === 'unavailable'` can never wake; showing it a calm spinner is worse than today's blunt error.

**Files:**
- Modify: `packages/sdk/src/react/use-session.ts:853-855`
- Create: `packages/sdk/src/react/use-session-phase.ts` + `.test.ts` (pure, so the rule is testable without React)

**Interfaces:**
- Produces: `derivePhase(input: { terminal: boolean; startError: unknown; runtimeError: unknown; startSettled: boolean; switched: boolean }): SessionPhase`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk/src/react/use-session-phase.test.ts`:

```ts
// The reopen-panic rule. A health 503 that races a live /start is NOT a failure —
// it is the ordinary shape of waking a parked box.
import { describe, expect, test } from 'bun:test';
import { derivePhase } from './use-session-phase';

const RUNTIME_503 = { status: 503, body: { error: 'sandbox not ready (status: stopped)' } };
const base = { terminal: false, startError: null, runtimeError: null, startSettled: false, switched: false };

describe('derivePhase', () => {
  test('a runtime 503 while /start is still working reads as starting, not error', () => {
    expect(derivePhase({ ...base, runtimeError: RUNTIME_503 })).toBe('starting');
  });

  test('the same 503 after /start has settled is a real error', () => {
    expect(derivePhase({ ...base, runtimeError: RUNTIME_503, startSettled: true })).toBe('error');
  });

  test('a /start error is terminal immediately — nothing else is coming', () => {
    expect(derivePhase({ ...base, startError: new Error('nope') })).toBe('error');
  });

  test('a terminal stage is an error regardless of /start', () => {
    expect(derivePhase({ ...base, terminal: true })).toBe('error');
  });

  test('switched with no error is ready', () => {
    expect(derivePhase({ ...base, switched: true })).toBe('ready');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @kortix/sdk test src/react/use-session-phase.test.ts`
Expected: FAIL — `Cannot find module './use-session-phase'`.

- [ ] **Step 3: Implement the rule**

Create `packages/sdk/src/react/use-session-phase.ts`:

```ts
import type { SessionPhase } from './use-session';

/**
 * WHY THIS IS NOT `runtimeError ? 'error' : …`.
 *
 * Opening a parked session is a race by construction: `/start` resumes the box
 * while the runtime queries fire against a row that still says `stopped`. The
 * proxy answers those with `503 sandbox not ready`, correctly — a GET on a
 * session-data port is deliberately not wake-capable. Mapping that 503 straight
 * to a phase of 'error' is what renders "OpenCode failed to load" over a
 * perfectly healthy wake.
 *
 * So a runtime error only becomes terminal once `/start` has SETTLED. While it
 * is still in flight the session is `starting`, which is the truth.
 */
export function derivePhase(input: {
  terminal: boolean;
  startError: unknown;
  runtimeError: unknown;
  /** True once the /start poll has stopped — resolved, failed, or given up. */
  startSettled: boolean;
  switched: boolean;
}): SessionPhase {
  if (input.terminal || input.startError) return 'error';
  if (input.runtimeError && input.startSettled) return 'error';
  if (input.runtimeError) return 'starting';
  return input.switched ? 'ready' : 'starting';
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @kortix/sdk test src/react/use-session-phase.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it in the hook**

Replace `use-session.ts:853-855`:

```ts
  const runtimeSessionError = canonicalSession.error;
  const phase: SessionPhase = derivePhase({
    terminal,
    startError,
    runtimeError: runtimeSessionError,
    // `start` is the /start useQuery (use-session.ts:557); `startError` is
    // already derived at :569. `shouldPollSessionStart` (:119) is the EXISTING
    // definition of "the poll is still working" — reuse it rather than inventing
    // a second answer to the same question that can drift from the poll's own.
    startSettled: !start.isFetching && !shouldPollSessionStart(start.error, start.data),
    switched,
  });
```

- [ ] **Step 6: Keep the non-resumable case loud (Path D2)**

A row the provider reported removed carries `runtimeIdentityState: 'unavailable'` and `/start` reports a terminal stage for it, so `startError`/`terminal` fires and Step 3's first branch returns `'error'`. **Add a test that pins this**, so a later refactor cannot quietly turn it into a spinner:

```ts
test('a removed runtime stays an error — it can never wake, so never show waking', () => {
  expect(derivePhase({ ...base, terminal: true, runtimeError: RUNTIME_503 })).toBe('error');
});
```

- [ ] **Step 7: Run the SDK gates and paste the output**

```bash
pnpm --filter @kortix/sdk typecheck
pnpm --filter @kortix/sdk test
pnpm --filter @kortix/sdk run smoke:install
```

Check the test count against the 1069 baseline. State **shippable: YES / NO / NOT YET**.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/react
git commit -m "fix(sdk): a runtime 503 during a live /start is not a failure

derivePhase makes a runtime error terminal only once the /start poll has
settled, so reopening a parked session shows the boot loader instead of
'OpenCode failed to load'. A removed runtime still reports error immediately."
```

---

### Task 8: Truthful dormancy copy

**Blocked by Task 7** — copy must not paper over a broken wake.

**Files:**
- Modify: `packages/sdk/src/core/http/opencode-errors.ts:84-88`
- Modify: `apps/web/src/app/(app)/projects/[id]/sessions/[sessionId]/page.tsx:830-838`

- [ ] **Step 1: Write the failing test**

```ts
test('a stopped-sandbox 503 is dormancy, not an OpenCode failure', () => {
  const formatted = formatOpenCodeRuntimeError({
    message: JSON.stringify({ error: 'sandbox not ready (status: stopped)', status: 503 }),
  });
  expect(formatted.title).toBe('Session is waking up');
  expect(formatted.title).not.toBe('OpenCode failed to load');
});

test('a genuine config error keeps its own title', () => {
  const formatted = formatOpenCodeRuntimeError({
    message: JSON.stringify({ name: 'ConfigInvalidError', data: { path: '/workspace/opencode.json' } }),
  });
  expect(formatted.title).toBe('OpenCode config is invalid');
});
```

- [ ] **Step 2: Run it and watch it fail** — `pnpm --filter @kortix/sdk test src/core/http/opencode-errors.test.ts`

- [ ] **Step 3: Add the dormancy branch before the catch-all**

```ts
  // A parked box is not a crash. The proxy answers `sandbox not ready
  // (status: stopped)` for a sandbox the control plane stopped ON PURPOSE to
  // save compute, and the conversation is intact behind it. Reserve "OpenCode
  // failed to load" for a runtime that genuinely broke.
  const payload = parseOpenCodeErrorPayload(error) as { error?: string } | null;
  if (typeof payload?.error === 'string' && /sandbox not ready \(status: stopped\)/.test(payload.error)) {
    return {
      title: 'Session is waking up',
      message: 'This session slept to save compute. Your conversation is safe — sending a message wakes it back up.',
    };
  }
```

- [ ] **Step 4: Run the gates and commit**

```bash
pnpm --filter @kortix/sdk typecheck && pnpm --filter @kortix/sdk test
git add packages/sdk/src/core/http apps/web/src/app
git commit -m "fix(sdk): render an intentional park as dormancy, not a crash"
```

---

### Task 9: Prove it on dev

**Blocked by Tasks 4–7 and Task 1.**

Unit-green is not the deliverable. Each line below needs a real observation with a pasted command and output.

- [ ] **Step 1: Local — the cost invariant still holds**

Boot the stack, open a session, send one prompt, let it finish, then leave the tab open and idle. Assert the box is `stopped` after the idle grace and that `metadata.stopReason` is **`deadline_expired`**.

> **Corrected 2026-08-09.** This step originally said to expect `idle_grace`. That is unsatisfiable: `idle_grace` and `boot_floor_expired` are declared in `STOP_REASONS` but deliberately **not emitted** (see `STOP_REASONS_NOT_YET_EMITTED` in `apps/api/src/projects/stop-reason.ts`). The deadline writers only move `deadline_at`; they never record *which* grant moved it, so at stop time an idle-tail deadline is byte-identical to a boot-floor one. Every deadline park therefore takes `stopExpiredBox`'s `deadline_expired` default. Distinguishing them needs the writer to record the grant that set the deadline — a real change, not a stop-site heuristic. **Treat a zero count for those two reasons in the Task 3 query as "not implemented", never as "measured zero".**

```bash
psql "$LOCAL_DATABASE_URL" -c "select status, metadata->>'stopReason', deadline_at from kortix.session_sandboxes where session_id = '<sid>';"
```

- [ ] **Step 2: Local — Path A′ (Task 6)**

Reopen the parked session. Read the transcript for 25+ minutes without prompting. Assert the box is still `active`, and that `deadline_at` moved.

- [ ] **Step 3: Local — waiting on a question (Task 4)**

Drive a turn that calls the `question` tool. Leave it unanswered past the old 4-hour boundary — or set `KORTIX_SANDBOX_TURN_GRANT_MINUTES=2` to compress the window. Assert no mid-turn 503 and that the ask is restored on return.

- [ ] **Step 4: Local — a wedged box still dies**

Same as Step 3, but never answer and close the tab. Assert the box parks after the waiting grant. **This is the test that proves Task 4 is not self-renewal.** If it does not die, stop and fix.

- [ ] **Step 5: dev-api — reopen shows no panic card (Task 7)**

Against `https://dev.kortix.com`, open a session parked ≥ 20 minutes. Assert in the network panel that a health request returns 503 **and** that the UI shows the boot loader, never "OpenCode failed to load".

- [ ] **Step 6: dev-api — a removed runtime still shows a real error (Path D2)**

Force `runtimeIdentityState: 'unavailable'` on a test session's row. Assert the UI shows a failure card with a Restart action, **not** a waking spinner.

- [ ] **Step 7: Re-run the classification query**

Same query as Task 3, one week after deploy. Path A′ and Path B counts must fall. Paste the before/after table into the Spec.

- [ ] **Step 8: Report — do not merge to `main` without asking Jay**

Post the PR, the merge SHA, the Deploy Dev run, the deployed SHA, and every command above with its real output.

---

## Self-review

**Spec coverage.** §7 success criteria 1 (no panic copy) → Tasks 7, 8. Criterion 2 (seamless resume) → Task 7. Criterion 3 (no mid-turn kill for blocked asks) → Task 4. Criterion 4 (no mid-turn kill for long tool work) → Task 5, which may honestly conclude "no seam". Criterion 5 (cost invariant) → Task 9 Steps 1 and 4. Criterion 6 (observability) → Task 2. Path A′ → Task 6. Path D2 → Tasks 2 and 7.

**Four assumptions were wrong in the first draft and are now corrected against the code.** Recorded because each would have shipped a task that looked done and did nothing:

1. Task 3's SQL named `kortix.pending_questions` / `resolved_at`. Real: `kortix.session_pending_questions`, open predicate `answered_at IS NULL` (`packages/db/src/schema/kortix.ts:2803-2843`).
2. Task 4's one-shot floor keyed on a non-existent `isNew`. `recordPendingQuestion` is an `onConflictDoUpdate` upsert and always returns a row, so a **retried relay would have renewed the deadline forever** — the exact self-renewal this design deleted. Now discriminated with `RETURNING (xmax = 0)`, with a DB-backed test.
3. Task 6 targeted `{ sandboxId }`. `forwardToSandbox`'s `sandboxId` parameter carries the **external** id, so the extend would silently never land.
4. Task 7 named the `/start` query `startQuery`. It is `start` (`use-session.ts:557`).

**Remaining open items, stated rather than hidden.**
- Task 5 may produce no code. That is a permitted outcome, not a failure.
- Task 6 chooses shape (a) on my recommendation; Step 1 requires the implementer to record the decision rather than inherit it silently.
- Task 4 Step 7 leaves the answer-route extend **ungated**, relying on that route's existing agent-token denial. The pinning test in Step 7 is what keeps that dependency honest — do not drop it.
- Task 9's Step 3 suggests compressing the window with `KORTIX_SANDBOX_TURN_GRANT_MINUTES=2`. Confirm that knob is read per-call (`turnGrantMs()` is a function, so it is) and not cached at boot in the environment you test against.
