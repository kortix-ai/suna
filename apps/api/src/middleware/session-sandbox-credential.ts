import type { Context } from 'hono';

/**
 * True only for a credential bound to the current sandbox session.
 *
 * The `apiKey` branch keeps old `kortix_sb_` sandboxes alive during rollout.
 * New sandboxes use one session-scoped PAT, exposed through `sessionId` and
 * `sandboxId` by auth middleware.
 */
export function isSessionSandboxCredential(c: Context): boolean {
  const sandboxId = c.get('sandboxId') as string | undefined;
  if (!sandboxId) return false;
  if (c.get('authType') === 'apiKey' && c.get('apiKeyType') === 'sandbox') return true;
  const sessionId = c.get('sessionId') as string | undefined;
  return c.get('authType') === 'pat' && Boolean(sessionId) && sessionId === sandboxId;
}
