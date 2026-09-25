/** Session prompt queue: enqueue, list, remove, retry, and hold. */
import { parseSessionAttachmentRef } from '@kortix/shared';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { clearSessionOnBehalfOfForPrompt } from '../lib/on-behalf-of';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../lib/caller-session';
import { AnyObject, projectsApp } from '../lib/app';
import { normalizeString } from '../lib/serializers';
import { isUuid } from '../../shared/validate';
import { readJsonObject } from '../../shared/http-body';
import {
  deleteInboxPrompt,
  drainSessionLifecycleQueue,
  enqueueContinueSessionCommand,
  holdInboxPrompts,
  listInboxPrompts,
  releaseInboxHold,
  retryInboxPrompt,
} from '../session-lifecycle';
import { settleInboxHoldAfterStopInBackground } from '../session-lifecycle/inbox-hold-settle';
import { markTurnStopRequested } from '../sandbox-turn-lifecycle';
import { disarmAllQuickQueueInterrupt, disarmQuickQueueInterrupt } from '../session-lifecycle/runtime-client';
import { cancelForwardedPrompt, findInboxRowIdByMessageId } from '../session-lifecycle/cancel-forwarded';
import {
  INBOX_HOLD_MS,
  holdInboxForRequestedStop,
  holdInboxPrompt,
  isHeldInboxRow,
  isStopPausedInboxRow,
  listPlacedInboxPrompts,
  readInboxPromptPresence,
  sendJoinsHold,
} from '../session-lifecycle/inbox-rows';
import {
  flattenPromptText,
  sanitizeInboxPromptParts,
} from '../session-lifecycle/prompt-parts';
import { PROMPT_FAILURE_CODES } from '../session-lifecycle/types';
import {
  type PromptRow,
  promptState,
  serializePlacedPrompt,
  serializePrompt,
} from '../lib/session-prompt-view';
import { isWireIdAheadOf } from '../wire-message-id';

// ─── Prompt inbox ───────────────────────────────────────────────────────────
//
// THE server-side queue for user prompts. A prompt is a durable row in
// `kortix.session_lifecycle_commands` from the instant the composer accepts it,
// which is the whole point: before this, a prompt typed while the agent was
// busy lived in the browser's localStorage, so closing the tab, switching
// device, or a crash lost it silently, and two tabs on one session each held
// their own idea of the queue.
//
// The client still mints the wire `messageID` and sends it here verbatim.
// OpenCode decides "has this prompt already been answered?" by id ORDER, and
// only the process holding the transcript can place an id correctly — see
// `wire-message-id.ts` for the one exception (redelivery, which re-reads the
// transcript first).
//
// Admission — "may this prompt be delivered NOW?" — is not decided here. It is
// decided at drain time by `admitInboxPrompt`, on the ORDER of this session's
// own rows, because that answer changes between the POST and the delivery. A
// live turn holds later prompts until its terminal event releases the next row.

const PROMPT_WIRE_MESSAGE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;
const PROMPT_LIST_LIMIT = 200;

