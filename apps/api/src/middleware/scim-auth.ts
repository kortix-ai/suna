// Authentication for /scim/v2/* endpoints. The protocol uses long-lived
// bearer tokens minted by the account admin and configured in the IdP
// (Okta, Azure AD, JumpCloud, etc.). The token implies the account — its
// account_id is set on the context for downstream handlers.
//
// SCIM error responses MUST follow the SCIM 2.0 envelope (RFC 7644 §3.12):
//   { schemas: [...], status: "401", detail: "..." }
// We don't use Hono's HTTPException here so we can return that exact shape.

import type { Context, Next } from 'hono';
import { validateScimToken } from '../repositories/scim';

const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

function scimError(c: Context, status: number, detail: string) {
  return c.json(
    { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail },
    status as 400 | 401 | 403 | 404 | 409 | 500,
  );
}

export async function scimAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return scimError(c, 401, 'Missing or malformed Authorization header');
  }
  const token = authHeader.slice(7).trim();
  if (!token) return scimError(c, 401, 'Empty bearer token');

  const result = await validateScimToken(token);
  if (!result.ok || !result.accountId) {
    return scimError(c, 401, `Invalid SCIM token (${result.reason ?? 'unknown'})`);
  }

  // The URL also carries an accountId; refuse if the token is for a
  // different account. Prevents cross-tenant access via a leaked token
  // probing other accounts' SCIM endpoints.
  const urlAccountId = c.req.param('accountId');
  if (urlAccountId && urlAccountId !== result.accountId) {
    return scimError(
      c,
      403,
      'SCIM token does not match the account in the URL',
    );
  }

  c.set('scimTokenId', result.tokenId);
  c.set('scimAccountId', result.accountId);
  // Also set the standard accountId key so any helpers that read it
  // (audit, IAM probes) work transparently.
  c.set('accountId', result.accountId);
  await next();
}

export { scimError };
