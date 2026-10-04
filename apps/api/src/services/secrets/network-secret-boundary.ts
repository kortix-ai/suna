import { isMetaAgentName } from '@kortix/shared';

import { resolveNetworkBoundaryBindings } from './network-boundary';
import { DEFAULT_AGENT_SENTINEL } from '../projects/agents';
import { intersectSecretGrants, listResolvedProjectSecrets } from './secrets';
import { secretAudienceSubject, type SecretAudienceSubject } from './secret-audience';
import { loadSessionSecretContext, type SessionSecretContext } from '../sessions/session-secret-context';

/**
 * What a session's sandbox may hold, before delivery: every value its subject
 * reaches, narrowed to the running agent's `secrets` grant and the session
 * allowlist. Shared by the network-boundary bindings and the share guard
 * (secret-audience.ts `sessionPersonOnlyPlaintextSecrets`).
 */
async function loadSessionSecretRows(
  projectId: string,
  sessionId: string,
  subject: SecretAudienceSubject | (() => Promise<SecretAudienceSubject>),
  requestedAgent?: string | null,
  /** `assume_all`: an unreadable grant counts as admitting every secret — the
   *  share guard's fail-closed reading. Default: the error propagates. */
  onGrantError: 'throw' | 'assume_all' = 'throw',
  /** The session's secret context, when the caller already started the read. */
  context: Promise<SessionSecretContext> = loadSessionSecretContext(projectId, sessionId, requestedAgent),
) {
  const { session, project, grantEnv, personalUserId: personalOwner } = await context;
  if (!session || !project) return null;
  const sessionAgent = session.agentName ?? DEFAULT_AGENT_SENTINEL;
  if (isMetaAgentName(sessionAgent)) return null;

  // The owner read needs nothing from the grant: it starts beside it.
  const ownerRead = personalOwner();
  const agentGrantEnv = await grantEnv().catch((error: unknown) => {
    if (onGrantError === 'assume_all') return 'all' as const;
    throw error;
  });
  const personalUserId = await ownerRead;
  const rows = await listResolvedProjectSecrets(projectId, personalUserId, subject);
  return { rows, session, agentGrantEnv };
}

export async function resolveSessionNetworkBoundary(
  projectId: string,
  sessionId: string,
  requestedAgent?: string | null,
  context?: Promise<SessionSecretContext>,
) {
  const loaded = await loadSessionSecretRows(
    projectId,
    sessionId,
    () => secretAudienceSubject({ projectId, sessionId }),
    requestedAgent,
    'throw',
    context,
  );
  if (!loaded) return [];
  return resolveNetworkBoundaryBindings(loaded.rows, {
    sessionId,
    agentGrantEnv: loaded.agentGrantEnv ?? null,
    sessionAllowlist: loaded.session.secretsAllowlist ?? null,
  });
}

/** The rows the session's grant and allowlist admit, resolved for `subject`. */
export async function listSessionDeliveredSecretRows(
  projectId: string,
  sessionId: string,
  subject: SecretAudienceSubject,
) {
  const loaded = await loadSessionSecretRows(projectId, sessionId, subject, null, 'assume_all');
  if (!loaded) return [];
  const admitted = intersectSecretGrants(loaded.agentGrantEnv, loaded.session.secretsAllowlist ?? null);
  if (admitted === undefined || admitted === 'all') return loaded.rows;
  const allowed = new Set(admitted.map((identifier) => identifier.toUpperCase()));
  return loaded.rows.filter((row) => allowed.has(row.identifier.toUpperCase()));
}
