/**
 * Audit attribution for the Kortix Git proxy (`/v1/git/*`).
 *
 * The proxy authenticates its own git Basic/Bearer credential, so the auth
 * middleware never sees an identity here. It used to write its own row per
 * clone and push; it now writes INTO the request's audit scope and the server
 * edge writes the one row (shared/audit-scope.ts):
 *
 *   - `bindGitProxyPrincipal` — called by the proxy's authenticator the moment
 *     the credential is proven, so EVERY git request is attributed: ref
 *     discovery, upload-pack, receive-pack, and a refused attempt too.
 *   - `annotateGitTransfer` — names the transfer on its row:
 *       git.clone  POST git-upload-pack (clone and fetch)
 *       git.push   POST git-receive-pack, with every ref update (ref, old → new
 *                  sha, create|update|delete) and, when refused, the reason
 *                  per ref.
 *
 * Attribution follows spec docs/specs/2026-09-22-agents-as-principals.md §2:
 * a session credential names the agent, the human it acts on behalf of, and
 * the initiator (shared/agent-audit-attribution.ts, resolved when the row is
 * written); a person names the user; a monitor box or an account API key is
 * `system`.
 */
import type { GitPrincipal } from './ref-policy';
import type { RefUpdate } from './receive-pack';
import { isCreate, isDelete } from './receive-pack';
import type { ProjectRow } from '../projects/lib/serializers';
import { loadTokenBinding } from '../iam/actor';
import { agentPrincipalModeFor } from '../iam/agent-principal';
import type { AuditActorType, AuditOutcome } from '../shared/audit';
import { annotateAuditEvent, bindAuditPrincipal } from '../shared/audit-scope';
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

/**
 * Record who is calling, in the request's audit scope. Called by the proxy's
 * authenticator on success (memoized or not). A session's on-behalf-of human
 * needs a token-binding lookup; it is resolved when the row is written, never
 * on the git request path.
 */
export function bindGitProxyPrincipal(principal: GitPrincipal, project: ProjectRow): void {
  const envelope = gitPrincipalEnvelope(principal);
  const tokenId = 'tokenId' in principal ? principal.tokenId : null;
  bindAuditPrincipal({
    accountId: project.accountId,
    projectId: project.projectId,
    sessionId: envelope.sessionId,
    actorType: envelope.actorType,
    actorUserId: envelope.actorUserId,
    authoritativeSource: envelope.source,
    authMethod: {
      kind: 'git',
      principal: principal.kind,
      ...(tokenId ? { token_id: tokenId } : {}),
    },
    lateAttribution:
      principal.kind === 'session'
        ? async () => {
            const agent = await resolveGitPrincipalAttribution(principal, project.projectId);
            return agent
              ? {
                  actorUserId: agent.actorUserId,
                  agentId: agent.agentId,
                  agentName: agent.agentName,
                  onBehalfOfUserId: agent.onBehalfOfUserId,
                  initiatorActorType: agent.initiatorActorType,
                  initiatorActorId: agent.initiatorActorId,
                }
              : null;
          }
        : undefined,
  });
}

/** Name a clone or push on its request's row, with the refs a push moved. */
export function annotateGitTransfer(input: {
  action: GitAuditAction;
  projectId: string;
  outcome: AuditOutcome;
  refs?: GitRefAuditEntry[];
}): void {
  annotateAuditEvent({
    action: input.action,
    resourceType: 'git_repository',
    resourceId: input.projectId,
    outcome: input.outcome,
    metadata: {
      via: 'git_proxy',
      ...(input.refs ? { refs: input.refs } : {}),
    },
  });
}
