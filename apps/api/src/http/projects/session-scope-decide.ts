/**
 * The decision helpers behind `PUT /{projectId}/sessions/{sessionId}/scope`
 * (session-scope.ts). Each helper is one block the route handler used to run
 * inline, moved verbatim: same conditions, same comments, same strings, same
 * order. The handler stays the orchestration — authorize → parse → read
 * baseline → decide secrets → decide bindings → transaction → post-write
 * bindings → push → respond — with the transaction and the sandbox push left
 * in it. A refusal is a shaped `{ status, body }`, rendered by the handler
 * with `c.json`, so every error code and body is byte-for-byte what it was.
 */

import type { z } from '@hono/zod-openapi';
import { SessionScopeInputSchema } from '@kortix/api-contract';
import { projectSessionConnectorBindings, serviceAccounts } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../../services/iam';
import { assertAgentScope } from '../lib/agent-scope';
import { db } from '../../lib/db';
import { readJsonObject } from '../lib/http-body';
import { DEFAULT_AGENT_SENTINEL } from '../../services/projects/agents';
import { loadVisibleSession } from '../../services/projects/lib/access';
import { assertProjectCapability, loadProjectForUser, projectCapabilityAllowed } from '../lib/project-access';
import { callerKortixSessionId } from '../lib/caller-session';
import { resolveSessionPersonalOwner } from '../../services/projects/lib/personal-resources';
import { secretAudienceSubject } from '../../services/secrets/secret-audience';
import { resolveSessionAgentGrant } from '../../services/secrets/secret-grant';
import {
  invalidateSessionConnectorLookup,
  resolveEffectiveSessionConnectorBindings,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from '../../services/sessions/session-connector-bindings';
import { mayChangeSessionModel } from '../../services/sessions/session-model-change';
import { rescopeSessionBindings, rescopeSessionSecrets } from '../../services/sessions/session-rescope';
import { listResolvedProjectSecrets, secretKeyCollisionInAllowlist } from '../../services/secrets/secrets';
/** A shaped refusal a helper returns; the handler renders it with `c.json`. */
type ScopeRefusal = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  body: { error: string; code?: string };
};

type RescopeLoaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;
type RescopeVisible = NonNullable<Awaited<ReturnType<typeof loadVisibleSession>>>;
type RescopeGrant = Awaited<ReturnType<typeof resolveSessionAgentGrant>>;
type RescopeEffectiveBindings = Awaited<
  ReturnType<typeof resolveEffectiveSessionConnectorBindings>
>;
type RescopeInput = z.infer<typeof SessionScopeInputSchema>;

/** Who may re-scope this session, and which project row it belongs to. */
export async function authorizeScopeRescope({
  c,
  projectId,
  sessionId,
}: {
  c: any;
  projectId: string;
  sessionId: string;
}): Promise<ScopeRefusal | { ok: true; loaded: RescopeLoaded; visible: RescopeVisible }> {
  const loaded = await loadProjectForUser(c, projectId, 'session');
  if (!loaded) return { ok: false, status: 404, body: { error: 'Not found' } };
  await assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    PROJECT_ACTIONS.PROJECT_SESSION_STOP,
  );
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_STOP);
  const visible = await loadVisibleSession(loaded, sessionId, callerKortixSessionId(c), callerKortixSessionId(c));
  if (!visible) return { ok: false, status: 404, body: { error: 'Not found' } };
  // Seeing a session is not permission to re-scope it — same gate as the model
  // change, for the same reason.
  if (!mayChangeSessionModel(visible)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Only the session owner or a project manager can re-scope this session' },
    };
  }
  return { ok: true, loaded, visible };
}

/** The request body as the two decision axes read it, plus the three flags. */
export async function parseScopeRescopeInput(c: any): Promise<
  | ScopeRefusal
  | {
      ok: true;
      body: RescopeInput;
      wantsSecrets: boolean;
      wantsBindings: boolean;
      clearsBindings: boolean;
    }
> {
  const parsedBody = SessionScopeInputSchema.safeParse(await readJsonObject(c));
  if (!parsedBody.success) {
    return {
      ok: false,
      status: 400,
      body: {
        error: parsedBody.error.issues.map((issue) => issue.message).join('; '),
        code: 'INVALID_SESSION_SCOPE',
      },
    };
  }
  const body = parsedBody.data;
  const wantsSecrets = Object.hasOwn(body, 'secrets');
  const wantsBindings = Object.hasOwn(body, 'connector_bindings');
  // `null` CLEARS the override: drop the stored rows AND the configured flag,
  // so every granted alias resolves to the project default again. `{}` is the
  // opposite — an explicit "no connectors at all". Before this existed an
  // override was one-way: nothing in the API could undo one.
  const clearsBindings = wantsBindings && body.connector_bindings === null;
  return { ok: true, body, wantsSecrets, wantsBindings, clearsBindings };
}

