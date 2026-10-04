/**
 * Who is calling the connector router: the request authorizers. They read the
 * Hono request (the bearer, the auth middleware's identity, the project in the
 * path) and hand plain values to `services/connectors/db-deps-principal.ts`.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { authorize, PROJECT_ACTIONS } from '../../services/iam';
import {
  connectorProjectAccountId,
  projectPrincipalFor,
  resolveTokenPrincipal,
} from '../../services/connectors/db-deps-principal';
import { isUuid } from '../../services/connectors/db-deps-rows';
import type { ConnectorPrincipal, ConnectorServiceDeps } from '../../services/connectors/router-contract';
import { getRequestOnBehalfOf } from '../lib/agent-scope';
import { loadProjectForUser } from '../lib/project-access';
import { actorOf } from '../middleware/actor';

/** The connector router's request authorizers. */
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

/** Everything the connector router is built against. */
export interface ConnectorRouterDeps extends ConnectorServiceDeps, ConnectorRouterAuth {}

export async function resolvePrincipal(c: Context): Promise<ConnectorPrincipal | null> {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
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
    const projectAccountId = await connectorProjectAccountId(projectId);
    if (!projectAccountId || !accountId || projectAccountId !== accountId) return null;
    accountId = projectAccountId;
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
  return projectPrincipalFor({
    userId,
    accountId,
    projectId,
    tokenProjectId,
    contextualSessionId: c.get('sessionId') as string | undefined,
    requestedSessionId: c.req.header('X-Kortix-Session-Id') ?? null,
    storedAgentGrant: (c.get('agentGrant') as ConnectorPrincipal['agentGrant']) ?? null,
    tokenId: (c.get('iamTokenId') as string | undefined) ?? null,
    onBehalfOfUserId: getRequestOnBehalfOf(c),
  });
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
  const projectAccountId = await connectorProjectAccountId(projectId);
  if (!projectAccountId) return null;
  // The acting credential comes with the Actor, so the agent-grant fold and the
  // token project-scope check fire by construction: a scoped agent-session token
  // must actually hold the leaf, and a custom role can withhold it from humans.
  const decision = await authorize(await actorOf(c, projectAccountId), action, {
    type: 'project',
    id: projectId,
  });
  if (!decision.allowed) return null;
  return { accountId: projectAccountId, userId };
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

/** The DB-backed request authorizers production wires into the connector router. */
export const dbConnectorRouterAuth: ConnectorRouterAuth = {
  resolvePrincipal,
  resolveProjectPrincipal,
  resolveAdmin,
  resolveConnectionsManager,
  resolveReader,
  resolveSecretReader,
  resolveSecretBindingAdmin,
};
