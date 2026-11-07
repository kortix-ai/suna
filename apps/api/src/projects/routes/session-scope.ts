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
import { and, eq } from 'drizzle-orm';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability } from '../lib/access';
import { projectsApp } from '../lib/app';
import { isUuid } from '../../shared/validate';
import { readJsonObject } from '../../shared/http-body';
import { resolveEffectiveSessionConnectorBindings } from '../lib/session-connector-bindings';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { allowStaleMirrorReads } from '../git/mirror';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { assertAgentScope } from '../../iam/agent-scope';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { canChangeSessionModel, mayChangeSessionModel, modelChangeResult, validateModelChangeShape } from '../lib/session-model-change';
import { pushSessionModelToSandbox, pushSessionScopeToSandbox } from '../lib/sandbox-env-sync';
import { toSessionModelRef } from '../../llm-gateway/resolution/effective';
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
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { missingClaudeSubscription, claudeSubscriptionRequiredBody } from '../claude-subscription/gate';
import { parseModelSwitchInput } from '../lib/session-model-switch-input';
import { storeSessionModelSwitch } from '../lib/session-model-switch-store';
import { drainSessionLifecycleQueue } from '../session-lifecycle';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { rethrowDatabaseError } from '../../shared/database-errors';
import { capturePersonEvent } from './product-events';
import { workspaceIdParam } from '../../shared/route-params';

