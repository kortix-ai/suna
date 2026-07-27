/**
 * The AGI human-request WIRE contract: vocabularies, the fingerprint, the
 * row→JSON serializer, and the one predicate liveness depends on.
 *
 * Everything here is pure — no database, no Hono context, no clock of its own.
 * That matters more than usual for this module: the whole feature turns on ONE
 * boolean ({@link isLiveRequest}), and a wrong answer there is silent in exactly
 * the way §4.3 was written about — a task reads healthy while nobody has been
 * told anything.
 *
 * Spec: docs/specs/2026-07-26-agi-autonomous-operations.md §4.3 (R-12g), and
 * R-28 answer 5 ("a pending approval or question awaiting a specific responder").
 */
import { createHash } from 'node:crypto';
import type { agiRequests } from '@kortix/db';

export type AgiRequestRow = typeof agiRequests.$inferSelect;

/**
 * What KIND of human act is being asked for.
 *
 * These are the four things that actually stop an unattended run, and each maps
 * to a different act on the human's side:
 *
 *   secret     — a credential. The agent mints `kortix secrets request <NAME>`
 *                and NEVER sees the value.
 *   connector  — an integration to authorize, via `kortix connectors link <slug>`.
 *   access     — a grant on something outside Kortix (a Search Console property,
 *                a repo, a dashboard). Usually no minted URL; a person has to go
 *                click something in someone else's product.
 *   decision   — a judgement call the agent is not entitled to make alone.
 *
 * text + CHECK in the database rather than a pg enum, same reasoning as the task
 * vocabularies: these will move while `agi` is experimental, and a CHECK can be
 * dropped where an enum value can never be removed.
 */
export const REQUEST_KINDS = ['secret', 'connector', 'access', 'decision'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = ['pending', 'satisfied', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * The surface a request actually reached. R-12g's list, minus the one that does
 * not count.
 *
 *   slack  — a direct message to the responder. A push notification on a phone;
 *            this is what "delivered" means when it can be had.
 *   inbox  — the durable row itself, addressed to a named person and listed by
 *            `kortix tasks waiting` and the liveness route. Weaker than Slack —
 *            the human has to come looking — but it is a real surface with a
 *            real addressee, which is exactly what a session log is not.
 *
 * There is no `log` member and there must never be one. R-12g: "Writing it into
 * the session log is NOT delivery."
 */
export const DELIVERY_SURFACES = ['slack', 'inbox'] as const;
export type DeliverySurface = (typeof DELIVERY_SURFACES)[number];

export const REQUEST_NEED_MAX_LENGTH = 500;
export const REQUEST_WHY_MAX_LENGTH = 4000;
export const REQUEST_URL_MAX_LENGTH = 2048;
export const REQUEST_LIST_MAX_LIMIT = 200;
export const REQUEST_LIST_DEFAULT_LIMIT = 50;

export function isRequestKind(value: unknown): value is RequestKind {
  return typeof value === 'string' && (REQUEST_KINDS as readonly string[]).includes(value);
}

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value);
}

// ─── R-12g: what counts as a live path to a human ───────────────────────────

/** Milliseconds in an hour. The env override is stated in hours because that is
 *  the unit a human reasons about waiting in; everything in code carries ms so
 *  there is only ever one conversion, here. */
const HOUR_MS = 3_600_000;

/**
 * How long a DELIVERED, still-pending ask keeps counting as a live path.
 *
 * Two days.
 *
 * The ask is a single event. On a fresh workspace the surface it reaches is the
 * `inbox` tier — a durable row the human has to come looking for — and R-12g
 * deliberately buys no second nag, so nothing after the first delivery will
 * remind anybody. Without an age term that one unanswered row keeps its task in
 * `awaiting_response` forever, which is the SAME false-healthy verdict §4.3 was
 * written to abolish, arrived at from the other direction: before §4.3 the goal's
 * push made a blocked task look fine, and after it an ask nobody read does.
 *
 * Forty-eight hours is one full working day with a night on either side: an ask
 * delivered on Friday evening surfaces as unanswered on Sunday evening, which is
 * exactly when a Monday-morning human wants it at the top of the stall report. A
 * shorter window would trip on a human who saw it and planned to do it after
 * lunch; a longer one lets a whole week of unattended pushes re-derive the same
 * block against a wall nobody was told is still standing.
 *
 * The cost of being early is one line in a report a human already reads (R-29:
 * surfaced, never retried — liveness refuses to manufacture a continuation for
 * an unanswered ask). The cost of being late is a workspace that is stuck and
 * says it is fine. So the bias is deliberately toward early.
 */
