/**
 * Audit attribution for preview traffic: preview subdomains, the PTY terminal
 * WebSocket, and preview-origin WebSockets.
 *
 * All of it is dispatched by `Bun.serve.fetch` before Hono, so no auth
 * middleware names the caller. Two things do, and both bind here:
 *
 *  - `preview-auth.ts`, the moment a token is proven — so a refused attempt is
 *    still attributed;
 *  - the signed preview cookie, on every later request — a page load is
 *    hundreds of those, and none of them re-validates the token.
 *
 * The SANDBOX is the resource, and its owner's account owns the row (resolved
 * when the row is written, cached): an attempt on someone's preview belongs
 * in their log, not the caller's.
 */
import { type AuditPrincipal, annotateAuditEvent, bindAuditPrincipal } from '../shared/audit-scope';
import type { PreviewPrincipalKind, PreviewSession } from './preview-session';

/** The audit actor for a proven preview principal. Pure; exported for tests. */
export function previewActorFields(input: {
  kind?: PreviewPrincipalKind;
  principalId: string;
  sandboxAuthored: boolean;
  /** How it authenticated: `jwt`, `account_token`, `api_key`, `preview_session`, … */
  method: string;
  callerSessionId?: string | null;
}): AuditPrincipal {
  if (input.sandboxAuthored) {
    // The sandbox calling its own preview (its session-bound token). An agent,
    // whichever user minted the token.
    return {
      actorType: 'agent',
      actorUserId: null,
      authoritativeSource: 'agent',
      authMethod: {
        kind: input.method,
        principal_id: input.principalId,
        ...(input.callerSessionId ? { session_id: input.callerSessionId } : {}),
      },
    };
  }
  switch (input.kind) {
    case 'user':
      return {
        actorType: 'human',
        actorUserId: input.principalId,
        authoritativeSource: 'human',
        authMethod: { kind: input.method },
      };
    case 'service_account':
      return {
        actorType: 'service_account',
        actorUserId: null,
        authoritativeSource: 'automation',
        authMethod: { kind: input.method, service_account_id: input.principalId },
      };
    case 'account':
      return {
        actorType: 'system',
        actorUserId: null,
        authoritativeSource: 'api_key',
        authMethod: { kind: input.method },
      };
    default:
      // A cookie minted before the kind was recorded: the id could be a user,
      // a service account or an account. Name it; assert nothing.
      return { authMethod: { kind: input.method, principal_id: input.principalId } };
  }
}

/** Name the caller a preview cookie carries. */
export function bindPreviewSession(session: PreviewSession): void {
  if (session.kind === 'public_share') {
    bindAuditPrincipal({
      actorType: 'anonymous',
      actorUserId: null,
      authoritativeSource: 'public_share',
      authMethod: { kind: 'public_share', share_id: session.shareId },
    });
    return;
  }
  bindAuditPrincipal(
    previewActorFields({
      kind: session.principalKind,
      principalId: session.userId,
      sandboxAuthored: session.sandboxAuthored,
      method: 'preview_session',
      callerSessionId: session.callerSessionId,
    }),
  );
}

/**
 * The sandbox a preview request reached. Its owner's account and project are
 * resolved when the row is written, never on the request path.
 */
export function bindPreviewResource(sandboxId: string, port: number | null): void {
  annotateAuditEvent({
    resourceType: 'sandbox_preview_origin',
    resourceId: sandboxId,
    metadata: port ? { port } : {},
  });
  bindAuditPrincipal({
    lateAttribution: async () => {
      // Imported here, not at module load: preview-origin's suite replaces
      // `../config` wholesale, and this module pulls the database client in.
      const { resolveSandboxOwner } = await import('../shared/preview-ownership');
      const owner = await resolveSandboxOwner(sandboxId);
      return owner ? { accountId: owner.accountId, projectId: owner.projectId } : null;
    },
  });
}
