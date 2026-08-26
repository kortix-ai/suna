/**
 * May a terminal card be painted for this session?
 *
 * The `/start` envelope already publishes the answer. `retriable` says the
 * server will re-attempt on its own; `boot.actively_starting` says a provider
 * operation is running right now. Neither had a reader on the two most
 * reachable terminal branches, so a wake cooldown — which the server answers as
 * `{stage:'starting', retriable:true}` — rendered "Couldn't start session".
 *
 * `retriable: null` means the owner has not answered yet. Absence is not
 * negation: withhold the card rather than assume the worst.
 */
export function shouldPaintTerminalCard(input: {
  hasFailure: boolean;
  retriable: boolean | null;
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
 * `retriable` is deliberately NOT one of its inputs -- a stale-wake PARK
 * (`preserveEstablishedRuntimeOnOpen`'s park branch,
 * apps/api/src/projects/routes/shared.ts:941-952) answers `stage:'failed'`
 * with `retriable:true` for a box nothing is driving any more, so reading it
 * here would suppress the one card that can still recover the user.
 *
 * `stage` IS an input, and it is checked first: a server reporting
 * `stage:'starting'` is not a terminal state, whatever the sandbox row says.
 * `sandbox.status` stays `'stopped'` throughout BOTH an active wake AND its
 * retry cooldown (`stoppedWakeResult`, apps/api/src/projects/routes/shared.ts)
 * -- and `activelyStarting` is `false` for BOTH the cooldown (still polling,
 * the server retries on its own) and a genuinely abandoned park. Only `stage`
 * tells them apart. Painting a dead end over a session `/start` is still
 * actively retrying was the reported bug.
 */
export function shouldPaintFatalCard(input: {
  stage: string | null;
  activelyStarting: boolean;
}): boolean {
  if (input.stage === 'starting') return false;
  return shouldPaintTerminalCard({
    hasFailure: true,
    retriable: false,
    activelyStarting: input.activelyStarting,
  });
}
