/**
 * Client-side session-readiness benchmarking.
 *
 * Measures the wall-clock a user actually feels: from clicking "New session"
 * to the chat being usable. The session-create flow spans a route push and
 * several independent readiness gates (sandbox row → active → server switch →
 * runtime healthy → opencode session → chat mounted), each on its own poll —
 * so dead time hides between them. This records a monotonic mark at every gate
 * and prints a grouped breakdown, alongside the backend (host) timeline that
 * rides in the sandbox row metadata.
 *
 * Marks are idempotent per label (React effects re-run) and survive the
 * client-side navigation from the sidebar to the session page (module-level
 * Map in the same JS context). Enabled in dev, or with
 * `localStorage.kortix_session_timing = '1'`.
 */

interface SessionTiming {
  start: number;
  /**
   * The Send press, when this timeline began with one (`beginSessionTiming`).
   * Null for a session the tab merely opened: there is no press to measure
   * `sendToFirstOutputMs` from, and mount time is not one.
   */
  sendStartedAt: number | null;
  entries: Array<{ label: string; at: number }>;
  finished: boolean;
}

/** The first assistant part for the session reached the browser. */
export const FIRST_OUTPUT_MARK = 'first-output';

/**
 * The devtools `%c` style for every line this module prints.
 *
 * A raw colour literal, and it stays one: `%c` takes plain CSS text that the
 * console parses outside the document, so a `var(--…)` token resolves to
 * nothing there. Nothing in this file reaches the product UI — the whole
 * module is off in production unless `kortix_session_timing` is set.
 */
const LOG_STYLE = 'color:#06b6d4;font-weight:600';
/** The same style, bold, for a line that reports a total. */
const LOG_STYLE_TOTAL = 'color:#06b6d4;font-weight:700';

const timings = new Map<string, SessionTiming>();
let pendingClickAt: number | null = null;

function enabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (process.env.NODE_ENV !== 'production') return true;
  try {
    return window.localStorage.getItem('kortix_session_timing') === '1';
  } catch {
    return false;
  }
}

/** Call the instant the user clicks "New session" (before the id is known). */
export function markSessionClick(): void {
  if (!enabled()) return;
  pendingClickAt = performance.now();
}

/**
 * Drop a press that never produced a session.
 *
 * Only `beginSessionTiming` consumes a press, and it runs on navigation. Every
 * send that stops short of one — a refused create, a connector gate, a throw
 * while the attachments resolve — must drop its own, or the press survives for
 * the tab's life and backdates the NEXT session's timeline by however long the
 * user idled in between.
 */
export function clearSessionClick(): void {
  pendingClickAt = null;
}

/** Start a timeline for a session, backdating to the click if we have it. */
export function beginSessionTiming(sessionId: string): void {
  if (!enabled()) return;
  const start = pendingClickAt ?? performance.now();
  pendingClickAt = null;
  if (!timings.has(sessionId)) {
    timings.set(sessionId, { start, sendStartedAt: start, entries: [], finished: false });
  }
}

/** Record a readiness gate. Idempotent per (session, label). */
export function sessionMark(sessionId: string, label: string): void {
  if (!enabled() || !sessionId) return;
  let t = timings.get(sessionId);
  if (!t) {
    t = { start: performance.now(), sendStartedAt: null, entries: [], finished: false };
    timings.set(sessionId, t);
  }
  if (t.entries.some((e) => e.label === label)) return;
  const at = performance.now();
  const prev = t.entries.length ? t.entries[t.entries.length - 1].at : t.start;
  t.entries.push({ label, at });
  // eslint-disable-next-line no-console
  console.log(
    `%c[session-timing] ${sessionId.slice(0, 8)} ${label} +${Math.round(at - prev)}ms (@${Math.round(at - t.start)}ms)`,
    LOG_STYLE,
  );
}

/**
 * Send press → first assistant output, in milliseconds. Null when this
 * timeline has no press, or no output yet.
 *
 * Pure, so the measurement is testable without a browser clock.
 */
export function sendToFirstOutputMs(timing: {
  sendStartedAt: number | null;
  entries: ReadonlyArray<{ label: string; at: number }>;
}): number | null {
  if (timing.sendStartedAt === null) return null;
  const mark = timing.entries.find((entry) => entry.label === FIRST_OUTPUT_MARK);
  return mark ? Math.round(mark.at - timing.sendStartedAt) : null;
}

/**
 * Record the first assistant output and report the whole wait.
 *
 * It logs its own line rather than joining `finishSessionTiming`'s group: the
 * chat is usable (`chat-ready`) well before the agent answers, so that group
 * has already printed and latched by the time output arrives.
 */
export function markSessionFirstOutput(sessionId: string): void {
  if (!enabled() || !sessionId) return;
  const before = timings.get(sessionId);
  if (before?.entries.some((entry) => entry.label === FIRST_OUTPUT_MARK)) return;
  sessionMark(sessionId, FIRST_OUTPUT_MARK);
  const t = timings.get(sessionId);
  const total = t ? sendToFirstOutputMs(t) : null;
  if (total === null) return;
  // eslint-disable-next-line no-console
  console.log(
    `%c[session-timing] ${sessionId.slice(0, 8)} sendToFirstOutputMs ${total}ms (send → first output)`,
    LOG_STYLE_TOTAL,
  );
}

/** Print the full breakdown once the chat is usable. */
export function finishSessionTiming(sessionId: string, backendTimeline?: unknown): void {
  if (!enabled() || !sessionId) return;
  const t = timings.get(sessionId);
  if (!t || t.finished) return;
  t.finished = true;
  const last = t.entries[t.entries.length - 1]?.at ?? performance.now();
  const total = Math.round(last - t.start);
  // eslint-disable-next-line no-console
  console.group(
    `%c[session-timing] ${sessionId.slice(0, 8)} READY in ${total}ms (click → usable)`,
    LOG_STYLE_TOTAL,
  );
  let prev = t.start;
  for (const e of t.entries) {
    // eslint-disable-next-line no-console
    console.log(
      `${e.label.padEnd(20)} +${String(Math.round(e.at - prev)).padStart(6)}ms   (@${Math.round(e.at - t.start)}ms)`,
    );
    prev = e.at;
  }
  if (backendTimeline) {
    // eslint-disable-next-line no-console
    console.log('host (API) timeline:', backendTimeline);
  }
  // eslint-disable-next-line no-console
  console.groupEnd();
}