/** The pre-write state both axes decide against: the agent grant and both binding views. */
export async function readRescopeBaseline({
  loaded,
  visible,
  projectId,
  sessionId,
}: {
  loaded: RescopeLoaded;
  visible: RescopeVisible;
  projectId: string;
  sessionId: string;
}): Promise<
  | ScopeRefusal
  | {
      ok: true;
      grant: RescopeGrant;
      currentDurableBindings: Record<string, string>;
      currentEffectiveBindings: RescopeEffectiveBindings;
      currentEffectiveBindingIds: Record<string, string>;
    }
> {
  // The agent grant is the ceiling for both axes. Resolved from the agent this
  // session actually runs, and fail-closed: if it cannot be established, the
  // re-scope is refused rather than applied against an unverified ceiling.
  let grant: RescopeGrant;
  try {
    grant = await resolveSessionAgentGrant({
      projectId,
      repoUrl: loaded.row.repoUrl,
      defaultBranch: loaded.row.defaultBranch,
      manifestPath: loaded.row.manifestPath,
      sessionAgent: visible.row.agentName ?? DEFAULT_AGENT_SENTINEL,
    });
  } catch (err) {
    return {
      ok: false,
      status: 409,
      body: {
        error: `could not resolve this agent's grant, so the new scope cannot be checked against it: ${
          err instanceof Error ? err.message : String(err)
        }`,
        code: 'AGENT_GRANT_UNRESOLVED',
      },
    };
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
  return {
    ok: true,
    grant,
    currentDurableBindings,
    currentEffectiveBindings,
    currentEffectiveBindingIds,
  };
}

/** The secrets decision: the new allowlist (and what changed) or the shaped 403/409. */
export async function decideSecretsRescope({
  wantsSecrets,
  body,
  grant,
  visible,
  loaded,
  projectId,
  c,
}: {
  wantsSecrets: boolean;
  body: RescopeInput;
  grant: RescopeGrant;
  visible: RescopeVisible;
  loaded: RescopeLoaded;
  projectId: string;
  c: any;
}): Promise<
  | ScopeRefusal
  | {
      ok: true;
      nextAllowlist: string[] | null;
      droppedSecrets: string[];
      addedSecrets: string[];
      narrowedSecrets: boolean;
      canReadSecretNames: boolean;
    }
> {
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
    if (!decided.ok) {
      return { ok: false, status: 403, body: { error: decided.message, code: decided.code } };
    }
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
      const secretsPrincipal = await resolveSessionPersonalOwner({
        projectId,
        sessionId: visible.row.sessionId,
        accountId: loaded.row.accountId,
        legacyUserId: visible.row.createdBy ?? loaded.userId,
      });
      // A value narrowed to an audience counts only for the SESSION's person and agent.
      const sessionAudience = () =>
        secretAudienceSubject({ projectId, accountId: loaded.row.accountId, sessionId: visible.row.sessionId });
      const availableSecrets = await listResolvedProjectSecrets(projectId, secretsPrincipal, sessionAudience);
      const available = new Set(
        availableSecrets.map((secret) => secret.identifier.toUpperCase()),
      );
      const unavailable = nextAllowlist.filter(
        (identifier) => !available.has(identifier.toUpperCase()),
      );
      if (unavailable.length > 0) {
        return {
          ok: false,
          status: 403,
          body: {
            error: `secret identifier is not available: ${unavailable.join(', ')}`,
            code: 'SECRET_IDENTIFIER_NOT_AVAILABLE',
          },
        };
      }
      const collision = secretKeyCollisionInAllowlist(availableSecrets, nextAllowlist);
      if (collision) {
        return {
          ok: false,
          status: 409,
          body: {
            error: `secrets allowlist names multiple identifiers for env key "${collision.key}": ${collision.identifiers.join(', ')}`,
            code: 'SECRET_IDENTIFIER_KEY_COLLISION',
          },
        };
      }
    }
  }
  return {
    ok: true,
    nextAllowlist,
    droppedSecrets,
    addedSecrets,
    narrowedSecrets,
    canReadSecretNames,
  };
}

