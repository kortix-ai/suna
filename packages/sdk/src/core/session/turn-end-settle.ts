/**
 * How long after a turn ends an UNNAMED failure is still provisional. The end
 * frame that names the cause is often one frame behind the abort it explains
 * (476 ms in the session that motivated this), and a read taken in that gap must
 * not say "no reason" and then change its mind.
 *
 * Its own module, and not re-exported from the session barrel: it is a tuning
 * value shared by `turnEndNotice` and `useSessionTurnOutcome`, not public API.
 */
export const TURN_END_SETTLE_MS = 2_500;
