/**
 * The one abort classifier. Every producer of an "this turn was aborted"
 * error in this codebase — the SDK's own optimistic patch, the real opencode
 * wire error, and a plain `AbortController`/`fetch` abort — ends up here.
 *
 * Before this file, FOUR divergent detectors existed across `apps/web` and
 * this package: an identity read, a prose sniff with its own pattern lists, a
 * duck-typed name/message check, and a loose `/abort/i` regex. They agreed
 * often enough to hide the disagreements — e.g. `/abort/i` matches "aborted"
 * as a substring of a transport-failure message ("upstream unreachable …
 * The operation was aborted"), mislabeling a real failure as a user-initiated
 * stop. `isAbortError` is the single, documented replacement.
 *
 * Producers (studied, not guessed):
 * - `SyntheticAbortError` — the client-synthesized marker patched onto a
 *   message when the user hits Stop, or when a runtime disposes mid-stream.
 *   `{ name: "AbortError", data: { message: string } }`. See
 *   `react/use-session-send.ts` (`applyOptimisticAbort`) and
 *   `react/use-opencode-events/use-event-stream-refs.ts`
 *   (`markSessionAbortedLocally`).
 * - `MessageAbortedError` — the real opencode wire shape, one member of
 *   `AssistantMessage['error']` (`@opencode-ai/sdk` `types.gen.d.ts`).
 *   `{ name: "MessageAbortedError", data: { message: string } }`.
 * - A `DOMException`/`Error`-shaped `AbortError` from a real
 *   `AbortController`/`fetch` abort. `.name === "AbortError"`.
 */

/** Error names whose mere presence identifies an abort, no text sniff needed. */
const ABORT_ERROR_NAMES = new Set(['AbortError', 'MessageAbortedError']);

/**
 * Phrases that mean a HUMAN stopped this, not that a connection died.
 *
 * Phrases, never bare words: "aborted" is a substring of transport-failure
 * messages too ("The operation was aborted" is exactly how an aborted fetch
 * against an unreachable upstream describes itself), so a substring alone is
 * not evidence of intent.
 */
const ABORT_TEXT_PATTERNS = [
  'operation was aborted',
  'aborted by user',
  'interrupted by user',
  'cancelled by user',
  'canceled by user',
  'request was cancelled',
  'request was canceled',
  'aborterror',
];

/**
 * Words that mean the TRANSPORT failed. Their presence disqualifies the text
 * sniff outright, however abort-ish the rest of the prose reads.
 */
const TRANSPORT_FAILURE_TEXT_PATTERNS = [
  'unreachable',
  'upstream',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'network',
  'fetch failed',
  'timed out',
  'timeout',
  'gateway',
  '502',
  '503',
  '504',
];

/**
 * LAST RESORT ONLY — a substring sniff over arbitrary error prose. Used
 * internally by `isAbortError` when no `name` identity is available (a bare
 * string caller) or when `name` doesn't match a known abort shape but the
 * error's own nested text does (some producers carry an abort-ish message
 * under an unrelated/unknown `name`).
 */
function looksLikeAbortText(text: string): boolean {
  const lower = text.toLowerCase();
  if (TRANSPORT_FAILURE_TEXT_PATTERNS.some((p) => lower.includes(p))) return false;
  return ABORT_TEXT_PATTERNS.some((p) => lower.includes(p));
}

/** The text a structured error carries about itself — `data.message` (the
 *  shape every producer above uses) or a bare top-level `message`. */
function nestedErrorText(rec: Record<string, unknown>): string | undefined {
  const data = rec.data;
  const dataMessage =
    data && typeof data === 'object' ? (data as Record<string, unknown>).message : undefined;
  if (typeof dataMessage === 'string') return dataMessage;
  return typeof rec.message === 'string' ? rec.message : undefined;
}

