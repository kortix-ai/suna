/**
 * Audit rows for the Kortix Git proxy (`/v1/git/*`).
 *
 * The proxy authenticates its own git Basic/Bearer credential, so the API
 * request middleware (`auditApiRequest`) never sees an identity here and wrote
 * no row for a clone or a push. Every transfer now writes one canonical row:
 *
 *   git.clone  POST git-upload-pack  (clone and fetch; ref discovery is not a
 *              transfer and is not recorded)
 *   git.push   POST git-receive-pack, with every ref update (ref, old → new
 *              sha, create|update|delete) and, for a refused push, the reason
 *              per ref.
 *
 * Attribution follows spec docs/specs/2026-09-22-agents-as-principals.md §2:
 * a session credential names the agent, the human it acts on behalf of, and
 * the initiator (shared/agent-audit-attribution.ts); a person names the user;
 * a monitor box or an account API key is `system`.
 *
 * Best effort: an audit failure never fails the git operation.
 */
import type { GitPrincipal } from './ref-policy';
import type { RefUpdate } from './receive-pack';
import { isCreate, isDelete } from './receive-pack';
import type { ProjectRow } from '../projects/lib/serializers';
import { loadTokenBinding } from '../iam/actor';
import { agentPrincipalModeFor } from '../iam/agent-principal';
import { recordAuditEvent, type AuditActorType, type AuditOutcome } from '../shared/audit';
import { resolveAgentAuditAttribution, type AgentAuditAttribution } from '../shared/agent-audit-attribution';

export type GitAuditAction = 'git.clone' | 'git.push';

export interface GitRefAuditEntry {
  ref: string;
  old_sha: string;
  new_sha: string;
  kind: 'create' | 'update' | 'delete';
  /** Set only on a refused push: the reason git printed for this ref. */
  denied_reason?: string;
}

/** The ref list a push row records. Pure; exported for tests. */
export function gitPushRefSummary(
  updates: readonly RefUpdate[],
  denials: ReadonlyMap<string, string> = new Map(),
): GitRefAuditEntry[] {
  return updates.map((update) => {
    const entry: GitRefAuditEntry = {
      ref: update.ref,
      old_sha: update.oldSha,
      new_sha: update.newSha,
      kind: isCreate(update) ? 'create' : isDelete(update) ? 'delete' : 'update',
    };
    const reason = denials.get(update.ref);
    if (reason) entry.denied_reason = reason;
    return entry;
  });
}

/** Outcome of a proxied transfer from the upstream's HTTP status. Pure. */
export function gitAuditOutcome(status: number, refused: boolean): AuditOutcome {
  if (refused || status === 401 || status === 403) return 'denied';
  return status >= 200 && status < 300 ? 'success' : 'failure';
}

/**
 * The actor envelope for a git principal, before any agent lookup. Pure;
 * exported for tests. Session principals are completed by
 * `resolveGitPrincipalAttribution`.
 */
export function gitPrincipalEnvelope(principal: GitPrincipal): {
  actorType: AuditActorType;
  actorUserId: string | null;
  sessionId: string | null;
  source: string;
} {
  switch (principal.kind) {
    case 'session':
      return { actorType: 'agent', actorUserId: principal.userId ?? null, sessionId: principal.sessionId, source: 'agent' };
    case 'user':
      return principal.userId
        ? { actorType: 'human', actorUserId: principal.userId, sessionId: null, source: principal.tokenId ? 'api_key' : 'human' }
        : { actorType: 'system', actorUserId: null, sessionId: null, source: 'api_key' };
    case 'monitor':
      return { actorType: 'system', actorUserId: null, sessionId: null, source: 'monitor' };
    default:
      return { actorType: 'system', actorUserId: null, sessionId: null, source: 'system' };
  }
}

async function resolveGitPrincipalAttribution(
  principal: GitPrincipal,
  projectId: string,
): Promise<AgentAuditAttribution | null> {
  if (principal.kind !== 'session') return null;
  const binding = principal.tokenId ? await loadTokenBinding(principal.tokenId).catch(() => null) : null;
  const agentPrincipal = binding?.serviceAccountId
    ? await agentPrincipalModeFor(projectId, binding.agentGrant).catch(() => false)
    : false;
  return resolveAgentAuditAttribution({
    sessionId: principal.sessionId,
    serviceAccountId: binding?.serviceAccountId ?? null,
    agentName: binding?.agentGrant?.agent ?? null,
    agentPrincipal,
    tokenUserId: principal.userId ?? null,
    onBehalfOfUserId: binding?.onBehalfOfUserId ?? null,
  });
}

export async function recordGitProxyAudit(input: {
  action: GitAuditAction;
  project: ProjectRow;
  principal: GitPrincipal;
  httpStatus: number;
  outcome: AuditOutcome;
  refs?: GitRefAuditEntry[];
  durationMs?: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    const envelope = gitPrincipalEnvelope(input.principal);
    const agent = await resolveGitPrincipalAttribution(input.principal, input.project.projectId);
    await recordAuditEvent({
      accountId: input.project.accountId,
      projectId: input.project.projectId,
      sessionId: envelope.sessionId,
      actorType: envelope.actorType,
      actorUserId: agent ? agent.actorUserId : envelope.actorUserId,
      ...(agent
        ? {
            agentId: agent.agentId,
            agentName: agent.agentName,
            onBehalfOfUserId: agent.onBehalfOfUserId,
            initiatorActorType: agent.initiatorActorType,
            initiatorActorId: agent.initiatorActorId,
          }
        : {}),
      authoritativeSource: envelope.source,
      outcome: input.outcome,
      action: input.action,
      resourceType: 'git_repository',
      resourceId: input.project.projectId,
      httpStatus: input.httpStatus,
      durationMs: input.durationMs ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: {
        via: 'git_proxy',
        ...(input.refs ? { refs: input.refs } : {}),
      },
    });
  } catch (error) {
    console.warn('[git-proxy] audit write failed', {
      action: input.action,
      projectId: input.project.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
