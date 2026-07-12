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
  entries: Array<{ label: string; at: number }>;
  finished: boolean;
}

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

/** Start a timeline for a session, backdating to the click if we have it. */
export function beginSessionTiming(sessionId: string): void {
  if (!enabled()) return;
  const start = pendingClickAt ?? performance.now();
  pendingClickAt = null;
  if (!timings.has(sessionId)) {
    timings.set(sessionId, { start, entries: [], finished: false });
  }
}

/** Record a readiness gate. Idempotent per (session, label). */
export function sessionMark(sessionId: string, label: string): void {
  if (!enabled() || !sessionId) return;
  let t = timings.get(sessionId);
  if (!t) {
    t = { start: performance.now(), entries: [], finished: false };
    timings.set(sessionId, t);
  }
  if (t.entries.some((e) => e.label === label)) return;
  const at = performance.now();
  const prev = t.entries.length ? t.entries[t.entries.length - 1].at : t.start;
  t.entries.push({ label, at });
  // eslint-disable-next-line no-console
  console.log(
    `%c[session-timing] ${sessionId.slice(0, 8)} ${label} +${Math.round(at - prev)}ms (@${Math.round(at - t.start)}ms)`,
    'color:#06b6d4;font-weight:600',
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
  console.group(`%c[session-timing] ${sessionId.slice(0, 8)} READY in ${total}ms (click → usable)`, 'color:#06b6d4;font-weight:700');
  let prev = t.start;
  for (const e of t.entries) {
    // eslint-disable-next-line no-console
    console.log(`${e.label.padEnd(20)} +${String(Math.round(e.at - prev)).padStart(6)}ms   (@${Math.round(e.at - t.start)}ms)`);
    prev = e.at;
  }
  if (backendTimeline) {
    // eslint-disable-next-line no-console
    console.log('host (API) timeline:', backendTimeline);
  }
  // eslint-disable-next-line no-console
  console.groupEnd();
}