/**
 * Was this error an abort — a user-initiated stop, or a client-synthesized
 * stand-in for one — as opposed to a genuine failure?
 *
 * Identity first: a `name` matching a known abort shape (`AbortError`,
 * `MessageAbortedError`) is always an abort, regardless of message text.
 * Falls back to sniffing the error's own nested text only when identity
 * doesn't resolve it — a plain string (the last-resort case: a caller that
 * only has a formatted display message, not the original structured error),
 * or a structured error whose `name` doesn't match but whose message reads
 * as an abort anyway.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error === 'string') return looksLikeAbortText(error);
  if (!error || typeof error !== 'object') return false;

  const rec = error as Record<string, unknown>;
  const name = rec.name;
  if (typeof name === 'string' && ABORT_ERROR_NAMES.has(name)) return true;

  const text = nestedErrorText(rec);
  return typeof text === 'string' ? looksLikeAbortText(text) : false;
}

/**
 * Every value a producer can stamp into `data.reason` on a
 * `SyntheticAbortError` — the machine-readable WHY behind an abort, read by
 * `abortErrorReason` below. Closed on purpose: a renderer branches on this
 * value (`'user'` → show "Interrupted", anything else → show nothing), so a
 * free-text reason would not fail loudly, it would just silently render
 * wrong.
 */
export const ABORT_REASONS = [
  /** `applyOptimisticAbort` (`react/use-session-send.ts`) — a real user Stop
   *  click, patched instantly so the "Interrupted" row appears before the
   *  SSE round-trip. */
  'user',
  /** `markSessionAbortedLocally` (`react/use-opencode-events/use-event-stream-refs.ts`),
   *  invoked from the `server.instance.disposed` handler in `handle-event.ts`.
   *  Pure infrastructure — OpenCode disposed and respawned mid-stream — for
   *  EVERY non-idle session in the tab, not a user action. Must render
   *  nothing: a respawn that recovers cleanly should not scar the transcript. */
  'runtime-disposed',
  /** NOT YET EMITTED — see `ABORT_REASONS_NOT_YET_EMITTED` below. */
  'orphan-finalized',
  /** NOT YET EMITTED — see `ABORT_REASONS_NOT_YET_EMITTED` below. */
  'wake',
] as const;

export type AbortReason = (typeof ABORT_REASONS)[number];

/**
 * Members that NO code path writes today. Read this before reading a zero.
 *
 * `'orphan-finalized'` is reserved for the sandbox daemon's orphan-turn
 * finalizer (`apps/kortix-sandbox-agent-server/src/main.ts`,
 * `finalizeOrphanedTurn` / `abortOpencodeTurn`). That finalizer aborts through
 * OpenCode's OWN `/session/{id}/abort` REST endpoint — a bare `POST` with no
 * body — so the resulting `MessageAbortedError` is entirely opencode's wire
 * shape. There is no hook to inject a client-chosen `data.reason` into it;
 * doing so would mean forking opencode's abort response, which is worse than
 * leaving it untagged. So a genuine wire abort (no synthetic patch involved)
 * stays reason-less on purpose — see `abortErrorReason`'s doc comment.
 *
 * `'wake'` is reserved for a not-yet-built producer (a session woken from a
 * park mid-turn) and is declared ahead of that work for the same reason
 * `apps/api/src/projects/stop-reason.ts` pre-declares `idle_grace` /
 * `boot_floor_expired`: a renderer branching on this union should see a
 * closed set, not discover a new member via a runtime string it never typed.
 */
export const ABORT_REASONS_NOT_YET_EMITTED = [
  'orphan-finalized',
  'wake',
] as const satisfies readonly AbortReason[];

/**
 * The machine-readable reason an abort happened, when the producer sent one
 * (`data.reason`, e.g. `'runtime-disposed'`). Set by `applyOptimisticAbort`
 * (`'user'`) and `markSessionAbortedLocally` (`'runtime-disposed'`). A real
 * opencode wire `MessageAbortedError` — the daemon's own `/abort` call, see
 * `ABORT_REASONS_NOT_YET_EMITTED` above — carries no `data.reason` and never
 * will, so this returns `undefined` for it: that is a genuine, once-only
 * cut turn, not a fabricated marker, and callers render it as "Interrupted"
 * exactly like a `reason: 'user'` abort. Returns `undefined` when absent,
 * never a guess.
 */
export function abortErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return undefined;
  const reason = (data as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason ? reason : undefined;
}
