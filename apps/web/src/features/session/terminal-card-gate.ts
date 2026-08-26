/**
 * May a terminal card be painted for this session?
 *
 * The `/start` envelope already publishes the answer. `retriable` says the
 * server will re-attempt on its own; `boot.actively_starting` says a provider
 * operation is running right now. Neither had a reader on the two most
 * reachable terminal branches, so a wake cooldown — which the server answers as
 * `{stage:'starting', retriable:true}` — rendered "Couldn't start session".
 *
 * "Not yet known" is carried by `stage` (`provisioning`/`starting`), not by a
 * nullable `retriable` — the wire contract's `retriable` is a required
 * boolean (`SessionStartResult.retriable`, `session-sandbox.ts:64`), and every
 * caller of this function either has a real `/start` answer (so `retriable`
 * is a real boolean) or has nothing to gate at all. See `shouldPaintFatalCard`
 * for the `stage`-based branch, which is where the "not yet known" case is
 * genuinely enforced.
 */
export function shouldPaintTerminalCard(input: {
  hasFailure: boolean;
  retriable: boolean;
  activelyStarting: boolean;
}): boolean {
  if (!input.hasFailure) return false;
  if (input.activelyStarting) return false;
  if (input.retriable !== false) return false;
  return true;
}

/**
 * The `fatal` decision at page.tsx: may the "<session> is stopped / Restart
 * session" card paint over a `sandbox.status: 'error' | 'stopped'` row?
 *
 * Gates on `stage` ALONE. Two fields were tried and rejected here:
 *
 * - `retriable` is deliberately NOT an input. A stale-wake PARK
 *   (`preserveEstablishedRuntimeOnOpen`'s park branch,
 *   apps/api/src/projects/routes/shared.ts:941-952) answers `stage:'failed'`
 *   with `retriable:true` for a box nothing is driving any more, so reading
 *   it here would suppress the one card that can still recover the user.
 * - `activelyStarting` is deliberately NOT an input either. `stage:'failed'`
 *   is reachable with `actively_starting:true` — the second `stoppedWakeResult`
 *   call site (`shared.ts:1089`) can yield it via a detached wake-fence race
 *   the server code itself documents (`shared.ts:1070-1076`) — and a server
 *   reporting `failed` is terminal regardless of any in-flight flag.
 *   `shouldPollSessionStart` does not poll `stage:'failed'`, `isSandboxResumable`
 *   excludes the wake-class stop reasons so nothing re-invalidates the query,
 *   and the wake ladder only holds until it exhausts — so withholding the
 *   card there strands the user with no card AND no poll.
 *
 * `stage` alone already separates the only two shapes that must be withheld
 * (`starting`: still polling, the server retries on its own) from the three
 * that must paint (`failed`: the server is done trying).
 */
export function shouldPaintFatalCard(input: { stage: string | null }): boolean {
  return input.stage !== 'starting';
}