const SessionPromptSchema = z.object({
  placement: z.enum(['transcript', 'composer']).optional(),
  prompt_id: z.string(),
  client_message_id: z.string(),
  message_id: z.string(),
  wire_message_id: z.string(),
  client_sent_at_ms: z.number().nullable(),
  state: z.enum(['queued', 'delivering', 'waiting', 'failed']),
  reason: z.string().nullable(),
  text: z.string(),
  full_text: z.string().optional(),
  attempts: z.number(),
  last_error: z.string().nullable(),
  failure_code: z
    .string()
    .nullable()
    .optional()
    .openapi({
      description: [
        'Why delivery gave up, as a stable code to map to your own words (`last_error` is prose).',
        '`null` unless `state` is `failed`; a failed prompt written before codes existed reads `unknown`.',
        `One of: ${PROMPT_FAILURE_CODES.map((code) => `\`${code}\``).join(', ')}.`,
        'New codes may be added; treat an unrecognized one as `unknown`.',
      ].join(' '),
    }),
  attachments: z.array(z.object({ filename: z.string(), mime: z.string() })),
  created_at: z.string(),
  available_at: z.string(),
});

/**
 * A row that LEFT the pending list within the last minute, reduced to the ids
 * a client may still hold its optimistic bubble under. Additive — absent from
 * older servers; a client treats a missing list as empty.
 */
const SessionPlacedPromptSchema = z.object({
  prompt_id: z.string(),
  client_message_id: z.string(),
  wire_message_id: z.string().openapi({
    description: 'The wire id the client minted and painted its bubble under.',
  }),
  message_id: z.string().openapi({
    description: 'The id the delivered message carries in the transcript (re-minted by the server).',
  }),
  message_ids: z.array(z.string()).openapi({
    description: 'Every id the server ever delivered this prompt under, `message_id` first.',
  }),
  placed_at: z.string().openapi({ description: 'When the row left the pending list (server clock).' }),
});

/** Everything `POST .../prompts` needs to re-create ONE removed prompt byte for
 *  byte. Not a subset of `SessionPromptSchema`: that one carries a truncated
 *  text PREVIEW and no parts at all, which is a display shape, not a restore
 *  shape. */
const RemovedSessionPromptSchema = z.object({
  placement: z.enum(['transcript', 'composer']).optional(),
  prompt_id: z.string(),
  client_message_id: z.string(),
  removed_message_ids: z.array(z.string()).optional(),
  message_id: z.string(),
  parts: z.array(z.any()),
  overrides: z.any().nullable(),
  held: z.boolean().openapi({
    description:
      'The prompt was held (Stop, or stop-paused). An undo passes it back as `held` with `restore: true`.',
  }),
});

/**
 * The refusal body of a prompt row action (DELETE, retry). `code` is the
 * contract a client maps to one outcome; `error` is English for logs and for
 * clients that predate the codes. A session the caller cannot see answers the
 * plain `{ error: 'Not found' }`, with no prompt code.
 */
const PromptActionErrorSchema = z.object({
  error: z.string(),
  code: z
    .string()
    .optional()
    .openapi({
      description:
        '`prompt_not_found` (404): no such prompt, or already removed. ' +
        '`prompt_already_sent` (409): the prompt was sent, is being answered, or the drain closed it. ' +
        '`prompt_cancel_unreachable` (409, DELETE): the prompt is being delivered and the runtime could not be reached to cancel it.',
    }),
});

const PROMPT_NOT_FOUND = { error: 'Not found', code: 'prompt_not_found' } as const;
const PROMPT_ALREADY_SENT = { error: 'Prompt was already sent', code: 'prompt_already_sent' } as const;
const PROMPT_BEING_ANSWERED = {
  error: 'Prompt is already being answered',
  code: 'prompt_already_sent',
} as const;
const PROMPT_CANCEL_UNREACHABLE = {
  error: 'Prompt is being delivered and the runtime could not be reached to cancel it',
  code: 'prompt_cancel_unreachable',
} as const;

/**
 * How the DELETE cancel arm ends when the cancel did not remove the prompt,
 * decided on the row as it stands NOW. The cancel's own verdict (`answered`,
 * `unreachable`, `not_forwarded`) is only its own view, and a concurrent
 * request can have changed the row under it. So the arm runs the plain delete
 * once more, which re-reads the row when it removes nothing:
 *
 *  - The row fell back into line (a failed claim, or the reaper handed a
 *    forwarded prompt back): it is removed, 200.
 *  - Two removes of one delivering prompt both reach the runtime. The loser's
 *    guarded delete finds nothing and reads `answered`, or its poll finds no
 *    row. Both exits observe a delete that has already committed: the prompt
 *    is gone (404), or the drain closed it (409 already sent).
 *  - Still on the wire: the cancel's own refusal, 409.
 *
 * One attempt only, so a row that keeps moving cannot hold the request open;
 * a row that moves again between those statements gets the cancel's refusal.
 *
 * One exit stays timing-dependent, and it still answers a code the client maps
 * to "already sent", never "unreachable": the winner has taken the runtime copy
 * out but not yet deleted the row, and the loser's tip read finds a later step
 * (`reachedPlacement` with no copy to compare against) and reads `answered`.
 */
async function settleCancelArm(
  sessionId: string,
  promptId: string,
  onWire: { error: string; code: string },
): Promise<{ removed: PromptRow } | { body: { error: string; code: string }; status: 404 | 409 }> {
  const settled = await deleteInboxPrompt(sessionId, promptId);
  if (settled.outcome === 'deleted') return { removed: settled.row };
  if (settled.outcome === 'missing') return { body: PROMPT_NOT_FOUND, status: 404 };
  if (settled.outcome === 'sent') return { body: PROMPT_ALREADY_SENT, status: 409 };
  return { body: onWire, status: 409 };
}

/** `POST .../prompts` body. Only the undo fields are typed here; the handler
 *  checks every other field with its own message. */
const CreateSessionPromptBodySchema = z
  .object({
    restore: z.boolean().optional().openapi({
      description:
        'Undo of a removed prompt. The send does not release the session hold, and changes no other prompt.',
    }),
    held: z.boolean().optional().openapi({
      description:
        'With `restore`: re-create the prompt held (the `held` bit DELETE returned). Ignored without `restore`.',
    }),
  })
  .catchall(z.any());


function serializeRemovedPrompt(row: PromptRow) {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  return {
    placement: payload.placement === 'transcript' ? 'transcript' as const : 'composer' as const,
    prompt_id: row.commandId,
    client_message_id: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : '',
    // The ORIGINAL wire id, never the re-minted one: an undo re-creates the
    // submission, and `POST .../prompts` places it again from there.
    message_id: typeof payload.wireMessageId === 'string' ? payload.wireMessageId : '',
    // EVERY id this prompt ever travelled under, so the client can clear the
    // transcript husk a cancel leaves behind (the copy at the runtime is
    // emptied, not necessarily deleted, while a step runs).
    removed_message_ids: [
      payload.wireMessageId,
      payload.redeliveredMessageId,
      (row.result as Record<string, unknown> | null)?.forwarded_message_id,
    ].filter((id, i, all): id is string => typeof id === 'string' && !!id && all.indexOf(id) === i),
    // The full body, untruncated, with every file/agent part — see the DELETE
    // handler for why the display shape cannot stand in for this.
    parts: parts.length > 0 ? parts : [{ type: 'text', text: payload.text ?? '' }],
    overrides:
      payload.overrides && typeof payload.overrides === 'object' ? payload.overrides : null,
    // The undo re-creates the row with this bit, so Stop → remove → Undo keeps
    // the prompt held instead of resuming the queue.
    held: isHeldInboxRow(row.result) || isStopPausedInboxRow(row.result),
  };
}


projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/prompts',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/prompts',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: CreateSessionPromptBodySchema } }, required: true },
    },
    responses: {
      200: json(z.any(), 'Already queued (same client_message_id)'),
      202: json(z.any(), 'Prompt queued'),
      ...errors(400, 402, 403, 404, 409, 503),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // FLOOR 'session', NOT 'write'. Sending a prompt is running the session,
    // not editing the project — it must pass exactly the check `/start` and
    // `POST /sessions` pass, because those are how the SAME message gets in.
    //
    // It didn't. A built-in project `member` (project.read + project.session.*,
    // no project.write) could open a session and have its first prompt answered
    // — that one rides `POST /sessions`'s `pending_prompt` stash, gated
    // 'session' — and then got 403 "Your role on this project doesn't let you
    // change this project" on EVERY follow-up, which lands here. Two gates for
    // one action: allowed to start the conversation, refused to continue it.
    //
    // The real authorization is the pair below (project.session.start, per-agent
    // + per-capability). This coarse floor only ever added a second, stricter,
    // contradictory tier on top. Same reasoning for delete/retry/hold below:
    // they manage the queue of a session the caller is already allowed to run.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // Same per-agent gate as `/start`: a prompt is what spends the compute a
    // session start provisions.
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );

    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // `deleteSession()` stamps metadata.deletedAt and leaves the row 'stopped'.
    // Accepting a prompt for it would revive a session the user removed.
    const metadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.deletedAt === 'string') {
      return c.json({ error: 'Session is deleted' }, 409);
    }

    const body = await readJsonObject(c);
    const clientMessageId = normalizeString(body.client_message_id);
    const messageId = normalizeString(body.message_id);
    if (body.placement !== undefined && body.placement !== 'transcript' && body.placement !== 'composer') {
      return c.json({ error: 'placement must be transcript or composer' }, 400);
    }
    const rawParts = Array.isArray(body.parts) ? body.parts : [];
    if (!clientMessageId || clientMessageId.length > 128) {
      return c.json({ error: 'client_message_id is required (1..128 chars)' }, 400);
    }
    if (!messageId || !PROMPT_WIRE_MESSAGE_ID.test(messageId)) {
      // Rejected rather than repaired: an id this endpoint cannot verify the
      // ordering of is one OpenCode may read as already answered, and a
      // dropped turn is worse than a refused request.
      return c.json({ error: 'message_id must be an OpenCode wire message id' }, 400);
    }
    const sanitized = sanitizeInboxPromptParts(rawParts);
    if ('error' in sanitized) return c.json({ error: sanitized.error }, 400);
    const parts = sanitized.parts;
    for (const part of parts) {
      const attachment = parseSessionAttachmentRef(part.url);
      if (attachment && (attachment.projectId !== projectId || attachment.sessionId !== sessionId)) {
        return c.json({ error: 'Attachment belongs to another session' }, 400);
      }
    }
    const text = flattenPromptText(parts);

    const overridesInput = (body.overrides ?? {}) as Record<string, unknown>;
    const model = overridesInput.model as { providerID?: unknown; modelID?: unknown } | null;
    const overrides = {
      agent: typeof overridesInput.agent === 'string' ? overridesInput.agent : null,
      model:
        model && typeof model.providerID === 'string' && typeof model.modelID === 'string'
          ? { providerID: model.providerID, modelID: model.modelID }
          : null,
      variant: typeof overridesInput.variant === 'string' ? overridesInput.variant : null,
      directory: typeof overridesInput.directory === 'string' ? overridesInput.directory : null,
    };

    // Every prompt re-asks, because a prompt is what spends the money and a
    // prompt can SWITCH agent mid-session via `overrides.agent`. Checking only
    // at create would let a member send the first message as their granted
    // agent and every one after it as any other agent in the manifest. Falls
    // back to the session's own agent when the prompt names none.
    await resolveAndAuthorizeAgent(c, loaded, projectId, overrides.agent, visible.row.agentName);

    // Spec 2026-09-22 §2.3 (closes V6): the first prompt from a HUMAN other than
    // the session's `on_behalf_of` clears it permanently. The agent keeps its
    // own authority; it loses the creator's personal resources, so the person
    // prompting never acts through another person's accounts. An agent-session
    // credential is not a human prompter and clears nothing.
    if (!isProjectSessionPrincipal(c)) {
      await clearSessionOnBehalfOfForPrompt({
        accountId: loaded.row.accountId,
        sessionId,
        prompterUserId: loaded.userId,
      });
    }

    // NO connector pre-flight here. A prompt used to be refused 409
    // `CONNECTOR_CONNECTION_REQUIRED` when a connector the session declared had
    // nothing connected. That gate could not be cleared from the product: a
    // `user`-strategy connector has no project account to offer, so the web
    // card had no button, and the warm-session path swallowed the 409 and left
    // the composer on "Thinking" forever.
    //
    // The connector CALL denies instead (`connector_not_connected`), naming the
    // connector and carrying a connect link. The turn runs, the agent reports
    // what is missing, and the human fixes it in one click.

    // Same gate as start/wake: a prompt spends compute.
    const billing = await checkBillingAdmission(loaded.row.accountId);
    if (!billing.ok) {
      return c.json(
        {
          error: billing.message,
          message: billing.message,
          code: billing.reason,
          balance: billing.balance,
          billing_model: billing.billingModel,
          has_subscription: billing.hasSubscription,
          billing_state: billing.billingState,
          account_id: loaded.row.accountId,
        },
        402,
      );
    }

    // An UNDO of a removed prompt. The row was hard-deleted, so the undo is a
    // fresh POST under the same client id — and a fresh send releases the
    // session's hold, which made Stop → remove → Undo resume the whole queue.
    // A restore puts back ONE row, with the held bit its DELETE returned, and
    // changes no other row.
    const restore = body.restore === true;
    const restoreHeld = restore && body.held === true;
    const clientSentAtMs =
      typeof body.client_sent_at_ms === 'number' && Math.abs(Date.now() - body.client_sent_at_ms) < 10 * 60_000
        ? Math.trunc(body.client_sent_at_ms)
        : null;

    // The unique index on `idempotency_key` IS the "retry = same
    // clientMessageId = same row" contract — enforced by the database, not by a
    // cache that a second pod would not share.
    const idempotencyKey = `prompt:${sessionId}:${clientMessageId}`;
    const enqueued = await enqueueContinueSessionCommand({
      source: 'ui',
      projectId,
      accountId: loaded.row.accountId,
      sessionId,
      actorUserId: loaded.userId,
      text,
      idempotencyKey,
      clientMessageId,
      wireMessageId: messageId,
      ...(body.placement ? { placement: body.placement } : {}),
      // OPT-IN, and only one producer sets it: the localStorage migration,
      // whose id is minted at page load — against a transcript this tab has
      // not read yet — for a message the user typed before their last reload.
      // The drain re-mints against the live root before delivering, which is
      // the only place that can place the id correctly.
      //
      // A second trigger, set by the server: an id more than an hour AHEAD of
      // the clock. No transcript placed it — `kortix sessions send` minted the
      // HIGH bits of the id clock (`msg_1a0d…`, ~40 days out) until 2026-09 —
      // and delivered as-is it renders every later turn above this prompt.
      // Accepted rather than refused, so every installed CLI keeps working.
      ...(body.remint_on_delivery === true || isWireIdAheadOf(messageId, Date.now())
        ? { remintOnDelivery: true }
        : {}),
      // SEND order across surfaces whose POSTs race — see the batch sort in
      // the drain. Bounded to the near past/future so a wrong client clock
      // cannot pin its prompts to the head or tail of every future batch.
      ...(clientSentAtMs !== null ? { clientSentAtMs } : {}),
      parts,
      overrides,
      // A held restore is inserted NOT DUE, at the hold horizon, so the
      // scheduler cannot claim it before `holdInboxPrompt` below marks it.
      ...(restoreHeld ? { availableAt: new Date(Date.now() + INBOX_HOLD_MS) } : {}),
    });

    const stored = (enqueued.row.payload ?? {}) as Record<string, unknown>;
    const respond = (status: ReturnType<typeof promptState>) => ({
      prompt_id: enqueued.row.commandId,
      state: status.state,
      // WHY the row is not in line, on the acceptance itself — the same field
      // the list read carries. `held` is the one a client must have here: an
      // Undo after Stop restores a held row, and a client that learns its
      // held-ness one read later counts it as work in flight for that round
      // trip — composer back on Stop for a queue nothing will run.
      reason: status.reason,
      message_id:
        typeof stored.redeliveredMessageId === 'string'
          ? stored.redeliveredMessageId
          : typeof stored.wireMessageId === 'string'
            ? stored.wireMessageId
            : messageId,
      deduped: enqueued.deduped,
      // The write's place on the SERVER clock — stamped after the writes
      // settled. Clients rank queue snapshots on this one clock, so a read
      // issued before this POST carries an older stamp and can never erase
      // the row it confirmed (JAY-728).
      observed_at: new Date().toISOString(),
    });
    // A dedupe answers before either hold decision: this call wrote nothing.
    if (enqueued.deduped) return c.json(respond(promptState(enqueued.row)), 200);

    // A SEND TYPED BEFORE THE STOP whose POST lands after it belongs to the
    // queue the Stop paused. The browser dispatches queued sends one after
    // another, so the second and third of three Queue List rows reached the
    // server after the hold — and each one released it, delivering the head
    // row the moment the Stop ended the turn (measured 2026-09-23). Read after
    // the insert, so a hold that lands between the two is still seen.
    const joinsHold = !restore && (await sendJoinsHold(sessionId, clientSentAtMs));

    if (restoreHeld || joinsHold) {
      // A held restore is two statements: the insert above, then the held
      // marker. A row whose marker failed is neither held (a release does not
      // free it) nor due (nothing delivers it), and every later prompt of the
      // session waits behind it. A retried undo dedupes onto that row before
      // this branch, so the hold would never be written. The failure therefore
      // takes the row back out and reaches the caller, and a retry inserts it
      // again. `deleteInboxPrompt` removes only a row still in line: a row a
      // sibling sweep already claimed stays. If that delete fails too, the row
      // stays as it was, and DELETE or retry still act on it.
      let held: boolean;
      try {
        held = await holdInboxPrompt(sessionId, enqueued.row.commandId);
      } catch (error) {
        await deleteInboxPrompt(sessionId, enqueued.row.commandId).catch(() => undefined);
        throw error;
      }
      // A held row is not due, so no drain is kicked for it.
      return c.json(
        respond(held ? { state: 'waiting', reason: 'held' } : promptState(enqueued.row)),
        202,
      );
    }

    // Sending anything NEW lifts a hold the stop button left on this session's
    // queue — the same rule the browser-local queue always had, and the reason
    // stop cannot wedge a session: everything typed afterwards would otherwise
    // land behind rows that are, by construction, never due. A restore is not
    // a new send: the rest of a held queue stays held.
    if (!restore) await releaseInboxHold(sessionId).catch(() => undefined);
    const response = respond(promptState(enqueued.row));

    // Fire the targeted drain WITHOUT waiting on it: the response is "your
    // prompt is durable", not "your prompt has been delivered". The drain
    // claims by idempotency key so this row does not wait behind older work.
    void drainSessionLifecycleQueue({ idempotencyKey }).catch(() => undefined);
    return c.json(response, 202);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/prompts',
    tags: ['sessions'],
    summary: 'GET /:projectId/sessions/:sessionId/prompts',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(
        z.object({
          prompts: z.array(SessionPromptSchema),
          observed_at: z.string(),
          placed: z.array(SessionPlacedPromptSchema).openapi({
            description: [
              'Pairings of prompts that left `prompts` within the last ten minutes and were delivered under an id other than their `wire_message_id`.',
              'A client that painted a prompt under its wire id retires that bubble by the pairing, even when it never saw the row re-minted.',
            ].join(' '),
          }),
        }),
        'Pending prompts',
      ),
      ...errors(400, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // Captured BEFORE the read: an answer is only as fresh as the moment it
    // was asked. Clients rank queue snapshots on this server clock (JAY-728).
    const observedAt = new Date().toISOString();
    // Scoped to INBOX rows — see `listInboxPrompts`. `continue_session` is also
    // how triggers, Slack and approval-resume deliver, and listing those put an
    // automation's internal prompt in the user's own queue.
    // TWO reads, one snapshot: the rows still pending, and the rows that just
    // LEFT — the pairing a client needs outlives the row (a steer is confirmed
    // `delivered` at acceptance, often inside one 1 s poll of its re-mint).
    // See `listPlacedInboxPrompts`. A failure of the second read must not
    // cost the queue: it degrades to no pairings, never to a 500.
    const [rows, placedRows] = await Promise.all([
      listInboxPrompts(sessionId, PROMPT_LIST_LIMIT),
      listPlacedInboxPrompts(sessionId).catch((err: unknown) => {
        console.warn('[session-prompts] placed read failed — serving no pairings', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as PromptRow[];
      }),
    ]);

    return c.json({
      prompts: rows.map(serializePrompt),
      observed_at: observedAt,
      placed: placedRows.map(serializePlacedPrompt).filter((pairing) => pairing !== null),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}',
    tags: ['sessions'],
    summary: 'DELETE /:projectId/sessions/:sessionId/prompts/:promptId',
    ...auth,
    request: {
      params: z.object({
        projectId: z.string(),
        sessionId: z.string(),
        promptId: z.string(),
      }),
    },
    responses: {
      200: json(z.object({ removed: RemovedSessionPromptSchema }), 'Deleted'),
      ...errors(400),
      404: json(PromptActionErrorSchema, 'No such prompt (`prompt_not_found`), or no such session'),
      409: json(
        PromptActionErrorSchema,
        'The prompt was already sent (`prompt_already_sent`), or could not be cancelled (`prompt_cancel_unreachable`)',
      ),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const promptId = c.req.param('promptId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
    // A prompt is named by its row id (uuid) OR by its wire message id — the
    // handle the bubble still has after the row leaves the list.
    if (!isUuid(promptId) && !/^msg_[A-Za-z0-9]{6,40}$/.test(promptId)) {
      return c.json({ error: 'Invalid prompt id' }, 400);
    }

    // Floor 'session' — see the POST /prompts gate comment. Un-queuing your own
    // pending message is running the session, not editing the project.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // The session AND inbox scopes are in the DELETE's own predicate, so
    // neither a prompt id from another session nor an automation's
    // `continue_session` row can be removed by naming it here.
    //
    // A `msg_…` id names the prompt by its MESSAGE instead: the row leaves
    // `GET .../prompts` the moment the daemon confirms persistence (~1 s),
    // but the bubble on screen still knows its wire id — and the prompt is
    // still cancellable until a model step reads it.
    let effectivePromptId = promptId;
    if (promptId.startsWith('msg_')) {
      const found = await findInboxRowIdByMessageId(sessionId, promptId);
      if (!found) return c.json(PROMPT_NOT_FOUND, 404);
      effectivePromptId = found;
    }
    const outcome = await deleteInboxPrompt(sessionId, effectivePromptId);
    // The response CARRIES THE PROMPT IT REMOVED. A removal is offered with an
    // undo, and the row is hard-deleted, so this response is the only place the
    // full body still exists. Undoing from `GET /prompts`'s view instead
    // restores a 2000-char preview with no attachments and no model override —
    // a silent, unannounced loss on a button labelled "Undo".
    if (outcome.outcome === 'deleted') {
      await disarmQuickQueueInterrupt(sessionId, loaded.userId, effectivePromptId);
      return c.json({ removed: serializeRemovedPrompt(outcome.row) }, 200);
    }
    if (outcome.outcome === 'delivering') {
      // `delivering` here means the drain has COMMITTED the POST (or the row
      // is already forwarded): a claimed row it had not yet sent was deleted
      // above, and the drain's commit then refused it (`commitInboxPost`).
      //
      // On the wire is no longer the point of no return: a forwarded prompt
      // the loop has not READ is taken back out of the runtime — whole
      // message when idle, part by part when busy (an empty user message is
      // invisible to the model, and the turn-end relay deletes it once the
      // loop is idle — `husk-cleanup.ts`). Only "a step is answering it"
      // still refuses.
      const cancelled = await cancelForwardedPrompt(sessionId, effectivePromptId);
      if (cancelled.outcome === 'cancelled') {
        await disarmQuickQueueInterrupt(sessionId, loaded.userId, effectivePromptId);
        return c.json({ removed: serializeRemovedPrompt(cancelled.row) }, 200);
      }
      // Not removed by the cancel. A row that fell back into the queue while
      // the cancel watched it is removed here; see `settleCancelArm`.
      const settled = await settleCancelArm(
        sessionId,
        effectivePromptId,
        cancelled.outcome === 'answered' ? PROMPT_BEING_ANSWERED : PROMPT_CANCEL_UNREACHABLE,
      );
      if ('removed' in settled) {
        await disarmQuickQueueInterrupt(sessionId, loaded.userId, effectivePromptId);
        return c.json({ removed: serializeRemovedPrompt(settled.removed) }, 200);
      }
      return c.json(settled.body, settled.status);
    }
    if (outcome.outcome === 'sent') return c.json(PROMPT_ALREADY_SENT, 409);
    return c.json(PROMPT_NOT_FOUND, 404);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}/retry',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/prompts/:promptId/retry',
    ...auth,
    request: {
      params: z.object({
        projectId: z.string(),
        sessionId: z.string(),
        promptId: z.string(),
      }),
    },
    responses: {
      200: json(
        SessionPromptSchema.extend({
          observed_at: z.string().openapi({
            description:
              'Server clock after the retry was written. A list read stamped earlier cannot repaint the row `failed`.',
          }),
        }),
        'Prompt re-queued',
      ),
      ...errors(400),
      404: json(PromptActionErrorSchema, 'No such prompt (`prompt_not_found`), or no such session'),
      409: json(PromptActionErrorSchema, 'The prompt is not retryable: it was already sent (`prompt_already_sent`)'),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    const promptId = c.req.param('promptId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
    if (!isUuid(promptId)) return c.json({ error: 'Invalid prompt id' }, 400);

    // Floor 'session' — see the POST /prompts gate comment. "Retry"/"send now"
    // on your own queued message is running the session, not editing the project.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    // ONE primitive for "retry" and for "send now": both are the user pointing
    // at a row and asking for THAT message. `retryInboxPrompt` promotes it past
    // the ordering gate and releases the session's hold. The row keeps the id
    // the client painted under (`wire_message_id`), but `remintOnDelivery`
    // makes the delivery re-read the transcript and place the id again. A
    // duplicate is absorbed by that read and by the proxy's `Idempotency-Key`
    // claim, not by the id — see `retryInboxPrompt`.
    let requeued = await retryInboxPrompt(sessionId, promptId);
    if (!requeued) {
      // Name WHY nothing was re-queued. A row that is gone and a row that
      // already went out are different outcomes to the user.
      const presence = await readInboxPromptPresence(sessionId, promptId);
      if (presence === 'absent') return c.json(PROMPT_NOT_FOUND, 404);
      // `queued`: a failed claim put the row back in line between the update
      // and the read. It never went out, so it is retried once more. One
      // attempt only: a row that moves again answers 409, and the next retry
      // re-queues it.
      if (presence === 'queued') requeued = await retryInboxPrompt(sessionId, promptId);
      if (!requeued) return c.json(PROMPT_ALREADY_SENT, 409);
    }
    // After the write, the same convention as `POST .../prompts`: a list read
    // issued before this retry carries an older stamp.
    const observedAt = new Date().toISOString();

    void drainSessionLifecycleQueue(
      requeued.idempotencyKey ? { idempotencyKey: requeued.idempotencyKey } : { limit: 1 },
    ).catch(() => undefined);
    return c.json({ ...serializePrompt(requeued), observed_at: observedAt }, 200);
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/sessions/{sessionId}/prompts/hold',
    tags: ['sessions'],
    summary: 'POST /:projectId/sessions/:sessionId/prompts/hold',
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } }, required: true },
    },
    responses: {
      200: json(
        z.object({ prompts: z.array(SessionPromptSchema), observed_at: z.string() }),
        'Hold applied',
      ),
      ...errors(400, 404),
    },
  }),
  // STOP HAS TO REACH THE QUEUE.
  //
  // "Stopping means stop doing things, and that includes the queue" was a
  // browser-local pause while the queue was browser-local. The queue is in
  // Postgres now, so the pause has to be too: pausing a client drain leaves the
  // admission gate free to deliver, roughly one scheduler tick after the abort
  // clears turn authority — exactly the message the user pressed Stop to get
  // ahead of. A hold is released by an action (any new send, or "send now" on a
  // row), never by a timer.
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    // Floor 'session' — see the POST /prompts gate comment. Stop/hold is the
    // counterpart of send; a member who can send must be able to hold.
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);

    const body = await readJsonObject(c);
    if (typeof body.held !== 'boolean') {
      return c.json({ error: 'held must be a boolean' }, 400);
    }

    // A HOLD IS A STOP SOMEBODY ASKED FOR. Stamp it on the open turn before
    // anything this Stop sends can reach OpenCode. The hold is the Stop's FIRST
    // request, and its settle (below) can abort the box before the client's
    // own abort leaves the browser. That settle abort does not pass the
    // sandbox proxy that stamps `UserStop`, so without this stamp the turn
    // closed on a bare "Aborted" frame and the user's own Stop read as
    // "stopped before it finished" (prod 2026-09-25). The ledger keeps the
    // stamp only over an abort: a turn that completes drops it, and a named
    // cause replaces it. Scoped to the session's root OpenCode session, like
    // the proxy stamp. The write never throws.
    if (body.held) {
      await markTurnStopRequested(sessionId, 'UserStop', {
        opencodeSessionId: visible.row.opencodeSessionId ?? null,
      });
      // The Stop instant on the CLIENT's clock, beside the server's: every send
      // carries its Enter instant on that same clock, so a prompt typed before
      // this Stop whose POST lands after it joins the hold instead of lifting
      // it (`sendJoinsHold`). Bounded like `client_sent_at_ms`.
      const stoppedAtMs =
        typeof body.stopped_at_ms === 'number' && Math.abs(Date.now() - body.stopped_at_ms) < 10 * 60_000
          ? body.stopped_at_ms
          : null;
      await holdInboxForRequestedStop(sessionId, { clientStoppedAtMs: stoppedAtMs });
      await disarmAllQuickQueueInterrupt(sessionId, loaded.userId);
    } else {
      await holdInboxPrompts(sessionId, false);
    }
    // After the write, before the read-back — either instant orders this
    // snapshot correctly against the hold it just applied (JAY-728).
    const observedAt = new Date().toISOString();
    const rows = await listInboxPrompts(sessionId, PROMPT_LIST_LIMIT);
    if (body.held) {
      // The instant marking above is what the client waits for; what a Stop
      // means for prompts already on the wire needs the box and happens behind
      // this response — see inbox-hold-settle.ts.
      settleInboxHoldAfterStopInBackground(sessionId);
    } else {
      void drainSessionLifecycleQueue({ limit: 1 }).catch(() => undefined);
    }
    return c.json({ prompts: rows.map(serializePrompt), observed_at: observedAt });
  },
);
