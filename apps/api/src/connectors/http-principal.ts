/** The connector router's request authorizers: who is calling, read from the Hono request. */
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authorize, PROJECT_ACTIONS } from '../iam';
import { actorOf } from '../iam/actor';
import { loadProjectForUser } from '../projects/lib/access';
import { reconcileStoredSessionAgentGrant } from '../projects/lib/session-token-grant';
import { db } from '../shared/db';
import { getRequestOnBehalfOf } from '../projects/lib/on-behalf-of';
import { tokenAgentPrincipalScope } from '../projects/lib/personal-resources';
import type { ConnectorPrincipal } from './router-contract';
import { resolveShareSubject } from './share';
import { isUuid } from './db-deps-rows';
import {
  projectSessionIdForProjectPrincipal,
  resolveTokenBoundSessionId,
  resolveTokenPrincipal,
  sessionChannelConnectorSlugs,
} from './db-deps-principal';
import { bearerToken } from '../shared/bearer-token';

/** The connector router's request authorizers: each reads who is calling from the Hono request. */
export interface ConnectorRouterAuth {
  /** Gateway auth: resolve the connector token → principal, or null for 401. */
  resolvePrincipal(c: Context): Promise<ConnectorPrincipal | null>;
  /**
   * Gateway auth for the project-EXPLICIT routes (/projects/:id/{catalog,call}).
   * Runs under combinedAuth; accepts ANY valid principal (session token OR a
   * logged-in user token) and pins the project from the path. Null → 403.
   */
  resolveProjectPrincipal(c: Context, projectId: string): Promise<ConnectorPrincipal | null>;
  /** Admin auth: resolve user + verify project access, or null for 401/403. */
  resolveAdmin(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /** Read-tier auth for the connectors LIST: `project.connector.read` is in the
   *  member baseline (the Connectors/Channels rail sections gate on it), so the
   *  list must not require connector.write like the mutations do. Falls back to
   *  resolveAdmin when a deps implementation doesn't provide it. */
  resolveReader?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /** Read-tier authorization for exact project secret identifiers. */
  resolveSecretReader?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /** Secret binding requires both connector-write and secret-write. */
  resolveSecretBindingAdmin?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
  /**
   * Does this caller hold the connections-manage capability on the project?
   * The same gate the project-owned connection create (routes/connections.ts) asserts — connecting an
   * account the WHOLE project can then use is administration, not self-service.
   */
  resolveConnectionsManager?(
    c: Context,
    projectId: string,
  ): Promise<{ accountId: string; userId: string } | null>;
}

export async function resolvePrincipal(c: Context): Promise<ConnectorPrincipal | null> {
  const header = c.req.header('Authorization');
  const token = bearerToken(header);
  if (!token) return null;
  return resolveTokenPrincipal(token, c.req.header('X-Kortix-Session-Id') ?? null);
}

/**
 * Principal for the project-EXPLICIT gateway routes (/connectors/projects/:id/*).
 * These run under combinedAuth, so identity is already validated and sits in the
 * context; the project comes from the PATH. Works for BOTH a project-scoped
 * session token (enforceTokenProjectScope already pinned it to this project) AND
 * a logged-in user token (verified to be a project member here). This is the
 * unlock for using the Connector locally: same gateway, same authz, any principal.
 */
export async function resolveProjectPrincipal(
  c: Context,
  projectId: string,
): Promise<ConnectorPrincipal | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const tokenProjectId = c.get('tokenProjectId') as string | undefined;
  let accountId = c.get('accountId') as string | undefined;

