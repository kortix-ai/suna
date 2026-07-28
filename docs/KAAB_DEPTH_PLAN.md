# Kortix-as-a-Backend — depth plan

Written 2026-07-27, after a 7-lens adversarial audit (63 agents, 45 findings that
survived refutation) and a day of shipping against it. Ordered by
(real user impact × confidence) ÷ effort. Every item cites evidence; anything I
could not verify is marked as such rather than asserted.

## Phase 0 — the suite has no venue to run in

**Corrected 2026-07-27 after I got this wrong twice. Read the correction.**

### What is actually true — settled by a dispatch run, 2026-07-28

**`DOTENV_PRIVATE_KEY` is not configured as a repo secret at all.**

Proven, not inferred: dispatching `package-tests.yml` on `main`
(run `30335178547`) is a `workflow_dispatch` event, which satisfies the job's
`github.event_name != 'pull_request'` condition. The env-gated suite **still
skipped**, logging "DOTENV_PRIVATE_KEY not configured for this context".
`gh secret list` then confirmed the name is absent from the repository.

So the ternary

```yaml
DOTENV_PRIVATE_KEY: ${{ github.event_name != 'pull_request' && secrets.DOTENV_PRIVATE_KEY || '' }}
```

resolves to `''` on **every** event, and the ~1757-test suite runs nowhere.

**Do NOT "fix" this by adding `push: branches: [main]`.** That was my earlier
recommendation and it is wrong — it changes nothing while looking like a fix,
which is worse than the current visible gap.

**The actual fix is a human action:** provision `DOTENV_PRIVATE_KEY` as a
repository secret. The workflow's shape is already correct — the pentest's
condition rightly withholds the key from PR-head code — so once the secret
exists, `workflow_dispatch` works immediately and adding a `push: [main]`
trigger gives the suite a permanent venue where the key is safe to materialize.

### How many times I got this wrong

Recorded because the pattern is more useful than the answer:

| Claim | Verdict |
| --- | --- |
| "the suite doesn't run in CI" | Right conclusion, no evidence behind it |
| "it runs on push, just not PRs" | **Wrong** — I misread `gh run list --branch=main`, which lists PR-event runs |
| "the trigger list is `pull_request`-only, so the condition can never hold" | True, but not the binding constraint |
| "the secret is not configured" | **Confirmed** by a dispatch run + `gh secret list` |

Each step was a confident answer built on the previous one's framing rather than
on a measurement. The dispatch run cost two minutes and settled it.

### What I got wrong, and why it matters

1. **"26 failures in `e2e-project-session-contract.test.ts`"** — that was my
   local `KORTIX_BILLING_INTERNAL_ENABLED=true`. With CI's value the file is
   **44 pass / 0 fail**. I asserted it repeatedly and built a plan section on it.
2. **"93 failures across the suite"** — I ran `bun test src`, which includes
   integration and live files that `scripts/test.sh` deliberately excludes.
3. Even the correct command (`bash scripts/test.sh`) shows 56 local failures
   while CI is green, which proves my `.env` differs from CI's in more than the
   billing flag. **Local failure counts from this machine are not evidence about
   CI** and should not be quoted as such.

The lesson worth keeping: a local test run is evidence about the local
environment. Treating it as evidence about CI produced a confident, wrong
priority list.

### Still genuinely true

- Two files (`unit-preview-auth-principal`, `e2e-preview-proxy`) failed to LOAD
  from incomplete `mock.module` factories — a SyntaxError, environment-independent.
  Fixed in #5583 (0 → 24 and 0 → 52 tests). That fix stands.
