import { sessionLifecycleCommands } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';

/**
 * `payload.deliveryAttempt + 1`, merged into the payload expression given.
 *
 * WHY A COUNTER AT ALL: the proxy claims `idem:<sandbox>\0<session>\0<key>` for
 * `DEDUPE_TTL_MS` (10 min) on every prompt delivery, and `executeQueuedContinue`
 * derives that key from the command id. A row that goes back on the queue after
 * it has ALREADY BEEN POSTED — a redelivery, a released Stop, "send now" on a
 * stop-paused row — would re-POST under the same key and be answered
 * `200 {"deduplicated": true}`, which `postPrompt` reads as delivered. OpenCode
 * never receives the message and the row is force-closed ten minutes later with
 * nothing logged but "no proof it was consumed".
 *
 * WHY NOT `redeliveries`: that counter is the reaper's BUDGET
 * (`MAX_PROMPT_REDELIVERIES` dead-letters past it). Spending it on a user
 * pressing Stop and re-sending would take away the automatic repair that exists
 * for a prompt a turn really did drop.
 *
 * Every writer that puts a POSTed row back on the queue must call this. It is
 * the only reason `executeQueuedContinue`'s idempotency key ever changes.
 */
export function withNextDeliveryAttempt(payload: SQL): SQL {
  return sql`jsonb_set(
    ${payload},
    '{deliveryAttempt}',
    to_jsonb(COALESCE((${sessionLifecycleCommands.payload}->>'deliveryAttempt')::int, 0) + 1))`;
}
/**
 * Record a re-minted wire id WITHOUT losing the earlier ones.
 *
 * The scalar `redeliveredMessageId` stays the LATEST id — every floor read
 * (`readDeliveredWireIdFloor`) and the already-answered guard want the newest.
 * But a prompt can be re-minted more than once (it waits behind a live turn,
 * then a strand re-places it), and OVERWRITING the scalar dropped the first
 * re-minted id: a `session_turns` ledger row keyed on THAT id then matched no
 * inbox row (`wireMessageIdMatches`), so the confirmation, the redelivery and
 * the strand-reconcile all missed it and the row read `delivering` for ever.
 *
 * So the ids are APPENDED to `redeliveredMessageIds` as well — the array
 * `wireMessageIdMatches` tests with `@>`, so ANY id the prompt was ever placed
 * under names its row. Returns the new payload expression; compose it with
 * `withNextDeliveryAttempt` when the write also advances the attempt counter.
 */
export function withRemintedWireId(id: string): SQL {
  return sql`jsonb_set(
    ${sessionLifecycleCommands.payload} || ${JSON.stringify({ redeliveredMessageId: id })}::jsonb,
    '{redeliveredMessageIds}',
    coalesce(${sessionLifecycleCommands.payload}->'redeliveredMessageIds', '[]'::jsonb) || ${JSON.stringify([id])}::jsonb)`;
}

/** One part of a prompt body, in OpenCode's own `/prompt_async` shape. */
export interface PromptPartWire {
  type: 'text' | 'file' | 'agent';
  text?: string;
  mime?: string;
  url?: string;
  attachment_id?: string;
  filename?: string;
  name?: string;
  source?: unknown;
}

/** The per-prompt picks the producer captured at submit time. Applied verbatim
 *  on delivery, so a prompt queued behind a live turn still runs with the
 *  agent/model the user chose then, not whatever is current when it drains. */
export interface PromptOverridesWire {
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  directory?: string | null;
}

export interface QueuedContinueSessionPayload {
  /** Legacy single-text form. Still written by every non-inbox producer
   *  (triggers, Slack, approval-resume). Read when `parts` is absent. */
  text: string;
  /** When set, the drain SKIPS delivery if this execution's decision was
   *  already consumed in-band (a live held/poll request resumed the turn) —
   *  the follow-up prompt would just be noise. */
  executionId?: string | null;
  /** Which trigger fired this prompt — diagnostics only, carried into the
   *  dead-letter alert so "which automation lost its prompt" is answerable
   *  from the log line alone. */
  triggerSlug?: string | null;
  /** Allow-listed env applied before delivery (email turns on connector MCP). */
  opencodeEnv?: Record<string, string | null>;
  /**
   * Written by `deliverThroughQueue` for a producer that used to call
   * `continueSession` directly (a channel reply, a question answer). Two things
   * keep that call's behaviour: admission does not hold it behind a live turn
   * (a Slack reply mid-turn joins the turn whose handle streams its answer),
   * and a dead-letter does not park the session.
   */
  directFollowUp?: boolean;

