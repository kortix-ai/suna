/**
 * How many applied event ids `deltaEventTails` remembers per
 * `(message, part, field)` key. Duplicate deliveries re-send RECENT events (a
 * stacked connection delivers the same frame twice within milliseconds; a
 * reconnect replays the tail since the last seen id), so a recent window is
 * sufficient. Unbounded, a long answer streamed a few characters at a time
 * kept one entry per delta until `session.idle`.
 */
export const DELTA_EVENT_TAIL_LIMIT = 2048;