export function registerSessionScopeRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/sessions/{sessionId}/scope',
      tags: ['sessions'],
      summary: "Read a session's secret and connection scope",
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
      },
      responses: {
        200: json(SessionScopeSchema, 'Current session scope'),
        ...errors(400, 404, 409),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
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
        rethrowDatabaseError(err);
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
      path: '/{workspaceId}/sessions/{sessionId}/scope',
      tags: ['sessions'],
      summary: "Re-scope a running session's secrets and connector bindings",
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
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
      const projectId = workspaceIdParam(c);
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
      const { bindingRows } = bindingsDecision;

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
      // dispose re-read the OpenCode config file only, NOT the child's process
      // env, so OpenCode kept its stale 0/47 PID while `agent-env.sh` got the new
      // set. The box reported a stale OpenCode until something else forced a
      // respawn.
      //
      // Push here, the same pattern the `/model` PUT uses: re-derive the snapshot
      // from the row we just committed, POST it to the daemon, and restart
      // the runtime so it starts with the new project env.
      // Only when the effective set actually moved — a no-op re-scope (same
      // allowlist) must not restart the runtime and kill an in-flight turn for
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
   * `model` was create-only: the sandbox reads `KORTIX_MODEL`
   * when the runtime builds its config at start, and nothing re-pushed it — so a live
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
      path: '/{workspaceId}/sessions/{sessionId}/model',
      tags: ['sessions'],
      summary: "Change a running session's model",
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: z.object({
                model: z.string().min(1).max(128).optional(),
                prompt: z.string().min(1).max(32000).optional(),
                idempotency_key: z.string().min(1).max(128).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: json(
          z.object({
            model: z.string(),
            /** True when a live sandbox took it; false when it applies at next boot. */
            applied_live: z.boolean(),
            /**
             * Present only when a live push was REQUIRED and FAILED — the row is
             * written but the running harness still answers from the OLD model.
             * `applied_live: false` cannot express this on its own (it is also the
             * benign cold-session answer), so a client must read THIS to tell a
             * half-applied change from a stored one.
             */
            prompt_id: z.string().optional(),
            deduped: z.boolean().optional(),
            push_failed: z.literal(true).optional(),
            detail: z.string().optional(),
          }),
          'Model changed',
        ),
        ...errors(400, 403, 404, 409),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

      const loaded = await loadProjectForUser(c, projectId, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      // A live model change restarts the runtime and can terminate the target
      // session's in-flight turn. Scoped agent tokens therefore need the same
      // destructive capability as the stop route (no-op for human/PAT tokens).
      assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
      const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
      if (!visible) return c.json({ error: 'Not found' }, 404);
      // Seeing a session is not permission to mutate it: visibility 'project'
      // makes it readable by every member, but changing the model restarts
      // the runtime and destroys the OWNER's in-flight turn. Same gate as the
      // sharing and stop routes above.
      if (!mayChangeSessionModel(visible)) {
        return c.json(
          { error: 'Only the session owner or a workspace manager can change this session model' },
          403,
        );
      }

      const body = await readJsonObject(c);
      const switchInput = parseModelSwitchInput(body);
      if (switchInput.kind === 'invalid') return c.json({ error: switchInput.error }, 400);
      const named = body.model;
      const requested = typeof named === 'string' ? named : '';
      const shapeError = validateModelChangeShape(requested);
      if (shapeError) {
        return c.json({ error: shapeError.message, code: shapeError.code }, 400);
      }
      const stateError = canChangeSessionModel(visible.row.status);
      if (stateError) {
        return c.json({ error: stateError.message, code: stateError.code }, 409);
      }

      // Same gate as create — otherwise this endpoint becomes the very back
      // door the PATCH guard just closed. The gateway resolver validates
      // servability and the pin is stored as `kortix/<wire>`.
      const trimmed = requested.trim();
      let nextModel: string;
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
      nextModel = toSessionModelRef(trimmed);
      // The session model lives in metadata, not a column (sessions.ts:1102) —
      // which is precisely why the PATCH metadata back door was dangerous.
      const currentMetadata = (visible.row.metadata ?? {}) as Record<string, unknown>;
      const currentModel =
        typeof currentMetadata.model === 'string' ? currentMetadata.model : null;
      if (switchInput.kind === 'switch') {
        assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
        await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_START);
        await resolveAndAuthorizeAgent(c, loaded, projectId, null, visible.row.agentName, undefined, visible.row.spaceId);
        if (!isProjectSessionPrincipal(c)) {
          const missing = await missingClaudeSubscription({ accountId: loaded.row.accountId,
            projectId, sessionId, userId: loaded.userId, model: nextModel });
          if (missing) return c.json(claudeSubscriptionRequiredBody(missing), 409);
        }
        const billing = await checkBillingAdmission(loaded.row.accountId);
        if (!billing.ok) {
          capturePersonEvent(c, loaded, projectId, 'billing_gate_hit', {
            reason: billing.reason,
            where: 'model_switch',
            session_id: sessionId,
          });
          return c.json({ error: billing.message, code: billing.reason }, 402);
        }
      }
      const stored = await storeSessionModelSwitch({
        projectId, accountId: loaded.row.accountId, sessionId, actorUserId: loaded.userId,
        actorSessionId: isProjectSessionPrincipal(c) ? callerKortixSessionId(c) : null,
        model: nextModel,
        ...(switchInput.kind === 'switch' ? { prompt: switchInput.prompt } : {}),
        key: switchInput.kind === 'switch' ? switchInput.key : crypto.randomUUID(),
        push: (model) => pushSessionModelToSandbox({ projectId, sessionId, model }),
      });
      if (stored.kind === 'conflict') return c.json({ error: 'Retry key belongs to a different model switch' }, 409);
      if (stored.kind === 'limited') return c.json({ error: 'At most three self model switches per hour' }, 409);
      if (switchInput.kind === 'switch') {
        void drainSessionLifecycleQueue({ idempotencyKey: `model-switch:${sessionId}:${switchInput.key}` }).catch(() => undefined);
      }
      if (!stored.deduped && stored.model !== currentModel) {
        capturePersonEvent(c, loaded, projectId, 'model_changed', {
          session_id: sessionId,
          from: currentModel,
          to: stored.model,
          live_push: Boolean(stored.push?.applied),
        });
      }
      return c.json({ ...modelChangeResult({ model: stored.model, needsPush: stored.needsPush,
        push: stored.deduped ? undefined : stored.push, current: stored.deduped ? stored.model : currentModel }),
        ...(switchInput.kind === 'switch' ? { prompt_id: stored.promptId, deduped: stored.deduped } : {}) });
    },
  );
}
