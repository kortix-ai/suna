/**
 * A session's SCOPE — the connector bindings, secret grants and model it runs
 * with. Read it, replace it, and switch the model on a live session.
 */

import { SessionScopeSchema, SessionScopeInputSchema } from '@kortix/api-contract';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { createRoute, z } from '@hono/zod-openapi';
import { connectors, projectSessions, projectSessionConnectorBindings, serviceAccounts } from '@kortix/db';
import { and, eq, or } from 'drizzle-orm';
import { config } from '../../config';
import { loadProjectForUser, loadVisibleSession, assertProjectCapability, projectCapabilityAllowed } from '../lib/access';
import { projectsApp } from '../lib/app';
import { UUID_V4_REGEX, readBody, hasOwn } from '../lib/serializers';
import { resolveEffectiveSessionConnectorBindings, sessionConnectorBindingsRequirePrivateVisibility, validateSessionConnectorBindings } from '../lib/session-connector-bindings';
import { callerKortixSessionId } from '../lib/caller-session';
import { DEFAULT_AGENT_SENTINEL } from '../agents';
import { resolveSessionAgentGrant } from '../lib/secret-grant';
import { assertAgentScope } from '../../iam/agent-scope';
import { accountMayUseManagedModels } from '../../billing/services/entitlements';
import { canChangeSessionModel, mayChangeSessionModel, modelChangeNeedsLivePush, modelChangeResult, validateModelChangeShape } from '../lib/session-model-change';
import { pushSessionModelToSandbox, pushSessionScopeToSandbox } from '../lib/sandbox-env-sync';
import { isModelServableForAccount } from '../../llm-gateway/resolution/default-model';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import { canonicalConnectorAlias, publicConnectorAlias } from '../../shared/connector-alias';
import { rescopeSessionBindings, rescopeSessionSecrets } from '../lib/session-rescope';
import { listResolvedProjectSecrets, secretKeyCollisionInAllowlist } from '../secrets';
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
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
    );
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
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
      required_connectors: visible.row.requiredConnectors ?? null,
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
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_SESSION_STOP,
    );
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c));
    if (!visible) return c.json({ error: 'Not found' }, 404);
    // Seeing a session is not permission to re-scope it — same gate as the model
    // change, for the same reason.
    if (!mayChangeSessionModel(visible)) {
      return c.json(
        { error: 'Only the session owner or a project manager can re-scope this session' },
        403,
      );
    }

    const parsedBody = SessionScopeInputSchema.safeParse(await readBody(c));
    if (!parsedBody.success) {
      return c.json(
        {
          error: parsedBody.error.issues.map((issue) => issue.message).join('; '),
          code: 'INVALID_SESSION_SCOPE',
        },
        400,
      );
    }
    const body = parsedBody.data;
    const wantsSecrets = Object.hasOwn(body, 'secrets');
    const wantsBindings = Object.hasOwn(body, 'connector_bindings');
    // `null` CLEARS the override: drop the stored rows AND the configured flag,
    // so every granted alias resolves to the project default again. `{}` is the
    // opposite — an explicit "no connectors at all". Before this existed an
    // override was one-way: nothing in the API could undo one.
    const clearsBindings = wantsBindings && body.connector_bindings === null;
    const wantsRequired = Object.hasOwn(body, 'require_connectors');

    // The agent grant is the ceiling for both axes. Resolved from the agent this
    // session actually runs, and fail-closed: if it cannot be established, the
    // re-scope is refused rather than applied against an unverified ceiling.
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
          error: `could not resolve this agent's grant, so the new scope cannot be checked against it: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code: 'AGENT_GRANT_UNRESOLVED',
        },
        409,
      );
    }

    const currentDurableBindings = Object.fromEntries(
      (
        await db
          .select({
            alias: projectSessionConnectorBindings.connectorAlias,
            connectionId: projectSessionConnectorBindings.connectionId,
          })
          .from(projectSessionConnectorBindings)
          .where(
            and(
              eq(projectSessionConnectorBindings.sessionId, sessionId),
              eq(projectSessionConnectorBindings.projectId, projectId),
            ),
          )
      ).map((row) => [row.alias, row.connectionId]),
    );
    const currentEffectiveBindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    const currentEffectiveBindingIds = Object.fromEntries(
      Object.entries(currentEffectiveBindings).map(([alias, binding]) => [
        alias,
        binding.connection_id,
      ]),
    );

    let nextAllowlist = visible.row.secretsAllowlist ?? null;
    let droppedSecrets: string[] = [];
    let addedSecrets: string[] = [];
    // Distinct from `droppedSecrets.length > 0`: a session's allowlist starts
    // null ("everything the grant allows"), so its FIRST narrowing may shrink
    // the effective set without being able to name what it lost — which is
    // precisely when the warning matters most.
    let narrowedSecrets = false;
    let canReadSecretNames = false;
    if (wantsSecrets) {
      const decided = rescopeSessionSecrets({
        current: visible.row.secretsAllowlist ?? null,
        requested: (body.secrets ?? null) as string[] | null,
        agentGrantEnv: grant?.env,
      });
      if (!decided.ok) return c.json({ error: decided.message, code: decided.code }, 403);
      nextAllowlist = decided.allowlist;
      droppedSecrets = decided.dropped;
      addedSecrets = decided.added;
      narrowedSecrets = decided.narrowed;
      // Only affects whether the dropped NAMES are echoed back — never whether
      // the narrowing itself is reported.
      canReadSecretNames = await projectCapabilityAllowed(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_SECRET_READ,
      );
      if (nextAllowlist !== null && nextAllowlist.length > 0) {
        // The SESSION OWNER, not the caller. Delivery resolves per principal —
        // `resolveOwnerRawEnv` keys the per-prompt push on `createdBy`, and
        // sessions.ts spells out why: "a per-user secret override resolves per
        // principal… if a manager restarted another member's session we'd inject
        // the MANAGER's personal secret".
        //
        // Validating against the caller let a project manager re-scoping someone
        // else's session add an identifier that exists only as the MANAGER's own
        // personal override. The API answered 200 with it listed in
        // `secrets_allowlist` and "Applies from the next prompt." — and the
        // session never received it, on that prompt or any later one, with
        // nothing anywhere saying so.
        //
        // Falls back to the caller only when the row carries no creator, which
        // matches how every other principal-resolution site degrades.
        const secretsPrincipal = visible.row.createdBy ?? loaded.userId;
        const availableSecrets = await listResolvedProjectSecrets(projectId, secretsPrincipal);
        const available = new Set(
          availableSecrets.map((secret) => secret.identifier.toUpperCase()),
        );
        const unavailable = nextAllowlist.filter(
          (identifier) => !available.has(identifier.toUpperCase()),
        );
        if (unavailable.length > 0) {
          return c.json(
            {
              error: `secret identifier is not available: ${unavailable.join(', ')}`,
              code: 'SECRET_IDENTIFIER_NOT_AVAILABLE',
            },
            403,
          );
        }
        const collision = secretKeyCollisionInAllowlist(availableSecrets, nextAllowlist);
        if (collision) {
          return c.json(
            {
              error: `secrets allowlist names multiple identifiers for env key "${collision.key}": ${collision.identifiers.join(', ')}`,
              code: 'SECRET_IDENTIFIER_KEY_COLLISION',
            },
            409,
          );
        }
      }
    }

    let nextBindings = currentDurableBindings;
    let droppedBindings: string[] = [];
    if (clearsBindings) {
      // No grant check and no binding validation: removing every stored binding
      // cannot widen what this session may reach beyond the project default,
      // which is what an un-overridden session already resolves to.
      nextBindings = {};
    } else if (wantsBindings) {
      const requested = Object.fromEntries(
        Object.entries(body.connector_bindings ?? {}).map(([alias, value]) => [
          alias,
          value.connection_id,
        ]),
      );
      const decided = rescopeSessionBindings({
        current: currentEffectiveBindingIds,
        requested,
        grantedConnectors: grant?.connectors,
      });
      if (!decided.ok) return c.json({ error: decided.message, code: decided.code }, 403);
      nextBindings = decided.bindings;
    }

    // `require_connectors` is the one axis that can name an alias with NOTHING
    // connected to it — that is the whole point of it existing separately from
    // bindings, which must carry a connection id. So it is checked against the
    // agent's grant (may this agent use the alias at all?) and never against
    // whether a connection exists: not-yet-connected is the state the caller is
    // deliberately declaring, and the pre-flight turns it into a connect prompt
    // on the next turn.
    let nextRequired = visible.row.requiredConnectors ?? null;
    if (wantsRequired) {
      const requested = (body.require_connectors ?? [])
        .map((alias) => canonicalConnectorAlias(String(alias).trim()))
        .filter((alias) => alias.length > 0);
      const deduped = [...new Set(requested)];
      if (Array.isArray(grant?.connectors)) {
        const granted = new Set(grant.connectors.map(canonicalConnectorAlias));
        const offending = deduped.filter((alias) => !granted.has(alias));
        if (offending.length > 0) {
          return c.json(
            {
              error: `not granted to this agent: ${offending.map(publicConnectorAlias).join(', ')}`,
              code: 'CONNECTOR_NOT_ASSIGNED',
            },
            403,
          );
        }
      }
      nextRequired = deduped.length > 0 ? deduped : null;
    }

    let bindingRows: Array<{
      sessionId: string;
      projectId: string;
      accountId: string;
      connectorAlias: string;
      connectorId: string;
      connectionId: string;
      source: 'request';
      createdBy: string;
    }> = [];
    if (wantsBindings && !clearsBindings) {
      const [ownerServiceAccount] = visible.row.createdBy
        ? await db
            .select({ id: serviceAccounts.serviceAccountId })
            .from(serviceAccounts)
            .where(
              and(
                eq(serviceAccounts.serviceAccountId, visible.row.createdBy),
                eq(serviceAccounts.accountId, loaded.row.accountId),
              ),
            )
            .limit(1)
        : [];
      const validated = await validateSessionConnectorBindings({
        accountId: loaded.row.accountId,
        projectId,
        actingUserId: visible.row.createdBy ?? '',
        actingPrincipalIsServiceAccount: ownerServiceAccount !== undefined,
        mayManageSystemConnections: false,
        bindings: Object.fromEntries(
          Object.entries(nextBindings).map(([alias, authorizationId]) => [
            alias,
            { connection_id: authorizationId },
          ]),
        ),
      });
      if (!validated.ok) {
        return c.json({ error: validated.error, code: validated.code }, 403);
      }
      if (
        visible.row.visibility !== 'private' &&
        sessionConnectorBindingsRequirePrivateVisibility(validated.bindings)
      ) {
        return c.json(
          {
            error: 'A user authorization requires a private session',
            code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
          },
          409,
        );
      }
      bindingRows = validated.bindings.map((binding) => ({
        sessionId,
        projectId,
        accountId: loaded.row.accountId,
        connectorAlias: binding.alias,
        connectorId: binding.connectorId,
        connectionId: binding.connectionId,
        source: 'request' as const,
        createdBy: loaded.userId,
      }));
    }

    await db.transaction(async (tx) => {
      const sessionUpdates: {
        updatedAt: Date;
        secretsAllowlist?: string[] | null;
        requiredConnectors?: string[] | null;
        connectorBindingsConfigured?: boolean;
        connectorBindingsInheritUnbound?: boolean;
      } = { updatedAt: new Date() };
      if (wantsSecrets) sessionUpdates.secretsAllowlist = nextAllowlist;
      if (wantsRequired) sessionUpdates.requiredConnectors = nextRequired;
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

    const effectiveBindings = await resolveEffectiveSessionConnectorBindings({
      accountId: loaded.row.accountId,
      projectId,
      sessionId,
      grantedConnectors: grant?.connectors,
    });
    if (wantsBindings) {
      droppedBindings = Object.keys(currentEffectiveBindings).filter(
        (alias) => !Object.hasOwn(effectiveBindings, alias),
      );
    }

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

    return c.json({
      secrets_allowlist: nextAllowlist,
      required_connectors: nextRequired,
      connector_bindings: effectiveBindings,
      // Names are gated; the WARNING is not. Enumerating the agent grant to
      // report what a null → list narrowing dropped hands the caller secret
      // identifiers they may not be entitled to see: this route gates on
      // project.session.stop, and a plain member holds that for their own
      // session while deliberately lacking project.secret.read. `narrowed`
      // carries no names, so the "rotate them" warning still fires for everyone
      // — which is the part that actually matters.
      dropped_secrets: canReadSecretNames ? droppedSecrets : [],
      added_secrets: addedSecrets,
      dropped_bindings: droppedBindings,
      // Echoed so the caller can re-render from THIS response instead of
      // re-fetching the scope to learn whether an override now exists.
      connector_bindings_configured: wantsBindings
        ? !clearsBindings
        : visible.row.connectorBindingsConfigured === true,
      connector_bindings_inherit_unbound: visible.row.connectorBindingsInheritUnbound === true,
      // Connector bindings ARE retroactive (resolved at call time). Secrets are
      // not: a dropped one stops being delivered from the next prompt, but the
      // agent's context and any shell it already spawned still hold what it read.
      // Keyed on `narrowed`, not on the dropped NAMES. Narrowing a session away
      // from an unrestricted allowlist shrinks what it may read even when the
      // agent's grant is 'all' and the lost names cannot be enumerated — and
      // that is the largest narrowing there is. Keying off the names suppressed
      // this warning on exactly that case, telling a user revoking every secret
      // from a live session that nothing had been dropped.
      retroactive: !narrowedSecrets,
      applied_live: scopeAppliedLive,
      ...(scopePushFailed ? { push_failed: true as const, push_reason: scopePushReason } : {}),
      detail: scopeSecretsChanged
        ? narrowedSecrets
          ? scopeAppliedLive
            ? 'Dropped secrets are cleared from the running sandbox now; new shells and the OpenCode process no longer see them. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.'
            : 'Dropped secrets stop being delivered from the next prompt. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.'
          : scopeAppliedLive
            ? 'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.'
            : 'Applies from the next prompt.'
        : clearsBindings
          ? 'Connector access is back to the project defaults.'
          : 'No change to the secrets scope.',
    });
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
            schema: z.object({ opencode_model: z.string().min(1).max(128) }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
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
    if (!UUID_V4_REGEX.test(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    // A live model change restarts opencode and can terminate the target
    // session's in-flight turn. Scoped agent tokens therefore need the same
    // destructive capability as the stop route (no-op for human/PAT tokens).
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null);
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

    const body = await readBody(c);
    const requested = typeof body?.opencode_model === 'string' ? body.opencode_model : '';
    const shapeError = validateModelChangeShape(requested);
    if (shapeError) {
      return c.json({ error: shapeError.message, code: shapeError.code }, 400);
    }
    const stateError = canChangeSessionModel(visible.row.status);
    if (stateError) {
      return c.json({ error: stateError.message, code: stateError.code }, 409);
    }

    // Same servability gate as create — otherwise this endpoint becomes the very
    // back door the PATCH guard just closed.
    const trimmed = requested.trim();
    const freeModelsOnly = !(await accountMayUseManagedModels(loaded.row.accountId));
    const servable = await isModelServableForAccount({
      userId: loaded.userId,
      accountId: loaded.row.accountId,
      projectId,
      freeModelsOnly,
      model: trimmed,
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

    const nextModel = toOpencodeModelRef(trimmed);
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