export const DEFAULT_REQUEST_UNANSWERED_HOURS = 48;

export const REQUEST_UNANSWERED_ENV_KEY = 'KORTIX_AGI_REQUEST_UNANSWERED_HOURS';

/**
 * The configured window, in milliseconds.
 *
 * A bad value falls back to the default rather than throwing, for the same
 * reason `resolveFlatStallThreshold` does: a typo in an env var must not be able
 * to switch the detector off, and `age < NaN` is always false — which would
 * silently make EVERY delivered ask a live path forever, the exact defect this
 * threshold exists to close. Zero is rejected for the mirror-image reason: it
 * would stall every ask the instant it was delivered.
 */
export function resolveRequestUnansweredAfterMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[REQUEST_UNANSWERED_ENV_KEY];
  const fallback = DEFAULT_REQUEST_UNANSWERED_HOURS * HOUR_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const hours = Number(raw.trim());
  return (hours >= 1 ? hours : DEFAULT_REQUEST_UNANSWERED_HOURS) * HOUR_MS;
}

/**
 * R-12g's line, and nothing else: did this ask reach a surface a human sees?
 *
 * Kept separate from {@link isLiveRequest} because the two questions have
 * different answers and a caller reporting WHY a task is stuck needs both. An
 * ask that was never delivered and an ask that was delivered and ignored are
 * different failures with different fixes — deliver it, versus go and answer it
 * — and collapsing them would report "nobody was told" about a person who was
 * told forty-five days ago.
 *
 * `responderUserId` is deliberately NOT re-checked: the delivery-addressed CHECK
 * constraint makes a delivered row with no responder unstorable, so the
 * timestamp already implies the addressee. Re-deriving it in JavaScript would be
 * a second source of truth that could drift from the one the database enforces.
 */
export function isDelivered(request: Pick<AgiRequestRow, 'deliveredAt'>): boolean {
  return request.deliveredAt !== null && request.deliveredAt !== undefined;
}

/**
 * Has a delivered ask gone unanswered past the window?
 *
 * Takes `now` rather than reading the clock, so liveness — which is a total
 * function over rows plus one caller-supplied instant — can ask the question
 * with the same `now` it judges everything else with. An `undefined` timestamp
 * means the caller does not know when delivery happened and the age cannot be
 * judged; that answers `false`, because inventing an age would stall a task on a
 * fact nobody has.
 */
export function isRequestAnswerOverdue(input: {
  deliveredAt: Date | null | undefined;
  now: Date;
  unansweredAfterMs: number;
}): boolean {
  if (!input.deliveredAt) return false;
  return input.now.getTime() - input.deliveredAt.getTime() >= input.unansweredAfterMs;
}

/** How long a delivered ask has been waiting, in ms, or null when it was never
 *  delivered (or the caller did not supply the timestamp). Never negative: a row
 *  delivered a few ms into the future by clock skew has waited zero. */
export function requestUnansweredForMs(input: {
  deliveredAt: Date | null | undefined;
  now: Date;
}): number | null {
  if (!input.deliveredAt) return null;
  return Math.max(0, input.now.getTime() - input.deliveredAt.getTime());
}

/**
 * THE predicate. R-28 answer 5, in one expression.
 *
 * Three halves now, and none implies another:
 *
 *   • `status === 'pending'` — a satisfied or cancelled request is history. It
 *     must stop propping the task up the moment it is answered, or the first
 *     credential a workspace ever supplies makes its task look alive forever.
 *   • delivered — R-12g. The ask reached a surface a human sees. A row with a
 *     null `delivered_at` was recorded and never sent, which is the
 *     database-shaped version of writing it in the session log.
 *   • not overdue — R-28 answer 5 says "AWAITING a specific responder", and
 *     waiting is a thing that can stop being true. A delivery is one event, not
 *     a standing promise that somebody will act; past the window the ask has
 *     become the same kind of evidence as a PID or a stated intention (R-30) —
 *     something that happened once and moves nothing.
 *
 * `now` and the window default rather than being required so that the callers
 * that only have a row (the serializer's `live` field, the session-terminal
 * writeback) get the aged answer too. Every caller reading the same verdict is
 * the property this module is built around; a second implementation would
 * eventually disagree, and the direction it would disagree in is "reads healthy,
 * nobody is coming".
 */
export function isLiveRequest(
  request: Pick<AgiRequestRow, 'status' | 'deliveredAt'>,
  options: { now?: Date; unansweredAfterMs?: number } = {},
): boolean {
  if (request.status !== 'pending' || !isDelivered(request)) return false;
  return !isRequestAnswerOverdue({
    deliveredAt: request.deliveredAt,
    now: options.now ?? new Date(),
    unansweredAfterMs: options.unansweredAfterMs ?? resolveRequestUnansweredAfterMs(),
  });
}