  // ── Prompt-inbox fields. Absent on every row enqueued before the inbox
  //    existed, which is why every reader below falls back to `text`.

  /** The host's stable submission name. Same id = same logical send, which is
   *  what makes `prompt:<sessionId>:<clientMessageId>` a real idempotency key. */
  clientMessageId?: string;
  /**
   * The CLIENT-minted OpenCode wire id, used VERBATIM on first delivery.
   *
   * The client mints it because the client is the process holding the
   * transcript: OpenCode decides "has this prompt already been answered?" by id
   * order, so an id has to be placed above everything already on record. The
   * control plane mints one only on redelivery, where it re-reads the
   * transcript first (see `wire-message-id.ts`).
   */
  wireMessageId?: string;
  /**
   * The id this prompt was ACTUALLY delivered under, when it is not
   * `wireMessageId`.
   *
   * Two paths write it, for the same reason — the client's id is only correctly
   * placed while nothing newer has been written to the transcript: a redelivery
   * (N >= 1), and a first delivery that WAITED behind a live turn. Persisted
   * before the POST, so a crash between mint and delivery reuses one id.
   */
  redeliveredMessageId?: string;
  /**
   * EVERY id a re-mint has ever placed this row under, appended in order.
   *
   * `redeliveredMessageId` above is only the LATEST; a prompt re-minted twice
   * keeps both here so a ledger row keyed on the FIRST still names its inbox
   * row (`wireMessageIdMatches` tests membership with `@>`). Written by
   * `withRemintedWireId`; absent on a row that never waited or re-delivered.
   */
  redeliveredMessageIds?: string[];
  /**
   * Stamped on every queued row when a Stop hold is released. Rows sharing it
   * are delivered as separate user messages and answered in ONE turn: all but
   * the last go out `noReply`. Absent on a normal queue, which stays one
   * prompt per turn.
   */
  releasedBatchId?: string;
  /**
   * Stamped with `releasedBatchId`: true on a row the Stop HELD, false on the
   * send that released it. A held row predates anything staged while the
   * session was stopped — a rewind — and must not commit it; the send made
   * after the rewind is the prompt that does. Read in place of the usual
   * "did it wait" markers, which every batch row picks up by waiting behind
   * its own siblings (`placeQueuedContinue`).
   */
  releasedFromHold?: boolean;
  /** How many times a PROVEN-abandoned delivery has been requeued. Capped by
   *  `MAX_PROMPT_REDELIVERIES`. */
  redeliveries?: number;
  /** How many times this row has already been POSTed to OpenCode. Suffixes the
   *  delivery's idempotency key — see `withNextDeliveryAttempt`. */
  deliveryAttempt?: number;
  /**
   * This row did NOT go out on its first claim, so the client's wire id can no
   * longer be trusted to sort above the transcript.
   *
   * Written by every path that puts a row back in line — an admission refusal,
   * a hold, a "send now"/retry — and NEVER cleared, because "was overtaken
   * once" stays true. It lives in the payload rather than in `result` because
   * `result` is replaced wholesale by the retry that most needs this fact.
   *
   * A PRODUCER may also set it at enqueue time (`remint_on_delivery` on
   * `POST .../prompts`) when it knows its id was minted somewhere the live
   * transcript could not be read — the one-time localStorage migration, which
   * mints at page load for a message typed before the last reload.
   */
  remintOnDelivery?: boolean;
  /** The sender tab's clock at Enter — the SEND order across surfaces whose
   *  POSTs race (boot shell vs chat during the crossfade). */
  clientSentAtMs?: number;
  placement?: 'transcript' | 'composer';
  parts?: PromptPartWire[];
  overrides?: PromptOverridesWire;
  /** The row's `actor_user_id` is the person who sent it — see
   *  `ContinueSessionCommand.bindTurnIdentity`. Absent on older rows, which
   *  keep the token's identity. */
  bindTurnIdentity?: boolean;
  /** The Kortix session whose agent sent this prompt. Absent when a person
   *  sent it. Set by the server from the caller's credential, never the body. */
  authorSessionId?: string;
  /** Deliver as OpenCode `noReply`: the message joins the transcript and no
   *  turn starts. The first message of a conversation with people. */
  noReply?: boolean;
}
