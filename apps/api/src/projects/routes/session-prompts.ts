/** Session prompt queue: enqueue, list, remove, retry, and hold. */
import { parseSessionAttachmentRef } from '@kortix/shared';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { auth, errors, json, lenientBody } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession } from '../lib/access';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { promptModelOverride } from '../lib/prompt-model';
import { assertAgentScope, isProjectSessionPrincipal } from '../../iam/agent-scope';
import { PROJECT_ACTIONS } from '../../iam';
import { callerKortixSessionId } from '../lib/caller-session';
import {
  CreateSessionPromptResultSchema,
  SessionPromptListSchema,
  SessionPromptSchema,
  projectsApp,
} from '../lib/app';
import { currentInstanceId, sandboxBelongsToThisInstance, sandboxInstanceId } from '../instance-scope';
import { loadSandboxMetadataForSessions } from '../session-lifecycle/instance-release';
import { normalizeString } from '../lib/serializers';
import { isUuid } from '../../lib/validate';
import { readJsonObject } from '../../lib/http-body';
import {
  deleteInboxPrompt,
  editInboxPrompt,
  drainSessionLifecycleQueue,
  enqueueContinueSessionCommand,
  enqueueReleasingHold,
  holdInboxPrompts,
  inboxSendState,
  listInboxPrompts,
  retryInboxPrompt,
} from '../session-lifecycle';
import { settleInboxHoldAfterStopInBackground } from '../session-lifecycle/inbox-hold-settle';
import { markTurnStopRequested } from '../session-turn-ledger';
import { disarmAllQuickQueueInterrupt, disarmQuickQueueInterrupt } from '../session-lifecycle/runtime-client';
import { cancelForwardedPrompt, findInboxRowIdByMessageId } from '../session-lifecycle/cancel-forwarded';
import {
  flattenPromptText,
  sanitizeInboxPromptParts,
} from '../session-lifecycle/prompt-parts';
import {
  type PromptRow,
  promptState,
  serializePrompt,
} from '../lib/session-prompt-view';
import { WIRE_MESSAGE_ID, isWireIdAheadOf } from '../wire-message-id';

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

const PROMPT_LIST_LIMIT = 200;
/** A POST that arrives within this long of its Enter did not wait on the
 *  client. Longer, and an older send of the same burst may still be in flight. */