// ─── R-20 applied to asking a human ─────────────────────────────────────────

export const REQUEST_FINGERPRINT_PREFIX = 'agi-request:v1';

/**
 * The identity of an ASK, so the same ask made twice is one row.
 *
 * This is not a nicety. A goal's standing `push` re-derives the same block every
 * morning: the same task, still needing the same Search Console grant. Without a
 * default fingerprint the human is direct-messaged once a day forever, learns to
 * ignore the bot, and the feature becomes worse than the silence it replaced.
 *
 * Derived from (task, kind, need) and nothing else. No timestamp, no session id,
 * no responder — including any of them would make each morning's identical ask a
 * NEW ask, which is precisely the bug. It mirrors `stallFingerprint`, for the
 * same reason and with the same discipline: feed it the same evidence twice and
 * it MUST return the same string.
 *
 * `need` is folded to a canonical form first so "Google Search Console access"
 * and "google search console access" cannot become two asks.
 */
export function requestFingerprint(input: {
  taskId: string;
  kind: RequestKind;
  need: string;
}): string {
  const digest = createHash('sha256')
    .update([input.taskId, input.kind, canonicalNeed(input.need)].join('\0'), 'utf8')
    .digest('hex');
  return `${REQUEST_FINGERPRINT_PREFIX}:${digest.slice(0, 32)}`;
}

/** Case- and whitespace-insensitive form of a `need`, used ONLY to compute the
 *  fingerprint. The stored `need` keeps the author's own wording — it is what a
 *  human reads in the DM. */
export function canonicalNeed(need: string): string {
  return need.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── serialization ──────────────────────────────────────────────────────────

/**
 * Row → wire. `live` is DERIVED rather than stored, so every caller — CLI, UI,
 * another agent — reads the same verdict liveness reads, and none of them has to
 * re-implement {@link isLiveRequest} and get it subtly wrong.
 */
export function serializeAgiRequest(row: AgiRequestRow) {
  return {
    request_id: row.requestId,
    workspace_id: row.workspaceId,
    task_id: row.taskId,
    kind: row.kind,
    need: row.need,
    why: row.why,
    url: row.url,
    responder_user_id: row.responderUserId,
    status: row.status,
    delivered_at: row.deliveredAt?.toISOString() ?? null,
    delivered_via: row.deliveredVia,
    live: isLiveRequest(row),
    requested_by_session_id: row.requestedBySessionId,
    origin_fingerprint: row.originFingerprint,
    satisfied_at: row.satisfiedAt?.toISOString() ?? null,
    satisfied_by_user_id: row.satisfiedByUserId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export type SerializedAgiRequest = ReturnType<typeof serializeAgiRequest>;

// ─── the message a human actually receives ──────────────────────────────────

/**
 * The one-line summary that becomes a Slack DM's fallback text and the subject
 * of an inbox row.
 *
 * Built here, in the pure module, so the delivery transport cannot quietly
 * change what the request SAYS — the transport chooses how to render it, never
 * what it asks for.
 */
export function requestHeadline(input: { kind: RequestKind; need: string }): string {
  const verb = input.kind === 'decision' ? 'needs a decision' : 'needs access';
  return `Kortix ${verb}: ${input.need}`;
}

/**
 * The plain-text body. Deliberately the SAME text for every surface, so a human
 * who saw it in Slack and a human who read it in `kortix tasks waiting` are
 * looking at the identical ask.
 *
 * `url` is rendered last and labelled, because it is the thing to click. It is
 * never a value to copy: the link opens a form the human fills in, and the agent
 * never sees what they type.
 */
export function requestBody(input: {
  kind: RequestKind;
  need: string;
  why: string | null;
  url: string | null;
  taskId: string;
  taskTitle: string;
  sessionId: string | null;
}): string {
  const lines = [requestHeadline(input), ''];
  if (input.why) lines.push(input.why, '');
  lines.push(`task: ${input.taskTitle} (${input.taskId})`);
  if (input.sessionId) lines.push(`session: ${input.sessionId}`);
  if (input.url) {
    lines.push('', `Open this to supply it: ${input.url}`);
    // Said out loud on the human's side too, so nobody replies to the bot with a
    // pasted key. The link is the only channel a credential may travel on.
    if (input.kind === 'secret' || input.kind === 'connector') {
      lines.push('The form is the only place to enter it — never paste it in a reply.');
    }
  }
  return lines.join('\n');
}
