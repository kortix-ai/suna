import type { Context } from 'hono';

export type SessionRuntimeKind = 'worker' | 'environment';

export interface SessionRuntimeCredential {
  kind: SessionRuntimeKind;
  runtimeId: string;
  sessionId: string;
}

/** Return the exact runtime principal carried by this request. */
export function getSessionRuntimeCredential(c: Context): SessionRuntimeCredential | null {
  const sandboxId = c.get('sandboxId') as string | undefined;
  if (!sandboxId) return null;

  if (c.get('authType') === 'apiKey' && c.get('apiKeyType') === 'sandbox') {
    return { kind: 'worker', runtimeId: sandboxId, sessionId: sandboxId };
  }
  if (c.get('authType') !== 'pat') return null;

  const sessionId = c.get('sessionId') as string | undefined;
  if (!sessionId) return null;
  const explicitKind = c.get('sessionRuntimeKind') as SessionRuntimeKind | undefined;
  return {
    kind: explicitKind ?? 'worker',
    runtimeId: sandboxId,
    sessionId,
  };
}

/**
 * True only for a credential bound to the current sandbox session.
 *
 * The `apiKey` branch keeps old `kortix_sb_` sandboxes alive during rollout.
 * New sandboxes use one session-scoped PAT, exposed through `sessionId` and
 * `sandboxId` by auth middleware.
 */
export function isSessionSandboxCredential(c: Context, kind?: SessionRuntimeKind): boolean {
  const credential = getSessionRuntimeCredential(c);
  return Boolean(credential && (!kind || credential.kind === kind));
}