/** The bindings decision: the new stored map (and rows to write) or the shaped 403/409. */
export async function decideBindingsRescope({
  wantsBindings,
  clearsBindings,
  body,
  currentDurableBindings,
  currentEffectiveBindingIds,
  grant,
  visible,
  loaded,
  projectId,
  sessionId,
}: {
  wantsBindings: boolean;
  clearsBindings: boolean;
  body: RescopeInput;
  currentDurableBindings: Record<string, string>;
  currentEffectiveBindingIds: Record<string, string>;
  grant: RescopeGrant;
  visible: RescopeVisible;
  loaded: RescopeLoaded;
  projectId: string;
  sessionId: string;
}): Promise<
  | ScopeRefusal
  | {
      ok: true;
      nextBindings: Record<string, string>;
      bindingRows: Array<{
        sessionId: string;
        projectId: string;
        accountId: string;
        connectorAlias: string;
        connectorId: string;
        connectionId: string;
        source: 'request';
        createdBy: string;
      }>;
    }
> {
  let nextBindings = currentDurableBindings;
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
    if (!decided.ok) {
      return { ok: false, status: 403, body: { error: decided.message, code: decided.code } };
    }
    nextBindings = decided.bindings;
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
      return { ok: false, status: 403, body: { error: validated.error, code: validated.code } };
    }
    if (
      visible.row.visibility !== 'private' &&
      sessionConnectorBindingsRequirePrivateVisibility(validated.bindings)
    ) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'A user authorization requires a private session',
          code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
        },
      };
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
  return { ok: true, nextBindings, bindingRows };
}

/** Re-resolve the effective bindings after the write and name what fell away. */
export async function resolvePostWriteBindings({
  wantsBindings,
  sessionId,
  loaded,
  projectId,
  grant,
  currentEffectiveBindings,
}: {
  wantsBindings: boolean;
  sessionId: string;
  loaded: RescopeLoaded;
  projectId: string;
  grant: RescopeGrant;
  currentEffectiveBindings: RescopeEffectiveBindings;
}): Promise<{ effectiveBindings: RescopeEffectiveBindings; droppedBindings: string[] }> {
  let droppedBindings: string[] = [];
  if (wantsBindings) {
    // The transaction above may have just changed
    // `connectorBindingsConfigured` / the session's binding rows. Drop the
    // request-scoped session-lookup memo (session-connector-bindings.ts) so
    // the re-resolution below reads the row THIS transaction wrote, not the
    // pre-write one cached by `currentEffectiveBindings` earlier in this
    // handler.
    invalidateSessionConnectorLookup(sessionId, loaded.row.accountId, projectId);
  }

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
  return { effectiveBindings, droppedBindings };
}

/** The `detail` string for the scope response — the nested ternary, flattened. */
function scopeResponseDetail({
  scopeSecretsChanged,
  narrowedSecrets,
  scopeAppliedLive,
  clearsBindings,
}: {
  scopeSecretsChanged: boolean;
  narrowedSecrets: boolean;
  scopeAppliedLive: boolean;
  clearsBindings: boolean;
}): string {
  if (scopeSecretsChanged) {
    if (narrowedSecrets) {
      return scopeAppliedLive
        ? 'Dropped secrets are cleared from the running sandbox now; new shells and the OpenCode process no longer see them. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.'
        : 'Dropped secrets stop being delivered from the next prompt. Values the agent already read remain in its context and in shells it already started — rotate them if that matters.';
    }
    return scopeAppliedLive
      ? 'Applied to the running sandbox now — the OpenCode process and new shells see the new scope.'
      : 'Applies from the next prompt.';
  }
  return clearsBindings
    ? 'Connector access is back to the project defaults.'
    : 'No change to the secrets scope.';
}

/** The scope response body, assembled from the pipeline's outputs. */
export function scopeResponseBody({
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
}: {
  nextAllowlist: string[] | null;
  effectiveBindings: RescopeEffectiveBindings;
  canReadSecretNames: boolean;
  droppedSecrets: string[];
  addedSecrets: string[];
  droppedBindings: string[];
  wantsBindings: boolean;
  clearsBindings: boolean;
  visible: RescopeVisible;
  narrowedSecrets: boolean;
  scopeAppliedLive: boolean;
  scopePushFailed: boolean;
  scopePushReason: string | undefined;
  scopeSecretsChanged: boolean;
}) {
  return {
    secrets_allowlist: nextAllowlist,
    required_connectors: null,
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
    detail: scopeResponseDetail({
      scopeSecretsChanged,
      narrowedSecrets,
      scopeAppliedLive,
      clearsBindings,
    }),
  };
}
