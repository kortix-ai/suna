/**
 * Kortix sign-in for Backends.
 *
 * Every backend gets its own ES256 key at provision. Kortix signs short-lived
 * JWTs with it for a signed-in member (an App viewer, or a caller of the token
 * route), and writes the public key into the backend's own environment, so the
 * Convex `customJwt` provider verifies tokens with no network fetch:
 *
 *   // convex/auth.config.ts
 *   export default { providers: [{
 *     type: "customJwt",
 *     issuer: process.env.KORTIX_AUTH_ISSUER!,
 *     applicationID: process.env.KORTIX_AUTH_AUDIENCE!,
 *     jwks: process.env.KORTIX_AUTH_JWKS!,
 *     algorithm: "ES256",
 *   }] };
 *
 * Inside a function, `ctx.auth.getUserIdentity()` then names the member, and
 * `requireKortixMember` from `@kortix/sdk` reads it: `sub` (Kortix user id),
 * `email`, `name`, `picture`, `groups` (names in the account), `group_ids`,
 * `role` (account role), `account_id`, `project_id`. Any other server verifies
 * the same token with `verifyKortixMemberToken` and the KORTIX_AUTH_* env.
 *
 * Fifteen minutes: the App gate re-checks access on every page load, but a
 * token already handed out keeps working until it expires, so its lifetime is
 * how long a removed member can still reach the backend. Clients refresh it
 * before expiry without the viewer noticing.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

export const BACKEND_TOKEN_TTL_SECONDS = 15 * 60;

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** A fresh ES256 private key, PKCS#8 PEM. */
export function generateBackendAuthKey(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function keyId(backendId: string): string {
  return `kortix-backend-${backendId}`;
}

/**
 * The issuer a backend's tokens carry. Compared as a string only (the JWKS is
 * inline), so it must never move: an issuer built from KORTIX_URL would break
 * every backend the day that URL changes.
 */
export function backendIssuer(backendId: string): string {
  return `https://kortix.com/backends/${backendId}`;
}

/** The three variables the backend's `auth.config.ts` reads. */
export function backendAuthEnv(backendId: string, privatePem: string): Record<string, string> {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: 'jwk' });
  const jwks = JSON.stringify({ keys: [{ ...jwk, kid: keyId(backendId), alg: 'ES256', use: 'sig' }] });
  return {
    KORTIX_AUTH_ISSUER: backendIssuer(backendId),
    KORTIX_AUTH_AUDIENCE: backendId,
    KORTIX_AUTH_JWKS: `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString('base64')}`,
  };
}

export interface BackendTokenSubject {
  userId: string;
  email: string | null;
  name?: string | null;
  picture?: string | null;
  /** Group names in the backend's account. */
  groups?: string[];
  groupIds?: string[];
  /** Account role. */
  role?: string | null;
  accountId?: string | null;
  projectId?: string | null;
}

/** A JWT the backend accepts for this member, valid for BACKEND_TOKEN_TTL_SECONDS. */
export function mintBackendToken(
  backendId: string,
  privatePem: string,
  subject: BackendTokenSubject,
  now = Math.floor(Date.now() / 1000),
): { token: string; expiresAt: Date } {
  const exp = now + BACKEND_TOKEN_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: keyId(backendId) }));
  const payload = b64url(
    JSON.stringify({
      iss: backendIssuer(backendId),
      aud: backendId,
      sub: subject.userId,
      iat: now,
      exp,
      ...(subject.email ? { email: subject.email } : {}),
      ...(subject.name ? { name: subject.name } : {}),
      ...(subject.picture ? { picture: subject.picture } : {}),
      groups: subject.groups ?? [],
      group_ids: subject.groupIds ?? [],
      ...(subject.role ? { role: subject.role } : {}),
      ...(subject.accountId ? { account_id: subject.accountId } : {}),
      ...(subject.projectId ? { project_id: subject.projectId } : {}),
    }),
  );
  // JOSE wants the raw r||s signature, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(privatePem),
    dsaEncoding: 'ieee-p1363',
  });
  return { token: `${header}.${payload}.${b64url(signature)}`, expiresAt: new Date(exp * 1000) };
}

/** Sets deployment environment variables through the backend's admin API (what `npx convex env set` calls). */
export async function setBackendEnv(url: string, adminKey: string, env: Record<string, string>): Promise<void> {
  const res = await fetch(`${url}/api/update_environment_variables`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Convex ${adminKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes: Object.entries(env).map(([name, value]) => ({ name, value })) }),
  });
  if (!res.ok) throw new Error(`setting backend environment failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
