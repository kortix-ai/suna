/**
 * GET /v1/projects/:projectId/sessions/:sessionId/open-bundle
 *
 * ONE round trip for everything the session view needs to PAINT and ARM.
 *
 * WHY IT EXISTS. Opening a session cost 6-8 serial control-plane round trips
 * before the first honest frame — the session row, `/turn`, `/prompts`,
 * `/transcript?shape=sync`, `/detail`, `/model-defaults` — each 0.3-2.3 s at
 * the median on a real deployment (measured, 20 session opens, 2026-08-26).
 * None of them is slow because of the work it does; they are slow because there
 * are six of them and the client cannot ask for the seventh until the sixth
 * lands. This route answers all of it from ONE auth + visibility resolution and
 * ONE parallel fan-out.
 *
 * IT INTRODUCES NO NEW TRUTH. Every leg calls the SAME function the individual
 * endpoint calls (`readSessionTurnState`, `listInboxPrompts` + `serializePrompt`,
 * `buildSessionTranscriptSyncEnvelope`, `serializeSession`,
 * `getAccountModelDefaults` + `resolveEffectiveModel`). A second projection of
 * one fact is how a client ends up holding two disagreeing answers, so there
 * is not one here.
 *
 * IT IS ADDITIVE, AND THE INDIVIDUAL ENDPOINTS STAY. The SDK prefers the bundle
 * and falls back to the singles, so an old client, a failed bundle, and a
 * degraded leg all keep working.
 *
 * CONTROL PLANE ONLY — no sandbox hop, ever. The transcript comes from the
 * durable MIRROR (a DB read), never from the box; readiness stays the job of
 * `POST .../start`, which is the only call allowed to wake anything. That is
 * what keeps this route answerable in ~one DB round trip for a stopped session
 * and stops it racing `/start` for the "is the runtime up" answer.
 *
 * EVERY SUB-OBJECT IS TRI-STATE (`known`). A leg that failed says
 * `known: false` and the client renders UNKNOWN — never idle, never an empty
 * queue, never "no models". A default rendered as an answer is the defect class
 * this bundle exists to remove, so it must not re-introduce it under a new name.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';

import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { platformDefaultModelId } from '../../llm-gateway/models/served-managed-models';
import { resolveEffectiveModel } from '../../llm-gateway/resolution/default-model';
import { getAccountModelDefaults } from '../../repositories/model-preferences';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  sessionIsTombstoned,
} from '../lib/access';
import { AnyObject, projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../lib/caller-session';
import { serializeSession } from '../lib/serializers';
import { UUID_V4_REGEX, parseBoundedPositiveInt } from '../lib/serializers';
import { serializePrompt } from '../lib/session-prompt-view';
import { buildSessionTranscriptSyncEnvelope } from '../lib/session-transcript';
import { readSessionTurnState } from '../lib/session-turn-read';
import { readRuntimeLeg } from '../lib/session-runtime-projection';
import { scheduleRuntimeProjectionRefresh } from '../lib/session-runtime-projection-refresh';
import { listInboxPrompts } from '../session-lifecycle/inbox-rows';

/** Same ceiling `GET .../prompts` uses. The inbox is a queue, not a log. */
const PROMPT_LIST_LIMIT = 200;

/** Mirrored messages the bundle carries by default — the SDK's own first-paint
 *  window (`MIRROR_HYDRATE_LIMIT`), so the bundle and the read that replaces it
 *  cover the same span. `?transcript=0` asks for the POINTER only, which is
 *  what a client with a warm store wants: it needs to know WHICH OpenCode root
 *  and HOW MANY messages, not the bytes it already holds. */
const TRANSCRIPT_DEFAULT = 40;
const TRANSCRIPT_MAX = 200;

/** Attach `known: false` and a reason to a leg that threw, so a degraded
 *  bundle is still an honest one. */
function failed(error: unknown): { known: false; reason: string } {
  // Never surface raw error text to callers (a Postgres error would leak its
  // message to anyone with project read). Log it; return a stable code — the
  // tri-state contract only needs "this leg is unknown", not why.
  console.warn('[open-bundle] leg failed:', error instanceof Error ? error.message : String(error));
  return { known: false, reason: 'leg_failed' };
}