const LONE_SEND_MAX_AGE_MS = 1_000;

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
});


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
  };
}
export function registerSessionPromptsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/prompts',
      tags: ['sessions'],
      summary: 'Send a prompt (message) to a session',
      description:
        'Send a message to a session. The prompt queues and delivers in order.',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            client_message_id: z.string().openapi({ description: 'Caller-chosen id, 1-128 chars, unique per prompt. Reuse it to retry safely.' }),
            message_id: z.string().openapi({ description: 'OpenCode wire message id (starts with msg_). Must sort after earlier messages of the session.' }),
            parts: z.array(z.object({ type: z.enum(['text', 'file', 'agent']).optional(), text: z.string().optional(), mime: z.string().optional(), url: z.string().optional(), filename: z.string().optional(), attachment_id: z.string().optional() }).passthrough()).openapi({ description: '1 or more parts. Text prompt: [{"type":"text","text":"..."}].' }),
            placement: z.enum(['transcript', 'composer']).optional().openapi({ description: 'transcript sends now; composer stages it as a draft.' }),
            overrides: z.object({ agent: z.string().optional(), model: z.object({ providerID: z.string(), modelID: z.string() }).optional(), variant: z.string().optional(), directory: z.string().optional() }).passthrough().optional().optional().openapi({ description: 'Per-prompt agent or model override.' }),
            remint_on_delivery: z.boolean().optional().openapi({ description: 'Assign a fresh wire id when the prompt is delivered.' }),
            client_sent_at_ms: z.number().optional().openapi({ description: 'Client send time, epoch milliseconds.' }),
          }) } }, required: true },
      },
      responses: {
        200: json(CreateSessionPromptResultSchema, 'Already queued (same client_message_id)'),
        202: json(CreateSessionPromptResultSchema, 'Prompt queued'),
        ...errors(400, 402, 403, 404, 409, 503),
      },
    }),
    async (c) => {
      const receivedAtMs = Date.now();
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

      // The session whose agent sends this, when it is not the target itself.
      // From the credential, never the body: it becomes the message's author.
      const callerSessionId = callerKortixSessionId(c);
      const authorSessionId =
        isProjectSessionPrincipal(c) && callerSessionId && callerSessionId !== sessionId ? callerSessionId : null;
      // The reads below use the session id alone and none consumes another's
      // result. They start together and are awaited in the original order, so
      // every refusal comes from the same place. They ran one after another: one
      // database round trip each, before the prompt was even durable.
      const visibleRead = loadVisibleSession(loaded, sessionId, callerSessionId, callerSessionId);
      // A failed read is "no hold" (as before) and "may be a burst" (the safe side).
      const sendState = inboxSendState(sessionId).catch(() => ({ held: false, pending: true }));
      const thisInstance = currentInstanceId();
      const boxRead = thisInstance ? loadSandboxMetadataForSessions([sessionId]) : null;
      boxRead?.catch(() => undefined);
      const visible = await visibleRead;
      if (!visible) return c.json({ error: 'Not found' }, 404);
      // `deleteSession()` stamps metadata.deletedAt and leaves the row 'stopped'.
      // Accepting a prompt for it would revive a session the user removed.
      const metadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.deletedAt === 'string') {
        return c.json({ error: 'Session is deleted' }, 409);
      }
      // Shared local DB (projects/instance-scope.ts). The drain never claims a
      // command for a sandbox another API instance provisioned, so a prompt
      // accepted here would stay `queued` for ever when that instance is down.
      // Refuse it while the sender can still read why. The lookup runs only when
      // `KORTIX_INSTANCE_ID` is set.
      if (thisInstance && boxRead) {
        const box = (await boxRead).get(sessionId);
        if (box !== undefined && !sandboxBelongsToThisInstance(box)) {
          const owner = sandboxInstanceId(box);
          const message =
            `This session's computer belongs to the local API instance "${owner}". ` +
            `This instance ("${thisInstance}") cannot deliver prompts to it. ` +
            'Send from that stack, or start a new session.';
          return c.json(
            { error: message, message, code: 'SESSION_OWNED_BY_OTHER_INSTANCE', owner_instance: owner },
            409,
          );
        }
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
      if (!messageId || !WIRE_MESSAGE_ID.test(messageId)) {
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
      // A RE-POINTED pin travels ON THE PROMPT: OpenCode keeps its own
      // per-session model, and `KORTIX_OPENCODE_MODEL` only seeds the default for
      // a NEW OpenCode session. See `lib/prompt-model.ts` for the measurement.
      const overrides = {
        agent: typeof overridesInput.agent === 'string' ? overridesInput.agent : null,
        model: promptModelOverride(model, visible.row.metadata as Record<string, unknown> | null),
        variant: typeof overridesInput.variant === 'string' ? overridesInput.variant : null,
        directory: typeof overridesInput.directory === 'string' ? overridesInput.directory : null,
      };

      // Every prompt re-asks, because a prompt is what spends the money and a
      // prompt can SWITCH agent mid-session via `overrides.agent`. Checking only
      // at create would let a member send the first message as their granted
      // agent and every one after it as any other agent in the manifest. Falls
      // back to the session's own agent when the prompt names none.
      await resolveAndAuthorizeAgent(c, loaded, projectId, overrides.agent, visible.row.agentName);

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

      // The unique index on `idempotency_key` IS the "retry = same
      // clientMessageId = same row" contract — enforced by the database, not by a
      // cache that a second pod would not share.
      const idempotencyKey = `prompt:${sessionId}:${clientMessageId}`;
      // Sending anything NEW lifts a hold the stop button left on this session's
      // queue — the same rule the browser-local queue always had, and the reason
      // stop cannot wedge a session: everything typed afterwards would otherwise
      // land behind rows that are, by construction, never due. The send joins
      // the released batch; `enqueueReleasingHold` enqueues it held and releases
      // them together, so no drain can claim it alone in between (KRTX-683).
      const send: Parameters<typeof enqueueContinueSessionCommand>[0] = {
        source: 'ui',
        projectId,
        accountId: loaded.row.accountId,
        sessionId,
        actorUserId: loaded.userId,
        // Spec 2026-09-22 §2.3 (closes V6): the session token acts as the person
        // who sent this prompt, from the moment its turn is delivered — not now,
        // while it may still wait behind another member's turn. An agent-session
        // credential is not a person and never changes the token's identity.
        bindTurnIdentity: !isProjectSessionPrincipal(c),
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
        ...(typeof body.client_sent_at_ms === 'number' &&
        Math.abs(Date.now() - body.client_sent_at_ms) < 10 * 60_000
          ? { clientSentAtMs: Math.trunc(body.client_sent_at_ms) }
          : {}),
        parts,
        overrides,
        authorSessionId,
      };
      const enqueued = await enqueueReleasingHold(
        sessionId,
        (hold) => enqueueContinueSessionCommand({ ...send, ...hold }),
        undefined,
        sendState.then((state) => state.held),
      );

      const stored = (enqueued.row.payload ?? {}) as Record<string, unknown>;
      const response = {
        prompt_id: enqueued.row.commandId,
        state: promptState(enqueued.row).state,
        message_id:
          typeof stored.redeliveredMessageId === 'string'
            ? stored.redeliveredMessageId
            : typeof stored.wireMessageId === 'string'
              ? stored.wireMessageId
              : messageId,
        deduped: enqueued.deduped,
        // The write's place on the SERVER clock — stamped after the enqueue
        // settled. Clients rank queue snapshots on this one clock, so a read
        // issued before this POST carries an older stamp and can never erase
        // the row it confirmed (JAY-728).
        observed_at: new Date().toISOString(),
      };
      if (enqueued.deduped) return c.json(response, 200);

      // Fire the targeted drain WITHOUT waiting on it: the response is "your
      // prompt is durable", not "your prompt has been delivered". The drain
      // claims by idempotency key so this row does not wait behind older work.
      //
      // A LONE send is claimed at once. The drain's burst wait (250 ms, see
      // `drainSessionLifecycleQueue`) exists for sends whose POSTs race, and ran
      // on every prompt. It is kept where a race is possible: another prompt of
      // this session is queued or in delivery, or this POST waited after Enter
      // (uploads, an offline queue, a slow link), so an older send may still be
      // on its way. A caller that sends no `client_sent_at_ms` keeps the wait.
      const burst =
        (await sendState).pending ||
        typeof body.client_sent_at_ms !== 'number' ||
        receivedAtMs - body.client_sent_at_ms > LONE_SEND_MAX_AGE_MS;
      void drainSessionLifecycleQueue({ idempotencyKey, burst }).catch(() => undefined);
      return c.json(response, 202);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/sessions/{sessionId}/prompts',
      tags: ['sessions'],
      summary: 'List queued prompts of a session',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
      },
      responses: {
        200: json(SessionPromptListSchema, 'Pending prompts'),
        ...errors(400, 404),
      },
    }),
    async (c) => {
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
      const rows = await listInboxPrompts(sessionId, PROMPT_LIST_LIMIT);

      return c.json({ prompts: rows.map(serializePrompt), observed_at: observedAt });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}',
      tags: ['sessions'],
      summary: 'Cancel a queued prompt',
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
        ...errors(400, 404, 409),
      },
    }),
    async (c) => {
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
        if (!found) return c.json({ error: 'Not found' }, 404);
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
        // On the wire is no longer the point of no return: a forwarded prompt
        // the loop has not READ is taken back out of the runtime — whole
        // message when idle, part by part when busy (an empty user message is
        // invisible to the model). Only "a step is answering it" still refuses.
        const cancelled = await cancelForwardedPrompt(sessionId, effectivePromptId);
        if (cancelled.outcome === 'cancelled') {
          await disarmQuickQueueInterrupt(sessionId, loaded.userId, effectivePromptId);
          return c.json({ removed: serializeRemovedPrompt(cancelled.row) }, 200);
        }
        if (cancelled.outcome === 'not_forwarded') {
          // The row fell back into the queue while the cancel watched it.
          const retried = await deleteInboxPrompt(sessionId, effectivePromptId);
          if (retried.outcome === 'deleted') {
            await disarmQuickQueueInterrupt(sessionId, loaded.userId, effectivePromptId);
            return c.json({ removed: serializeRemovedPrompt(retried.row) }, 200);
          }
        }
        return c.json(
          {
            error:
              cancelled.outcome === 'answered'
                ? 'Prompt is already being answered'
                : 'Prompt is being delivered and the runtime could not be reached to cancel it',
          },
          409,
        );
      }
      return c.json({ error: 'Not found' }, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}',
      tags: ['sessions'],
      summary: 'Edit a queued prompt',
      description:
        'Replace the text of a prompt still waiting in the queue. The prompt keeps its place, its files and any hold, and is not sent.',
      ...auth,
      request: {
        params: z.object({
          projectId: z.string(),
          sessionId: z.string(),
          promptId: z.string(),
        }),
        body: { content: { 'application/json': { schema: lenientBody({
            text: z.string().openapi({ description: 'The new text of the prompt.' }),
          }) } }, required: true },
      },
      responses: {
        200: json(SessionPromptSchema, 'Prompt edited'),
        ...errors(400, 404, 409),
      },
    }),
    async (c) => {
      const projectId = c.req.param('projectId');
      const sessionId = c.req.param('sessionId');
      const promptId = c.req.param('promptId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      if (!isUuid(promptId)) return c.json({ error: 'Invalid prompt id' }, 400);

      // Floor 'session' — see the POST /prompts gate comment. Editing your own
      // queued message is running the session, not editing the project.
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
      // The same limits a sent text part meets.
      const sanitized = sanitizeInboxPromptParts([{ type: 'text', text: body.text }]);
      if ('error' in sanitized) return c.json({ error: sanitized.error }, 400);
      const text = flattenPromptText(sanitized.parts);
      if (!text.trim()) return c.json({ error: 'text is required' }, 400);

      // No drain kick and no hold release: an edit changes a waiting message,
      // it does not send one. `POST /prompts` would do both.
      const outcome = await editInboxPrompt(sessionId, promptId, text);
      if (outcome.outcome === 'edited') return c.json(serializePrompt(outcome.row), 200);
      if (outcome.outcome === 'delivering') {
        return c.json({ error: 'Prompt is already with the agent' }, 409);
      }
      return c.json({ error: 'Not found' }, 404);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/prompts/{promptId}/retry',
      tags: ['sessions'],
      summary: 'Retry a failed prompt',
      ...auth,
      request: {
        params: z.object({
          projectId: z.string(),
          sessionId: z.string(),
          promptId: z.string(),
        }),
      },
      responses: {
        200: json(SessionPromptSchema, 'Prompt re-queued'),
        ...errors(400, 404),
      },
    }),
    async (c) => {
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
      // the ordering gate and releases the session's hold, and the drain re-mints
      // its wire id. When the release frees OTHER held rows, "send now" is a
      // Stop release: the row joins that batch, is NOT promoted, and the batch is
      // answered in one turn in queue order (KRTX-683).
      const requeued = await retryInboxPrompt(sessionId, promptId);
      if (!requeued) return c.json({ error: 'Not found' }, 404);

      void drainSessionLifecycleQueue(
        requeued.idempotencyKey ? { idempotencyKey: requeued.idempotencyKey } : { limit: 1 },
      ).catch(() => undefined);
      return c.json(serializePrompt(requeued), 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/sessions/{sessionId}/prompts/hold',
      tags: ['sessions'],
      summary: 'Hold or release the prompt queue of a session',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), sessionId: z.string() }),
        body: { content: { 'application/json': { schema: lenientBody({
            held: z.boolean().openapi({ description: 'true holds the prompt queue; false releases it.' }),
          }) } }, required: true },
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
    async (c) => {
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
          opencodeSessionId: visible.row.runtimeSessionId ?? null,
        });
      }
      await holdInboxPrompts(sessionId, body.held);
      if (body.held) await disarmAllQuickQueueInterrupt(sessionId, loaded.userId);
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
}
