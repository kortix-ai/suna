import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Rejects sandbox-agent tokens (the `kortix_` API keys an agent runs with
 * inside ONE project/session sandbox) from account-scoped read routes they
 * have no legitimate reason to hit.
 *
 * Why this exists: `combinedAuth` accepts sandbox `kortix_` tokens and sets
 * `authType: 'apiKey'` + `accountId` + `sandboxId`. Routes that scope only by
 * `accountId` (e.g. `/v1/usage`, `/v1/generation`) would otherwise let a
 * sandbox agent read the ENTIRE account's usage/cost rollup and per-call
 * gateway forensics across every project/session on that account — a
 * cross-project info leak on multi-user accounts. Found by Strix (MEDIUM)
 * on the v0.10.11 release PR.
 *
 * What passes through unchanged: PATs (`authType: 'pat'`), service accounts
 * (`'service_account'`), and Supabase sessions (`'supabase'`). A non-sandbox
 * `kortix_` API key (no `sandboxId`) is also allowed — those are operator
 * account keys, not agent tokens. Only `authType === 'apiKey'` WITH a
 * `sandboxId` is blocked.
 *
 * MUST run AFTER `combinedAuth` (it reads context `combinedAuth` populates).
 */
export async function rejectSandboxTokens(c: Context, next: Next) {
  if (c.get('authType') === 'apiKey' && c.get('sandboxId')) {
    throw new HTTPException(403, {
      message: 'Sandbox tokens cannot access account-scoped read endpoints',
    });
  }
  await next();
}
