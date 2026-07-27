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

/**
 * THE predicate. R-28 answer 5, in one expression.
 *
 * Both halves are load-bearing and neither implies the other:
 *
 *   • `status === 'pending'` — a satisfied or cancelled request is history. It
 *     must stop propping the task up the moment it is answered, or the first
 *     credential a workspace ever supplies makes its task look alive forever.
 *   • `deliveredAt !== null` — R-12g. This is the whole §4.3 distinction: the
 *     ask reached a surface a human sees. A row with a null `delivered_at` was
 *     recorded and never sent, which is the database-shaped version of writing
 *     it in the session log.
 *
 * `responderUserId` is deliberately NOT re-checked here: the delivery-addressed
 * CHECK constraint makes a delivered row with no responder unstorable, so the
 * timestamp already implies the addressee. Re-deriving it in JavaScript would be
 * a second source of truth that could drift from the one the database enforces.
 */
export function isLiveRequest(
  request: Pick<AgiRequestRow, 'status' | 'deliveredAt'>,
): boolean {
  return request.status === 'pending' && request.deliveredAt !== null;
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
