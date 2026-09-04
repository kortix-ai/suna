/**
 * Resume-decision helpers for the session view.
 *
 * On the first `/start` of an idle-stopped session the backend can hand back a
 * TERMINAL stage with a non-null sandbox whose row is left EXACTLY resumable
 * (`status: 'stopped'` + an `external_id`) — see `openSession`'s self-preserve
 * path. A hard refresh's fresh `/start` then hits the resume path and wakes the
 * box. These helpers let the page recognize that state so it can auto-resume
 * (re-issue `/start`) instead of pinning a dead-end "open a new session" card.
 */

/** The subset of the `/start` sandbox payload the resume decision needs. */
export interface ResumableSandboxLike {
  status?: string | null;
  external_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The server has proven this runtime is gone and preserved its identity rather
 * than silently handing the session a fresh, empty box.
 *
 * This is the ONE terminal identity state. `recovering` / `recovery_claimed` /
 * `recovered` all describe a same-id restore that is still in flight, and those
 * must keep resuming normally.
 */
export function isRuntimeIdentityUnavailable(
  sandbox: ResumableSandboxLike | null | undefined,
): boolean {
  const metadata = sandbox?.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).runtimeIdentityState === 'unavailable';
}

/**
 * A hibernated box is still resumable when its row is `stopped` AND it kept an
 * `external_id` — a fresh `/start` wakes it in place (keeps its disk/workspace).
 * A stopped row with no `external_id` is genuinely gone and not resumable.
 *
 * A PRESERVED-UNAVAILABLE row is the trap those two fields cannot see. When the
 * provider loses a box, `openSession` deliberately keeps the row `stopped` WITH
 * its `external_id` — that is what "the identity was preserved, and no
 * replacement sandbox was created" means. Reading only status + external_id
 * therefore called a permanently dead runtime resumable, and the page spent its
 * whole auto-resume budget re-issuing `/start` against it (prod session
 * ad4b63ac, 2026-08-13) before landing on a Restart button that can only 409.
 */
export function isSandboxResumable(sandbox: ResumableSandboxLike | null | undefined): boolean {
  if (isRuntimeIdentityUnavailable(sandbox)) return false;
  const stopReason = sandbox?.metadata?.stopReason;
  if (stopReason === 'runtime_boot_failed' || stopReason === 'runtime_wake_failed') return false;
  return !!sandbox && sandbox.status === 'stopped' && !!sandbox.external_id;
}

/**
 * How long a resumable box is allowed to be "waking" before the page stops
 * waiting and offers a manual Restart.
 *
 * This replaced an ATTEMPT budget — three tries spaced 1500ms, so roughly THREE
 * SECONDS in total. A sandbox resume does not fit in three seconds: measured end
 * to end on dev (2026-08-24), `/start` alone answers in ~1.9s and the runtime
 * becomes reachable ~3s after that, and a loaded or image-heavy box is slower
 * still. So a perfectly healthy box that was merely asleep ran out of budget
 * MID-WAKE, and the page swapped its loader for the dead-end card
 *
 *     "session <id> is stopped — The sandbox for this session was stopped.
 *      Open a new session to continue."
 *
 * moments before that same box came up and the session loaded fine. Reported in
 * exactly those terms: "ALL OF THEM WILL SHOW ME THE ERROR AFTER TRYING TO
 * CONNECT FOR A WHILE & THEN THEY WILL CONNECT".
 *
 * A count cannot express "how long is it reasonable to wait for a machine to
 * boot" — it only counts how many times we asked, which says more about our
 * retry spacing than about the sandbox. A deadline says the thing we mean.
 */
export const AUTO_RESUME_WINDOW_MS = 90_000;

/**
 * Is this box still within its wake window — i.e. "waking", not "dead"?
 *
 * The page shows the boot loader while this is true and falls through to a
 * manual Restart once it is false.
 */
export function isAutoResuming(
  sandbox: ResumableSandboxLike | null | undefined,
  clock: { elapsedMs: number | null; windowMs?: number },
): boolean {
  if (!isSandboxResumable(sandbox)) return false;
  // No clock yet means the wait has only just begun — never treat "unknown" as
  // "expired", which is how a first paint would land straight on the dead end.
  if (clock.elapsedMs === null) return true;
  return clock.elapsedMs < (clock.windowMs ?? AUTO_RESUME_WINDOW_MS);
}

/** The subset of the `/start` payload the wake-class decision needs. */
export interface WakeFailureInput {
  /** Raw `/start` stage. */
  stage: string | null | undefined;
  /** Raw `/start` reason. */
  reason: string | null | undefined;
  sandbox: ResumableSandboxLike | null | undefined;
}

/**
 * The wake-class terminal verdicts — the ones a RESTART fixes, which is why the
 * escalation ladder holds their card back until it has actually tried one.
 *
 * The server produces this class through three different payloads, and they do
 * not agree on any single field:
 *
 * | Path | stage | retriable | reason | row stopReason |
 * |---|---|---|---|---|
 * | wake lease expired (`stoppedWakeResult`, routes/shared.ts:672-694) | `failed` | false | `runtime_wake_failed` | `runtime_wake_failed` |
 * | wake retry cooldown (routes/shared.ts:696-710) | `stopped` | false | `runtime_wake_cooldown` | — |
 * | stale wake parked (`preserveEstablishedRuntimeOnOpen` park branch, routes/shared.ts:809-820) | `failed` | **true** | the raw stale-wake reason | `runtime_wake_failed` |
 *
 * So `retriable` is deliberately NOT read: the third row would be missed, and
 * that one lands on the *other* dead end ("<session> is stopped") rather than
 * the provisioning card. What every member does share is a TERMINAL stage plus
 * a wake/boot verdict in either the reason or the row's `stopReason`.
 *
 * Two exclusions are load-bearing:
 *   - a runtime the provider LOST (`runtimeIdentityState: 'unavailable'`) is
 *     never wake-class — `POST /restart` answers 409 forever, so retrying it is
 *     the prod loop of session ad4b63ac;
 *   - a capacity or git-auth failure is not fixed by restarting either, and its
 *     card must appear at once.
 */
export function isWakeClassFailure(input: WakeFailureInput): boolean {
  if (input.stage !== 'failed' && input.stage !== 'stopped') return false;
  if (!input.sandbox?.external_id) return false;
  if (isRuntimeIdentityUnavailable(input.sandbox)) return false;
  const stopReason = input.sandbox?.metadata?.stopReason;
  return (
    input.reason === 'runtime_wake_failed' ||
    input.reason === 'runtime_wake_cooldown' ||
    stopReason === 'runtime_wake_failed' ||
    stopReason === 'runtime_boot_failed'
  );
}
