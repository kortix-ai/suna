/**
 * The composer's "computer stays on" line (KRTX-1729).
 *
 * A person who may start the session keeps its computer on while they use the
 * page, by the idle grace, but never past a cap: 2 h after the latest turn.
 * `useSession().presenceAwake` carries the server's answer from the latest
 * presence renewal: `until`, when the computer stops, and `capAt`, the time
 * presence cannot keep it on past.
 *
 * Two lines, decided here so the component only renders:
 *
 * - `stays`: presence still extends the computer. It says how long it can:
 *   `capAt - now`, rounded down, because "up to" must never overstate.
 * - `stops`: the deadline reached the cap, so presence no longer extends it.
 *   It says when the computer stops: `until - now`, rounded up, so the last
 *   minute never reads "0 min". A message starts a turn and moves the cap.
 *
 * Hidden while a turn runs (the turn keeps the computer on), with no window (a
 * viewer, a stopped computer, an absent tab), once `until` has passed, and
 * when `until` is past the cap. Presence never writes a deadline past its own
 * cap, so another grant holds that one: a preview port, which renews on each
 * request, or a turn the ledger has not closed yet (a refresh between the
 * runtime's idle frame and the ledger's close reads a 4 h deadline under a
 * 2 h cap). A countdown to that deadline would be false.
 */

/** How often the line re-reads the clock. */
export const COMPUTER_AWAKE_TICK_MS = 30_000;

const MINUTE_MS = 60_000;
/** A deadline this close to the cap is the cap: presence wrote it. */
const AT_CAP_MS = 1_000;

type DurationKey = 'computerAwakeHoursMinutes' | 'computerAwakeHours' | 'computerAwakeMinutes';

export interface ComputerAwakeLine {
  kind: 'stays' | 'stops';
  /** Whole minutes: rounded down for `stays`, up for `stops`, at least 1. */
  minutes: number;
}

export function computerAwakeLine(input: {
  awake: { until: Date; capAt: Date } | null;
  turnRunning: boolean;
  now: number;
}): ComputerAwakeLine | null {
  const { awake, turnRunning, now } = input;
  if (!awake || turnRunning) return null;
  const until = awake.until.getTime();
  const capAt = awake.capAt.getTime();
  if (now >= until || until > capAt + AT_CAP_MS) return null;
  if (until >= capAt - AT_CAP_MS) {
    return { kind: 'stops', minutes: Math.max(1, Math.ceil((until - now) / MINUTE_MS)) };
  }
  return { kind: 'stays', minutes: Math.max(1, Math.floor((capAt - now) / MINUTE_MS)) };
}

/** The line's text, through the `hardcodedUi.i18nComplete` catalog. */
export function computerAwakeText(
  line: ComputerAwakeLine,
  t: (
    key: DurationKey | 'computerAwakeStays' | 'computerAwakeStops',
    values: Record<string, string | number>,
  ) => string,
): string {
  const hours = Math.floor(line.minutes / 60);
  const minutes = line.minutes % 60;
  const duration =
    hours === 0
      ? t('computerAwakeMinutes', { minutes })
      : minutes === 0
        ? t('computerAwakeHours', { hours })
        : t('computerAwakeHoursMinutes', { hours, minutes });
  return t(line.kind === 'stays' ? 'computerAwakeStays' : 'computerAwakeStops', { duration });
}
