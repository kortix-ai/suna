# Prompt queue: retries and timeouts

A prompt is a `continue_session` row in `kortix.session_lifecycle_commands`. The
states and the fields that encode them are in `delivery-state.ts`. This file is
the one table of every retry, wait and give-up rule on the path from the row to
the runtime, outermost first. A change to a limit changes this table in the same
commit.

| Hop | Rule | Limit | Then | Where |
|---|---|---|---|---|
| Wake | A queued row wakes the drain at its due time (NOTIFY); the poll is a backstop | ≥ 1 s between drain starts per process; poll after 5 s with LISTEN, every 1 s without | — | `workers/session-lifecycle-worker.ts`, migration `20261006135526223` |
| Claim | A claim holds the row `running` under a lease, renewed while in hand | lock 5 min, heartbeat every 100 s | another worker reclaims after lock + 5 min grace | `command-lease.ts`, `command-claims.ts` |
| Shutdown | SIGTERM stops claiming and waits for in-flight rows | 5 s | rows still held go back to `queued`, attempt returned | `claim-handover.ts` |
| Admission | A row waits behind a live turn or an older prompt; not an attempt | 300 ms, doubling after 4 refusals, max 2 s | re-admitted on the turn-end relay | `inbox-admission.ts` |
| Steer admission | A `steer` row and a live turn (one active turn with a message id): steered when the runtime lists `session.steer`, the actor is the turn's prompter, and no older steer row is queued or claimed. Older Queue List rows do not block it | same backoff as Admission while an older steer row, a turn still being delivered, or an unreadable `/kortix/health` holds it | capability or prompter check fails → `delivery: 'queue'`, `steerFallback` (`unsupported` / `not_prompter`) written once, queue admission | `inbox-admission.ts` (`admitSteer`) |
| Steer hand-off | One `POST .../steer` to the awake box; no wake, no landing proof, no placement repair | 1 POST (proxy retries only) | 409 `no_active_turn` → `turn_ended`, 501 → `unsupported` (capability memo dropped): fallback written, requeued due now, attempt returned. Other failures: as Failed attempt / Runtime down | `queued-continue-delivery.ts` (`deliverSteer`) |
| Steer witness | A forwarded steer row closes on the daemon's `steer_read` relay, or on a turn end that names its id (the steered-into turn closes) | — | the Forwarded, unconsumed sweep | `routes/turn-stream-handlers.ts`, `consumption.ts` (`steerTargetAtTurnEnd`) |
| Readiness | A cold box is waited for before the first POST | 5 min (re-open every 3 s, 500 ms once active) | `pending` → retried as a failed attempt | `deliver.ts` |
| Hand-off | A POST to a just-woken runtime is retried through transient failures | 45 s window, every 1.5 s | `unreachable` or `pending` | `deliver.ts` (`deliverWithRetry`) |
| Proxy | One POST through the sandbox proxy, never re-sent on an ambiguous error | 250 ms, 1 s, 3 s within 50 s | error to the caller | `sandbox-proxy/preview-retry-budget.ts` |
| Landing proof | A prompt of 64 KiB or more is read back after the POST | 3 reads, 700 ms apart | not landed → re-sent under a new key after 2 s, at most 2 times | `prompt-landing-proof.ts`, `command-transitions.ts` (`MAX_LANDING_RETRIES`) |
| Placement repair | A prompt stranded below a newer assistant is removed and re-sent | 2 rounds | turn-end reconciliation | `queued-continue-delivery.ts`, `inbox-placement.ts` |
| Runtime down | The box is stopped or failed; the prompt waits for it, the attempt is returned | 30 s, 2 min, 8 min (3 parks) | dead-lettered with the unreachable copy | `command-transitions.ts` (`parkPromptForUnreachableRuntime`) |
| Failed attempt | Any other retryable failure | 5 attempts, wait min(60 s, 2 s × attempt) | dead-lettered | `command-transitions.ts` (`markCommandFailed`) |
| Answer check | A re-sent prompt first checks whether it was already answered | 3 unreadable checks, 5 s × 2ⁿ apart | sent without the check | `queued-continue.ts` |
| Forwarded, unconsumed | A forwarded prompt no turn consumed | orphan after 90 s; confirmation window 30 s to 10 min | redelivered, at most 3 times, then dead-lettered | `consumption.ts`, `redelivery.ts` |
| Strand repair | Turn-end re-placement of a stranded forwarded prompt | 3 redeliveries | left forwarded; the sweep closes it | `forwarded-strand-reconcile.ts` |
| Duplicate send | The same delivery key or wire id within 10 min (proxy, per replica); the same wire id ever (kortixd, both harnesses) | — | answered `deduplicated`, not re-sent | `sandbox-proxy/prompt-dedupe.ts`, kortixd `harness/*/turns.ts` |
| Starvation | A row due more than 10 min ago that no drain took | every 5 min, 25 rows (leader) | delivered by the reconciler | `undelivered-prompts.ts` |

**Nesting.** Hand-off retries wrap proxy retries, so one hand-off can take up to
45 s + 50 s before it reports. Readiness (5 min) runs before both. A claim's
lease outlives all three through its heartbeat.

**Attempt budget.** Only "Failed attempt" spends the 5-attempt budget.
Admission refusals, runtime-down parks, shutdown hand-backs and paused
deliveries return the claim's increment.
