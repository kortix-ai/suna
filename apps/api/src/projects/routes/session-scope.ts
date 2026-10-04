/**
 * A session's SCOPE — the connector bindings, secret grants and model it runs
 * with. Read it, replace it, and switch the model on a live session.
 */

import { SessionScopeSchema, SessionScopeInputSchema } from '@kortix/api-contract';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions, projectSessionConnectorBindings } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import { config } from '../../lib/config';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { projectsApp } from '../lib/app';
import { isUuid } from '../../shared/validate';
import { readJsonObject } from '../../shared/http-body';
import { resolveEffectiveSessionConnectorBindings } from '../lib/session-connector-bindings';
import { callerKortixSessionId } from '../lib/caller-session';
import { allowStaleMirrorReads } from '../git/mirror';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { assertAgentScope } from '../../iam/agent-scope';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { canChangeSessionModel, mayChangeSessionModel, modelChangeNeedsLivePush, modelChangeResult, validateModelChangeShape, validateNativeOpencodeModelRef } from '../lib/session-model-change';
import { pushSessionModelToSandbox, pushSessionScopeToSandbox } from '../lib/sandbox-env-sync';
import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import { canonicalConnectorAlias, publicConnectorAlias } from '../../shared/connector-alias';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { admitSessionModelChange } from '../lib/session-model-keys';
import { validateProviderSecretPool } from './provider-secret-pools';
import {
  authorizeScopeRescope,
  decideBindingsRescope,
  decideSecretsRescope,
  parseScopeRescopeInput,
  readRescopeBaseline,
  resolvePostWriteBindings,
  scopeResponseBody,
} from './session-scope-decide';
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sessions/{sessionId}/scope',
    tags: ['sessions'],
    summary: "Read a session's secret and connection scope",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
    },
    responses: {
      200: json(SessionScopeSchema, 'Current session scope'),
      ...errors(400, 404, 409),
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
    // A page view: read the agent's grant from the warm git mirror and refresh
    // it behind the response. Without this, every GET after the 60 s refresh
    // interval blocked on `git fetch` (seconds under load) and, on a cold
    // mirror, on the clone lock, until the 25 s request deadline.
    allowStaleMirrorReads();
    let grant: Awaited<ReturnType<typeof resolveSessionAgentGrant>>;
    try {
      grant = await resolveSessionAgentGrant({
        projectId,
        repoUrl: loaded.row.repoUrl,
        defaultBranch: loaded.row.defaultBranch,
        manifestPath: loaded.row.manifestPath,
        sessionAgent: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL,
      });
    } catch (err) {
      return c.json(
        {
          error: `could not resolve this agent's grant, so the current scope cannot be determined: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code: 'AGENT_GRANT_UNRESOLVED',
        },
        409,
      );
    }
    const bindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    return c.json({
      secrets_allowlist: visible.row.secretsAllowlist ?? null,
      // Always null. A session cannot require connectors any more, but the key
      // stays on the wire: `SessionScope` is a published @kortix/sdk type, and a
      // consumer reading `scope.required_connectors` must get null, not
      // undefined.
      required_connectors: null,
      connector_bindings: bindings,
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: true,
      // `connector_bindings` above is the RESOLVED map, so an inherited session
      // and an overridden one look identical in it. Clients read this flag to
      // tell them apart — without it the browser rendered "None selected" for a
      // session that was simply inheriting, then wrote an explicit
      // zero-connector override on the next untouched save.
      connector_bindings_configured: visible.row.connectorBindingsConfigured === true,
      connector_bindings_inherit_unbound: visible.row.connectorBindingsInheritUnbound === true,
      detail: 'Current session scope.',
    });
  },
);

// GET /v1/projects/:projectId/sessions/:sessionId/config
// Is this session running the latest agent config? Compares what the BOX says
// it spawned with against what the manifest compiles to right now.

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/scope',
    tags: ['sessions'],
    summary: "Re-scope a running session's secrets and connector bindings",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: SessionScopeInputSchema,
          },
        },
      },
    },
    responses: {
      200: json(SessionScopeSchema, 'Session re-scoped'),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const authorized = await authorizeScopeRescope({ c, projectId, sessionId });
    if (!authorized.ok) return c.json(authorized.body, authorized.status);
    const { loaded, visible } = authorized;
    const parsed = await parseScopeRescopeInput(c);
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    const { body, wantsSecrets, wantsBindings, clearsBindings } = parsed;

    const baseline = await readRescopeBaseline({ loaded, visible, projectId, sessionId });
    if (!baseline.ok) return c.json(baseline.body, baseline.status);
    const { grant } = baseline;

    const secretsDecision = await decideSecretsRescope({
      wantsSecrets,
      body,
      grant,
      visible,
      loaded,
      projectId,
      c,
    });
    if (!secretsDecision.ok) return c.json(secretsDecision.body, secretsDecision.status);
    const { nextAllowlist, droppedSecrets, addedSecrets, narrowedSecrets, canReadSecretNames } =
      secretsDecision;

    const bindingsDecision = await decideBindingsRescope({
      wantsBindings,
      clearsBindings,
      body,
      currentDurableBindings: baseline.currentDurableBindings,
      currentEffectiveBindingIds: baseline.currentEffectiveBindingIds,
      grant,
      visible,
      loaded,
      projectId,
      sessionId,
    });
    if (!bindingsDecision.ok) return c.json(bindingsDecision.body, bindingsDecision.status);
    const { nextBindings, bindingRows } = bindingsDecision;

    await db.transaction(async (tx) => {
      const sessionUpdates: {
        updatedAt: Date;
        secretsAllowlist?: string[] | null;
        connectorBindingsConfigured?: boolean;
        connectorBindingsInheritUnbound?: boolean;
      } = { updatedAt: new Date() };
      if (wantsSecrets) sessionUpdates.secretsAllowlist = nextAllowlist;
      if (wantsBindings) {
        // `null` reverts the session to inheriting project defaults; anything
        // else is an explicit override.
        sessionUpdates.connectorBindingsConfigured = !clearsBindings;
        // Deliberately NOT touching connectorBindingsInheritUnbound. Forcing it
        // false here meant a single scope save silently cut off project-default
        // fallback for every alias the caller did not re-bind — a session that had
        // been resolving Gmail from the project default simply stopped, with
        // nothing in the request having asked for that. The schema comment still
        // called the flag immutable while this line mutated it.
      }
      await tx
        .update(projectSessions)
        .set(sessionUpdates)
        .where(
          and(
            eq(projectSessions.sessionId, sessionId),
            eq(projectSessions.projectId, projectId),
            eq(projectSessions.accountId, loaded.row.accountId),
          ),
        );
      if (wantsBindings) {
        await tx
          .delete(projectSessionConnectorBindings)
          .where(
            and(
              eq(projectSessionConnectorBindings.sessionId, sessionId),
              eq(projectSessionConnectorBindings.projectId, projectId),
              eq(projectSessionConnectorBindings.accountId, loaded.row.accountId),
            ),
          );
        if (bindingRows.length > 0) {
          await tx.insert(projectSessionConnectorBindings).values(bindingRows);
        }
      }
    });
    const { effectiveBindings, droppedBindings } = await resolvePostWriteBindings({
      wantsBindings,
      sessionId,
      loaded,
      projectId,
      grant,
      currentEffectiveBindings: baseline.currentEffectiveBindings,
    });

    // Connector bindings are resolved server-side at call time, so they need no
    // push. Secrets are different: the allowlist narrows what the sandbox
    // receives, and for a long time this route just persisted the row and told
    // the caller "Applies from the next prompt." — delegating delivery to the
    // per-prompt hot sync. That delegation was unreliable. The hot sync has
    // silent early-returns (`!serviceKey`, `!snapshot`), only fires when the
    // prompt routes through `POST :8000 /session/{id}/{prompt_async|message}`
    // (a prompt sent any other way slips past it), and even when it fired the
    // daemon took the ~51ms dispose fast path for a pure secret change — and a
    // dispose re-reads the opencode config file only, NOT the child's process
    // env, so opencode kept its stale 0/47 PID while `agent-env.sh` got the new
    // set. The box reported a stale OpenCode until something else forced a
    // respawn.
    //
    // Push here, the same pattern the `/model` PUT uses: re-derive the snapshot
    // from the row we just committed, POST it to the daemon, and restart
    // opencode so `spawnChild` re-runs `mergeProjectEnv` + the gateway strip.
    // Only when the effective set actually moved — a no-op re-scope (same
    // allowlist) must not restart opencode and kill an in-flight turn for
    // nothing. `applied_live` tells the caller whether it is in effect NOW or
    // only at the next boot, exactly like the model route.
    let scopeAppliedLive = false;
    let scopePushFailed = false;
    let scopePushReason: string | undefined;
    const scopeSecretsChanged =
      wantsSecrets && (narrowedSecrets || addedSecrets.length > 0 || droppedSecrets.length > 0);
    if (scopeSecretsChanged) {
      const push = await pushSessionScopeToSandbox({ projectId, sessionId });
      scopeAppliedLive = push.applied;
      if (!push.applied) {
        scopePushFailed = true;
        scopePushReason = push.reason;
      }
    }
    return c.json(
      scopeResponseBody({
        nextAllowlist,
        effectiveBindings,
        canReadSecretNames,
        droppedSecrets,
        addedSecrets,
        droppedBindings,
        wantsBindings,
        clearsBindings,
        visible,
        narrowedSecrets,
        scopeAppliedLive,
        scopePushFailed,
        scopePushReason,
        scopeSecretsChanged,
      }),
    );
  },
);

/**
 * Change the model a session uses, mid-flight.
 *
 * `opencode_model` was create-only: the sandbox reads `KORTIX_OPENCODE_MODEL`
 * when opencode builds its config at spawn, and nothing re-pushed it — so a live
 * box kept its boot model for the rest of the session. The only way to "change"
 * it was to plant a value through PATCH metadata, which skipped the account
 * servability check entirely (now blocked; see SERVER_MANAGED_METADATA_KEYS).
 *
 * Validates against the SAME resolver the create path uses, persists, then
 * pushes to the live sandbox. The response says whether it is in effect NOW or
 * only from the next boot, because those are genuinely different outcomes and
 * the caller cannot otherwise tell.
 */

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/sessions/{sessionId}/model',
    tags: ['sessions'],
    summary: "Change a running session's model",
    ...auth,
    request: {
      params: z.object({ projectId: z.string(), sessionId: z.string() }),
      body: {
        content: {
          'application/json': {
            // `model` wins; `opencode_model` is its pre-W4 name.
            schema: z.object({
              model: z.string().min(1).max(128).optional(),
              opencode_model: z.string().min(1).max(128).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          model: z.string(),
          /** @deprecated The pre-W4 name of `model`. Same value. */
          opencode_model: z.string(),
          /** True when a live sandbox took it; false when it applies at next boot. */
          applied_live: z.boolean(),
          /**
           * Present only when a live push was REQUIRED and FAILED — the row is
           * written but the running harness still answers from the OLD model.
           * `applied_live: false` cannot express this on its own (it is also the
           * benign cold-session answer), so a client must read THIS to tell a
           * half-applied change from a stored one.
           */
          push_failed: z.literal(true).optional(),
          detail: z.string().optional(),
        }),
        'Model changed',
      ),
      ...errors(400, 403, 404, 409),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const sessionId = c.req.param('sessionId');
    if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A live model change restarts opencode and can terminate the target
    // session's in-flight turn. Scoped agent tokens therefore need the same
    // destructive capability as the stop route (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Seeing a session is not permission to mutate it: visibility 'project'
    // makes it readable by every member, but changing the model restarts
    // opencode and destroys the OWNER's in-flight turn. Same gate as the
    // sharing and stop routes above.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a project manager can change this session model' },
        403,
      );
    }

    const body = await readJsonObject(c);
    const named = body.model ?? body.opencode_model;
    const requested = typeof named === 'string' ? named : '';
    const shapeError = validateModelChangeShape(requested);
    if (shapeError) {
      return c.json({ error: shapeError.message, code: shapeError.code }, 400);
    }
    const stateError = canChangeSessionModel(visible.row.status);
    if (stateError) {
      return c.json({ error: stateError.message, code: stateError.code }, 409);
    }

    // Same two-path gate as create — otherwise this endpoint becomes the very
    // back door the PATCH guard just closed. Gateway ON: the gateway resolver
    // validates servability and the pin is stored as `kortix/<wire>`. Gateway
    // OFF: OpenCode owns the catalog, so only the native `provider/model`
    // shape is enforced and the pin is stored verbatim.
    const trimmed = requested.trim();
    const llmGatewayEnabled = projectLlmGatewayEnabled(loaded.row.metadata);
    let nextModel: string;
    if (!llmGatewayEnabled) {
      const nativeShapeError = validateNativeOpencodeModelRef(trimmed);
      if (nativeShapeError) {
        return c.json({ error: nativeShapeError.message, code: nativeShapeError.code }, 400);
      }
      nextModel = trimmed;
    } else {
      const freeModelsOnly = !(await accountMayUseManagedModels(loaded.row.accountId));
      const owner = visible.row.createdBy ?? loaded.userId;
      // Checked in the key scope the gateway uses for this session; stores the
      // pooled keys it selects (lib/session-model-keys.ts).
      const servable = await admitSessionModelChange({
        accountId: loaded.row.accountId,
        projectId,
        sessionId,
        owner,
        caller: loaded.userId,
        freeModelsOnly,
        model: trimmed,
        mayPool:
          resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets') &&
          !visible.ownerIsMachine &&
          Boolean(visible.row.createdBy),
        callerMaySelect: async (providerId, secretIds) =>
          !(await validateProviderSecretPool({
            accountId: loaded.row.accountId,
            projectId,
            repoUrl: loaded.row.repoUrl,
            defaultBranch: loaded.row.defaultBranch,
            manifestPath: loaded.row.manifestPath,
            agentName: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL,
            userId: loaded.userId,
            providerId,
            ids: secretIds,
          })),
      });
      if (!servable) {
        return c.json(
          {
            error: `Model "${trimmed}" is not available for this account`,
            code: 'INVALID_SESSION_MODEL',
          },
          400,
        );
      }
      nextModel = toOpencodeModelRef(trimmed);
    }
    // The session model lives in metadata, not a column (sessions.ts:1102) —
    // which is precisely why the PATCH metadata back door was dangerous.
    const currentMetadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
    const currentModel =
      typeof currentMetadata.opencode_model === 'string' ? currentMetadata.opencode_model : null;
    const needsPush = modelChangeNeedsLivePush({
      current: currentModel,
      next: nextModel,
      status: visible.row.status,
    });

    await db
      .update(projectSessions)
      .set({
        metadata: {
          ...currentMetadata,
          opencode_model: nextModel,
          opencode_model_source: 'explicit',
        },
        updatedAt: new Date(),
      })
      .where(eq(projectSessions.sessionId, sessionId));

    if (!needsPush) {
      return c.json(
        modelChangeResult({ model: nextModel, needsPush: false, current: currentModel }),
      );
    }

    const push = await pushSessionModelToSandbox({ projectId, sessionId, model: nextModel });
    return c.json(modelChangeResult({ model: nextModel, needsPush: true, push }));
  },
);