  if (tokenProjectId) {
    // Project-scoped (session) token: enforceTokenProjectScope already guaranteed
    // tokenProjectId === the URL project at the auth layer. Re-check defensively,
    // then bind the token account to the actual project account. This prevents a
    // PAT row from one account from being labeled with another account's project
    // id and then used on the project-explicit Connector gateway.
    if (tokenProjectId !== projectId) return null;
    const [project] = await db
      .select({ accountId: projects.accountId })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project || !accountId || project.accountId !== accountId) return null;
    accountId = project.accountId;
  } else {
    // User token (PAT/JWT, no pinned project): verify project access. Throws 403
    // if the user isn't a member — treat that as an unauthorized principal.
    try {
      const access = await loadProjectForUser(c, projectId, 'read');
      if (!access?.row) return null;
      accountId = access.row.accountId; // the PROJECT's account owns its connectors
    } catch (err) {
      if (err instanceof HTTPException && err.status === 403) return null;
      throw err;
    }
  }
  if (!accountId) return null;
  const sessionIdentity = resolveTokenBoundSessionId(
    projectSessionIdForProjectPrincipal(tokenProjectId, c.get('sessionId') as string | undefined),
    c.req.header('X-Kortix-Session-Id') ?? null,
  );
  if (!sessionIdentity.ok) return null;

  const storedAgentGrant = (c.get('agentGrant') as ConnectorPrincipal['agentGrant']) ?? null;
  const [agentGrant, channelConnectorSlugs] = await Promise.all([
    sessionIdentity.sessionId
      ? reconcileStoredSessionAgentGrant({
          projectId,
          sessionId: sessionIdentity.sessionId,
          // The auth middleware just validated the token row and put its
          // (already normalized) grant here — the same row the reconcile
          // would otherwise re-read by session id.
          storedGrant: storedAgentGrant,
        })
      : Promise.resolve(storedAgentGrant),
    sessionChannelConnectorSlugs(projectId, sessionIdentity.sessionId),
  ]);

  const tokenId = (c.get('iamTokenId') as string | undefined) ?? null;
  return {
    userId,
    accountId,
    projectId,
    sessionId: sessionIdentity.sessionId,
    tokenId,
    subject: await resolveShareSubject(userId),
    agentGrant,
    channelConnectorSlugs,
    // Only a project-scoped (session) token can be an agent principal; a
    // human JWT/PAT keeps the legacy rule. The fresh on_behalf_of comes from
    // the auth middleware, so a clear by a foreign prompt applies at once.
    agentPrincipal: tokenProjectId
      ? await tokenAgentPrincipalScope({
          projectId,
          tokenId,
          agentGrant,
          onBehalfOfUserId: getRequestOnBehalfOf(c),
        })
      : null,
  };
}

async function resolveProjectUserWith(
  c: Context,
  projectId: string,
  action:
    | typeof PROJECT_ACTIONS.PROJECT_CONNECTOR_READ
    | typeof PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE
    | typeof PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE
    | typeof PROJECT_ACTIONS.PROJECT_SECRET_READ
    | typeof PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
): Promise<{ accountId: string; userId: string } | null> {
  if (!isUuid(projectId)) return null;
  const userId = c.get('userId') as string | undefined;
  if (!userId) return null;
  const [proj] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!proj) return null;
  // The acting credential comes with the Actor, so the agent-grant fold and the
  // token project-scope check fire by construction: a scoped agent-session token
  // must actually hold the leaf, and a custom role can withhold it from humans.
  const decision = await authorize(await actorOf(c, proj.accountId), action, {
    type: 'project',
    id: projectId,
  });
  if (!decision.allowed) return null;
  return { accountId: proj.accountId, userId };
}

// Connector administration (create/delete connectors, write shared credentials,
// grants/policies) is project.connector.write — NOT the coarse, fold-exempt
// project.write.
export async function resolveAdmin(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);
}

// Connecting an account the whole project can use is administration, and this
// is the SAME capability the project-owned connection create (routes/connections.ts) asserts.
export async function resolveConnectionsManager(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(
    c,
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
  );
}

export async function resolveSecretBindingAdmin(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  const connectorAdmin = await resolveProjectUserWith(
    c,
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE,
  );
  if (!connectorAdmin) return null;
  const secretAdmin = await resolveProjectUserWith(
    c,
    projectId,
    PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
  );
  return secretAdmin ? connectorAdmin : null;
}

// The connectors LIST is read-tier: project.connector.read is in the member
// baseline (the Connectors/Channels rail sections gate visibility on it), so a
// plain member can see which connectors exist and their status. The list never
// carries credential values — only whether one is set.
export async function resolveReader(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);
}

export async function resolveSecretReader(
  c: Context,
  projectId: string,
): Promise<{ accountId: string; userId: string } | null> {
  return resolveProjectUserWith(c, projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);
}
