# Live-Turn Prompt Steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward durable queued prompts into a live OpenCode session in canonical FIFO order, without waiting for turn completion or requiring a page refresh.

**Architecture:** PostgreSQL remains the durability and recovery authority. The API serializes one prompt delivery per session, forwards accepted prompts into OpenCode during the active turn, and immediately promotes the next FIFO row. OpenCode owns the safe execution boundary. Turn completion and the reaper remain recovery wakes, not the normal queue boundary.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, OpenCode REST compatibility, Bun tests, real cloud sandboxes, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-live-turn-prompt-steering-design.md`

## Global Constraints

- Work only in `/Users/jay/root/kortix/suna-session-queue-turn-end-sync` on `session-queue-turn-end-sync`.
- Preserve the existing FIFO tuple: `clientSentAtMs`, `wireMessageId`, `commandId`, with `created_at` as the legacy fallback.
- Preserve the current discriminated turn-completion outcomes and reaper recovery path.
- Preserve Stop as the explicit hard-abort control. Normal prompt submission must not terminate the active process.
- Make no UI, database-schema, migration, or public SDK changes.
- Do not merge pull request #7103.
- Use failing tests before each behavior change.

---

### Task 1: Remove live-turn authority from inbox admission

**Files:**

- Modify: `apps/api/src/projects/session-lifecycle/inbox-admission.test.ts`
- Modify: `apps/api/src/projects/session-lifecycle/inbox-admission.ts`

- [ ] **Step 1: Replace the regression-preserving unit test with the required contract**

Replace `a session in the middle of a turn holds the prompt in the durable inbox` with a test named `a live turn does not block runtime forwarding`.

The test must pass an active sandbox with two `activeTurns`. It must expect `{ admit: true }` when no older or in-flight prompt exists.

Retain the standalone `sessionHoldsTurnAuthority` truth-table tests. The engine and turn APIs still use this predicate for runtime identity and wire-ID placement.

- [ ] **Step 2: Run the focused test and confirm the current code fails**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/inbox-admission.test.ts \
  --test-name-pattern 'a live turn does not block runtime forwarding'
```

Expected failure: the actual result is `admit: false` with `reason: 'turn_active'`.

- [ ] **Step 3: Remove the live-turn admission dependency and gate**

In `inbox-admission.ts`:

- Remove `readSandbox` from `InboxAdmissionDeps` and `liveDeps`.
- Remove the `sessionHoldsTurnAuthority(await deps.readSandbox(...))` refusal.
- Keep `sessionHoldsTurnAuthority` and `sessionHoldsLiveTurn` unchanged.
- Update the module comments to state that admission enforces only one in-flight delivery and older-row ordering.
- Keep `InboxAdmissionReason` compatible because persisted historical rows can still contain `turn_active`.

Update every `admitInboxPrompt` test dependency literal to remove `readSandbox`.

- [ ] **Step 4: Run the complete admission test file**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/inbox-admission.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit the admission change**

```bash
git add apps/api/src/projects/session-lifecycle/inbox-admission.ts \
  apps/api/src/projects/session-lifecycle/inbox-admission.test.ts
git commit -m "fix(queue): forward prompts during live turns"
```

---

### Task 2: Restore accepted-delivery FIFO chaining

**Files:**

- Modify: `apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts`
- Modify: `apps/api/src/projects/session-lifecycle/engine.ts`

- [ ] **Step 1: Flip the live-turn delivery regression test**

Rename `a prompt submitted into a live turn stays queued until that turn ends` to `a prompt submitted into a live turn is forwarded with a reminted wire id`.

Assert:

- `executeQueuedContinue` returns `succeeded`.
- exactly one body reaches `forwardToSandbox`;
- no admission requeue occurs;
- `markCommandForwarded` receives the delivered wire ID;
- the delivered wire ID differs from the client ID and sorts above the current transcript tip.

- [ ] **Step 2: Flip the lane test to require a next-row promotion**

Change `one drain sends only the head prompt of a session and requeues its sibling` to assert:

- the current drain sends only the FIFO head;
- the claimed sibling returns to `queued` with `older_prompt_pending`;
- after the head POST succeeds, `promoteNextInboxRow` is called once for `sess-ordered`;
- the returned idempotency key starts a targeted `drainSessionLifecycleQueue` call.

Extend the store mock so `promoteNextInboxRow` can return a configured key. Record targeted-drain calls without recursively claiming the original fixture.

- [ ] **Step 3: Run both tests and confirm the current code fails**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts \
  --test-name-pattern 'live turn|head prompt'