const sessionSnapshotRoute = (path: string, summary: string) =>
  createRoute({
    method: 'get',
    path,
    tags: ['sessions'],
    summary,
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      query: z.object({ transcript: z.string().optional() }),
    },
    responses: {
      200: json(AnyObject, 'Everything the session view needs to paint and arm'),
      ...errors(400, 404),
    },
  });

const handleSessionSnapshot = async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const transcriptLimit = parseBoundedPositiveInt(
      c.req.query('transcript'),
      TRANSCRIPT_DEFAULT,
      0,
      TRANSCRIPT_MAX,
      'transcript',
    );
    if (!transcriptLimit.ok) return c.json({ error: transcriptLimit.error }, 400);

    // The SAME gate every leg's own endpoint applies, applied ONCE. `read` tier
    // plus the session-content leaf: this is a read, and a shared viewer may
    // open a session they did not create.
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(
      loaded,
      sessionId,
      callerKortixSessionId(c),
      callerKortixSessionId(c),
    );
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // A soft-deleted session is gone for a read-by-id — the same predicate
    // `GET .../sessions/:sessionId` applies, for the same reason.
    if (sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);

    const gatewayEnabled = projectLlmGatewayEnabled(loaded.row.metadata);
    const userId = c.get('userId') as string;

    // Captured BEFORE the fan-out: every leg is a snapshot no fresher than the
    // moment it was asked for. Stamping at response-build time claimed the
    // reads' SETTLE instant, which let a slow bundle outrank a direct read
    // issued after it — the cross-clock half of JAY-728.
    const observedAt = new Date().toISOString();

    // ONE fan-out. `allSettled`, never `all`: the bundle's whole value is that
    // it arrives together, and one leg failing must degrade that leg, not the
    // paint. Nothing here touches the sandbox, so nothing here can be held up
    // by a box that is asleep.
    const [turn, queue, transcript, models, runtime] = await Promise.allSettled([
      readSessionTurnState(sessionId),
      listInboxPrompts(sessionId, PROMPT_LIST_LIMIT),
      transcriptLimit.value === 0
        ? Promise.resolve(null)
        : buildSessionTranscriptSyncEnvelope({
            session: visible.row,
            limit: transcriptLimit.value,
          }),
      gatewayEnabled
        ? (async () => {
            const accountId = loaded.row.accountId as string;
            const [defaults, mayUseManaged] = await Promise.all([
              getAccountModelDefaults(accountId, projectId),
              accountMayUseManagedModels(accountId),
            ]);
            const freeTier = !mayUseManaged;
            const resolved = await resolveEffectiveModel({
              userId,
              accountId,
              projectId,
              explicit: null,
              freeModelsOnly: freeTier,
            });
            return {
              platformDefault: platformDefaultModelId(),
              accountDefault: defaults.account,
              agentDefaults: defaults.agents,
              projectDefault: defaults.projects[projectId] ?? null,
              resolvedForCaller:
                resolved.model ?? (freeTier ? null : platformDefaultModelId()),
              resolvedSource: resolved.source,
              freeTier,
            };
          })()
        : Promise.resolve(null),
      // = the daemon's `/kortix/opencode/state`, served from Postgres. This is
      // the leg that lets a STOPPED session answer "which agents, which
      // commands, what model" — it is a DB read like every other leg here, and
      // it does not touch the sandbox even when the box is up.
      readRuntimeLeg(sessionId),
    ]);

    const prompts =
      queue.status === 'fulfilled' ? queue.value.map(serializePrompt) : [];

    // A projection this open could not serve is worth fetching for the NEXT
    // one. Fire-and-forget, never awaited, and `scheduleRuntimeProjectionRefresh`
    // itself refuses to go near a sandbox whose row is not already `active` —
    // so the route's invariant is intact: this RESPONSE never waits on a box,
    // and nothing here can wake one, extend its deadline, or slow a stopped
    // session's open.
    if (runtime.status === 'fulfilled' && !runtime.value.known) {
      scheduleRuntimeProjectionRefresh({
        sessionId,
        projectId,
        accountId: loaded.row.accountId as string,
        userId,
      });
    }

    return c.json({
      // ONE clock for the whole envelope, captured BEFORE the reads began.
      // Every sub-object is a snapshot no fresher than this instant, and every
      // client-side projection ranks it against other SERVER stamps only.
      observed_at: observedAt,

      // The session row, byte-identical to `GET .../sessions/:sessionId`.
      session: serializeSession(visible.row, {
        grants: visible.grants,
        viewerId: loaded.userId,
        canManageProject: visible.canManageProject,
        ownerIsMachine: visible.ownerIsMachine,
        // Owner email is a second lookup for a display string the composer does
        // not need to paint. The session route still serves it.
        ownerEmail: null,
      }),

      // = GET .../turn. `known: false` means the read failed — render UNKNOWN,
      // never idle: idle is a claim, and only a source that could have known
      // may make it.
      turn:
        turn.status === 'fulfilled'
          ? { known: true as const, ...turn.value }
          : failed(turn.reason),

      // = GET .../prompts, plus the one derived bit the client would otherwise
      // recompute: whether Stop is holding the whole queue.
      queue:
        queue.status === 'fulfilled'
          ? {
              known: true as const,
              prompts,
              held: prompts.some(
                (prompt) => prompt.state === 'waiting' && prompt.reason === 'held',
              ),
            }
          : failed(queue.reason),

      // = GET .../transcript?shape=sync — the durable mirror, attachment bytes
      // already stripped by the capture. `null` when `?transcript=0` asked for
      // the pointer only; the session projection above still names the OpenCode
      // root, which is the identity a client needs to trust its own store.
      transcript:
        transcript.status === 'fulfilled'
          ? transcript.value === null
            ? { known: true as const, requested: false as const }
            : { known: true as const, requested: true as const, ...transcript.value }
          : failed(transcript.reason),

      // Control-plane composer essentials. Deliberately NOT the `/config`
      // route's freshness answer: that one compiles the manifest and re-reads
      // the box, which is exactly the kind of work a first paint must not wait
      // on.
      config: {
        known: true as const,
        base_ref: visible.row.baseRef ?? loaded.row.defaultBranch ?? null,
        agent_name: visible.row.agentName ?? null,
        llm_gateway_enabled: gatewayEnabled,
      },

      // = GET /projects/:id/model-defaults. `known: false` with
      // `reason: 'llm_gateway_disabled'` mirrors that route's own 404 for a
      // project with the gateway off — the client must not read the absence as
      // "no default model".
      models:
        models.status === 'fulfilled'
          ? models.value === null
            ? { known: false as const, reason: 'llm_gateway_disabled' }
            : { known: true as const, ...models.value }
          : failed(models.reason),

      // = the daemon's `/kortix/opencode/state`, from the runtime-projection
      // store. `known: false` with `reason` when there is no projection, when
      // its identity no longer matches the session's OpenCode pin, or when a
      // RUNNING box's projection has aged past the max — never an empty agent
      // roster presented as fact.
      runtime:
        runtime.status === 'fulfilled' ? runtime.value : failed(runtime.reason),
    });
  };

projectsApp.openapi(
  sessionSnapshotRoute(
    '/{projectId}/sessions/{sessionId}/snapshot',
    'GET /:projectId/sessions/:sessionId/snapshot',
  ),
  handleSessionSnapshot,
);
// The path every published `@kortix/sdk` requests (`getSessionOpenBundle`).
// The #6987 rename to `/snapshot` left shipped clients 404ing here — the
// bundle degraded silently to 6-8 serial reads on every session open. Same
// handler, same contract; keep until no supported SDK requests it.
projectsApp.openapi(
  sessionSnapshotRoute(
    '/{projectId}/sessions/{sessionId}/open-bundle',
    'GET /:projectId/sessions/:sessionId/open-bundle',
  ),
  handleSessionSnapshot,
);