- `e2e-preview-proxy` still shows 4 failures under CI's billing value. Narrowed
  but **not resolved** — what I ruled out, so the next person does not repeat it:

  | Hypothesis | Verdict |
  | --- | --- |
  | The `KORTIX_BILLING_INTERNAL_ENABLED` flag | **No** — fails under CI's value too |
  | Incomplete `mock.module` (the sibling-file failure mode) | **No** — stubbing `projects/lib/secret-grant` fully changed nothing |
  | Wrong sandbox id in the fixture | **No** — every prompt test uses `TEST_SANDBOX_ID`, and one env-sync test on that id PASSES |
  | The retry classifier mis-ranks a 401 as transient | **No** — `isRetryableEnvSyncFailure` (preview.ts:71) matches only 502/503/504, then returns `false` for any `env sync failed:` prefix |

  So the product's fail-closed path looks **correct**: a 401 env sync is
  classified non-retryable and should surface as 502. The tests assert exactly
  that and do not reach it. The remaining unknown is why the 401 never reaches
  `postEnvToDaemon` — most likely the `mockFetchResponses` queue ordering, since
  the passing sibling test supplies responses for BOTH the env-sync call and the
  forward while these four supply one.

  **Do not "fix" these by relaxing the assertions.** They encode the correct
  intent; the harness is what is not delivering the failure.
- A lint that fails a `mock.module` factory omitting exports the graph needs is
  still worth adding: that single class of bug zeroed two files silently.

## Phase 1 — correctness holes the audit confirmed

1. **`created_by` is still the isolation boundary for backend rows.** #5577
   stopped a sandbox token reaching a sibling session, but the underlying model —
   every KaaB session sharing one creator — remains. Until `origin='backend'`
   rows stop deriving ownership from `created_by`, each new read path is a fresh
   chance to leak. *No e2e proof exists yet that the current fix holds.*
2. **A create whose failure was already returned gets re-queued**
   (`engine.ts:275` passes `retryable` on the synchronous path; `store.ts:232`
   flips it to `queued`). The wrapper is told "try again", retries with a fresh
   key, and the original silently creates a second billed sandbox 2–20s later —
   same `end_user_ref`, both running the baked prompt. Fix: `retryable: false`
   on the inline path.
3. **Three connector-alias forms across three gates** (`db-deps.ts:845`,
   `router.ts:380`, `sessions.ts:880`). A manifest grant of `kortix_email` makes
   the connector invisible in the catalog; a grant of `email` makes it visible
   and then 403s on call. Canonicalize once at grant construction. Folds in the
   duplicate-alias raw-Postgres 500.
4. **`403 CONNECTOR_NOT_ASSIGNED` is undocumented** — and it is the first error
   the public docs' own flagship example hits on any project declaring agents.

## Phase 2 — finish the demo (it is the spec people copy)

Done: `end_user_ref` stamping, charge-by-end-user.

Remaining, in order of what teaches the most:

1. **`409 CONNECTOR_CONNECTION_REQUIRED`.** The one genuinely novel KaaB UX —
   the session refuses to start until *this end-user* connects their own account.
   Nothing in the demo models it; without it, wrapper authors will not know the
   flow exists.
2. **Connector-binding picker** — choose which connection a session runs as,
   using the per-row `profile_id`.
3. **Model switcher** wired to `PUT /sessions/{id}/model`, showing the
   `applied_live` distinction honestly rather than pretending it is instant.
4. **Secrets allowlist** — narrow a session to a subset, and show that the
   allowlist is *immutable* for that session's life.
5. **Idempotency** — demonstrate that replaying a key under a different
   end-user is refused, which is the safety property wrapper authors most often
   get wrong.
6. **Per-end-user concurrency cap** — currently `KORTIX_BACKEND_PER_ORIGIN_SESSION_LIMIT`
   defaults to 0 (off) and is set in no chart, so it is dark everywhere.

## Phase 3 — prove it, don't assert it

The two security fixes shipped today are covered by unit tests of their decision
functions and wiring — not by end-to-end proof:

- A token minted for session A must 404 on session B's transcript.
- Two connections under one connector must resolve to *different* policies
  through the gateway.
- A revoked secret must be absent from a child process spawned after revocation.

Each is a single integration test. Each currently rests on reasoning.

## Naming and docs debt

- `origin_ref` → `end_user_ref` is done at the wire, with the alias permanent.
  The DB column, the ops env var, and the error codes deliberately keep the old
  name; that is a defensible boundary but it should be written down where the
  next person looks.
- The public page claimed per-end-user metering did not exist for 108 minutes
  after it shipped, and nobody noticed until an audit read it. Docs drift on the
  only customer-facing KaaB page deserves a check, not vigilance.