```

Expected failures: live-turn delivery returns `queued`, and the success path records no promotion.

- [ ] **Step 4: Chain the next FIFO row after accepted delivery**

Import `promoteNextInboxRow` from `./store` in `engine.ts`.

After `delivery === 'delivered'`:

```ts
void promoteNextInboxRow(row.sessionId)
  .then((idempotencyKey) =>
    idempotencyKey ? drainSessionLifecycleQueue({ idempotencyKey }) : null,
  )
  .catch((error) => {
    logger.warn('[session-lifecycle] next inbox prompt promotion failed', {
      session_id: row.sessionId,
      command_id: row.commandId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
```

Keep this asynchronous. The accepted head must complete without waiting for the next delivery. Do not remove terminal or reaper promotion; those paths repair a dropped chain wake.

- [ ] **Step 5: Run the complete delivery test file**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit delivery chaining**

```bash
git add apps/api/src/projects/session-lifecycle/engine.ts \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts
git commit -m "fix(queue): chain accepted prompt delivery"
```

---

### Task 3: Lock FIFO, consumption, and recovery behavior

**Files:**

- Modify: `apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts`
- Test: `apps/api/src/projects/session-lifecycle/forwarded-strand-reconcile.test.ts`
- Test: `apps/api/src/projects/session-lifecycle/consumption.test.ts`
- Test: `apps/api/src/projects/session-lifecycle/integration-sandbox-turn-lifecycle.test.ts`

- [ ] **Step 1: Add a three-row delivery-chain unit test**

Create three same-session rows whose `created_at` order conflicts with their canonical FIFO tuple. Make each targeted drain expose only the row promoted by the prior accepted delivery.

Assert the wire POST sequence follows `compareInboxSendOrder`, each row is posted once, and no two same-session POSTs overlap.

- [ ] **Step 2: Run the new test and confirm it fails before the fixture supports chaining**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts \
  --test-name-pattern 'chains three prompts in canonical FIFO order'
```

Expected failure: only the first row reaches the runtime or the mock cannot expose the promoted row.

- [ ] **Step 3: Complete the minimal test harness and production fix**

Keep production ordering in the existing `compareInboxSendOrder` and `promoteNextInboxRow` helpers. Do not add a second ordering implementation.

If the chained test finds a real ordering defect, fix the shared helper or SQL predicate. Do not sort by `created_at` alone.

- [ ] **Step 4: Run focused recovery tests**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts \
  apps/api/src/projects/session-lifecycle/forwarded-strand-reconcile.test.ts \
  apps/api/src/projects/session-lifecycle/consumption.test.ts \
  apps/api/src/projects/session-lifecycle/integration-sandbox-turn-lifecycle.test.ts
```

Expected: all tests pass. This proves accepted delivery, consumed-row closure, stranded placement repair, completion outcome handling, and reaper promotion remain compatible.

- [ ] **Step 5: Commit any additional ordering or fixture changes**

```bash
git add apps/api/src/projects/session-lifecycle
git commit -m "test(queue): cover live-turn FIFO chaining"
```

Skip this commit if Task 2 already contains the complete test coverage and no files changed.

---

### Task 4: Prove the contract in a real OpenCode sandbox

**Files:**

- Modify: `apps/api/src/__tests__/integration-inbox-midturn-forward.test.ts`
- Modify: `tests/spec/end-to-end.md`

- [ ] **Step 1: Extend the real-sandbox test from one queued prompt to three**

Keep P1 as the deterministic 36-second shell command. Add P2, P3, and P4 with distinct exact-response instructions.

Submit P2, P3, and P4 while P1's assistant message is still open. Record each `client_message_id` and its delivered, re-minted wire ID.

Assert for every queued prompt:

- `POST .../prompts` returns `202`;
- a user message persists in OpenCode within 20 seconds of submission;
- persistence occurs before P1 completes;
- the delivered wire IDs increase in P2, P3, P4 order;
- the prompts endpoint reports `delivering` with `reason: 'forwarded'` while consumption is pending.

- [ ] **Step 2: Assert safe-boundary execution and no hard abort**

Poll the transcript until P1 through P4 have assistant messages.

Assert:

- P1 duration is at least 30 seconds;
- P2's assistant message is created at or after P1 completes;
- P3 starts at or after P2 completes;
- P4 starts at or after P3 completes;
- each user and assistant message appears exactly once.

- [ ] **Step 3: Assert durable row closure**

Poll the turn ledger until P2, P3, and P4 are terminal. Poll the prompts endpoint until all three rows disappear. Assert no row is consumed twice and no forwarded row remains stranded.

- [ ] **Step 4: Update the natural-language end-to-end contract**

Update `SESS-25` in `tests/spec/end-to-end.md`:

- remove the statement that a live turn holds later prompts;
- state that durable prompts forward into the live OpenCode session one network POST at a time;
- state that accepted rows chain in canonical FIFO order;
- state that OpenCode executes them at safe boundaries without a refresh;
- retain terminal promotion as the recovery wake.

- [ ] **Step 5: Run the real-sandbox gate on the feature stack**

Stop the primary development stack only for this verification. Start `pnpm dev` from the feature worktree. Use its tunnel in `KORTIX_URL`.

Run:

```bash
KORTIX_URL=http://localhost:8008 \
KORTIX_REAL_SANDBOX_TESTS=1 \
KORTIX_MIDTURN_API_URL=http://localhost:8008 \
pnpm exec dotenvx run -f apps/api/.env -- \
bun test --isolate apps/api/src/__tests__/integration-inbox-midturn-forward.test.ts
```

Expected: all tests pass. Record the persistence latency and each assistant start/completion timestamp from the test output.

Restore the primary development stack after this gate if it was running before the switch.

- [ ] **Step 6: Commit the black-box contract**

```bash
git add apps/api/src/__tests__/integration-inbox-midturn-forward.test.ts \
  tests/spec/end-to-end.md
git commit -m "test(queue): prove live-turn prompt order"
```

---

### Task 5: Record the incident learning

**Files:**

- Modify: `.claude/skills/learnings/SKILL.md`

- [ ] **Step 1: Append the incident rule**

Add an append-only entry with:

- incident: the restored `turn_active` admission gate stranded live-turn prompts and required refresh recovery;
- rule: durable prompt submission must forward into the runtime while a turn is active; active-turn state controls placement, not admission;
- enforcement: the admission unit test, the three-row FIFO unit test, and the opt-in real-sandbox gate;
- evidence: the failing 20-second persistence assertion before the fix and the passing post-fix real-sandbox timestamps.

- [ ] **Step 2: Validate the skill format and commit**

Run the validation command documented in `.claude/skills/learnings/SKILL.md`, if present. Then run:

```bash
git diff --check
git add .claude/skills/learnings/SKILL.md
git commit -m "chore(queue): record live-turn queue incident"
```

---

### Task 6: Run repository gates and browser verification

**Files:**

- Test: `apps/api/src/projects/session-lifecycle/**`
- Test: `apps/api/src/__tests__/integration-inbox-midturn-forward.test.ts`
- Test: `tests/spec/end-to-end.md`

- [ ] **Step 1: Run focused API tests**

Run:

```bash
pnpm exec dotenvx run -f apps/api/.env -- bun test \
  apps/api/src/projects/session-lifecycle/inbox-admission.test.ts \
  apps/api/src/projects/session-lifecycle/__tests__/queued-continue-inbox-delivery.test.ts \
  apps/api/src/projects/session-lifecycle/forwarded-strand-reconcile.test.ts \
  apps/api/src/projects/session-lifecycle/consumption.test.ts \
  apps/api/src/projects/session-lifecycle/integration-sandbox-turn-lifecycle.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run the relevant root lane**

Run:

```bash
pnpm test
```

Expected: zero failures. Record pass, skip, and duration totals.

- [ ] **Step 3: Run the real browser journey**

Use the authenticated web UI against the feature stack.

1. Start a standard OpenCode session.
2. Send a deterministic long-running prompt.
3. While it runs, send three distinct prompts in order.
4. Observe the prompts network requests return `202`.
5. Verify the three user bubbles remain in send order without reload.
6. Verify each queued prompt receives one response in FIFO order.
7. Verify the Stop control clears after the final turn.
8. Verify `GET .../prompts` removes each consumed row exactly once.
9. Repeat after dropping one terminal relay. Verify the reconciliation path recovers without reload.

Capture the exact API origin, project ID, session ID, delivered wire IDs, and visible final order. Do not record prompt text in server logs.

- [ ] **Step 4: Push the branch and update the draft PR**

Run:

```bash
git status --short
git push origin session-queue-turn-end-sync
gh pr view 7103 --json isDraft,labels,headRefOid,state,url
```

Confirm:

- the PR remains draft;
- the `preview` label remains present;
- `headRefOid` equals local `HEAD`;
- the PR remains open and unmerged.

Post a PR comment with the focused tests, root test totals, real-sandbox timestamps, browser evidence, preview origin, and deployed SHA. If preview deployment still fails before checkout, report the exact infrastructure failure and keep the PR draft.

- [ ] **Step 5: Final no-merge audit**

Run:

```bash
git status --short --branch
gh pr view 7103 --json mergeStateStatus,isDraft,state,mergedAt,url
```

Expected: clean worktree, draft open PR, and `mergedAt: null`.
