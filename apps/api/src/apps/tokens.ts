/**
 * Kortix sign-in tokens for Apps: one issuer per project, any App as audience.
 *
 *   issuer    <public API origin>/v1/projects/<project id>
 *   discovery <issuer>/.well-known/openid-configuration → <issuer>/jwks.json (./token-issuer-routes.ts)
 *   audience  the id of the App the token is for
 *   lifetime  TOKEN_TTL_SECONDS (15 min)
 *
 * One ES256 key per project (`project_signing_keys`), created on first use and
 * sealed with the project secret envelope. Kortix mints a token for a member
 * (POST /v1/projects/:projectId/apps/:appId/token) or for the viewer of an App
 * (`/_kortix/token?audience=<slug|id>` on its host, for itself or an App it
 * uses). A verifier needs only the three public values of `authEnv`: a Convex
 * App gets them in its environment (`convex/auth.config.ts` `customJwt`), any
 * other server reads them from the App (`auth`) or discovers the key set from
 * the token's `iss`.
 *
 * Claims: `sub` (Kortix user id), `email`, `name`, `picture`, `groups` (group
 * names in the account), `group_ids`, `role` (account role), `account_id`,
 * `project_id`. A token for an agent session names the agent's service account,
 * carries `kind: "agent"`, no role and no groups.
 *
 * Fifteen minutes: a token already handed out keeps working until it expires,
 * so its lifetime is how long a removed member can still reach an App. Clients
 * refresh it before expiry.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { projectSigningKeys, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { oauthIssuer } from '../oauth/discovery';
import { db } from '../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from '../projects/surface';

export const TOKEN_TTL_SECONDS = 15 * 60;

export const TOKEN_CLAIMS = [
  'iss', 'aud', 'sub', 'iat', 'exp', 'email', 'name', 'picture', 'groups', 'group_ids', 'role', 'account_id', 'project_id', 'kind',
] as const;

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export interface ProjectSigner {
  kid: string;
  privatePem: string;
}

/** The issuer of a project's tokens, from the configured public API origin (KORTIX_URL). */
export function projectIssuer(projectId: string): string {
  return `${oauthIssuer()}/v1/projects/${projectId}`;
}

/** Whether the project exists (the public issuer routes answer 404 otherwise). */
export async function projectExists(projectId: string): Promise<boolean> {
  const [row] = await db.select({ projectId: projects.projectId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return Boolean(row);
}

/** A fresh signer: an ES256 private key (PKCS#8 PEM) and a random key id. */
export function generateSigner(): ProjectSigner {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid: `kortix-${randomBytes(8).toString('hex')}`, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

// replica-local: a read-through cache of immutable rows. A project's key never
// changes (no rotation yet), so every replica caching its own copy is safe.
// ponytail: unbounded, one small entry per project that signed on this replica;
// evict on rotation once rotation exists.
const signers = new Map<string, ProjectSigner>();

/** The project's signer, or null before its first token. Never writes. */
export async function existingProjectSigner(projectId: string): Promise<ProjectSigner | null> {
  const cached = signers.get(projectId);
  if (cached) return cached;
  const [row] = await db
    .select({ kid: projectSigningKeys.kid, privateKeyEnc: projectSigningKeys.privateKeyEnc })
    .from(projectSigningKeys)
    .where(eq(projectSigningKeys.projectId, projectId))
    .limit(1);
  if (!row) return null;
  const signer = { kid: row.kid, privatePem: decryptProjectSecret(projectId, row.privateKeyEnc) };
  signers.set(projectId, signer);
  return signer;
}

/** The project's signer; creates it on first use (concurrent creators converge on one row). */
export async function projectSigner(projectId: string): Promise<ProjectSigner> {
  const existing = await existingProjectSigner(projectId);
  if (existing) return existing;
  const fresh = generateSigner();
  await db
    .insert(projectSigningKeys)
    .values({ projectId, kid: fresh.kid, privateKeyEnc: encryptProjectSecret(projectId, fresh.privatePem) })
    .onConflictDoNothing();
  const signer = await existingProjectSigner(projectId);
  if (!signer) throw new Error(`project ${projectId} has no signing key`);
  return signer;
}

/** The public half of the signer, as a JSON Web Key Set; empty before the project's first token. */
export function signerJwks(signer: ProjectSigner | null): { keys: Array<Record<string, unknown>> } {
  if (!signer) return { keys: [] };
  const jwk = createPublicKey(createPrivateKey(signer.privatePem)).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: signer.kid, alg: 'ES256', use: 'sig' }] };
}

/** OpenID Provider metadata for verifiers only: there is no authorization endpoint. */
export function openIdConfiguration(issuer: string) {
  return {
    issuer,
    jwks_uri: `${issuer}/jwks.json`,
    id_token_signing_alg_values_supported: ['ES256'],
    subject_types_supported: ['public'],
    response_types_supported: ['id_token'],
    claims_supported: [...TOKEN_CLAIMS],
  };
}

/** The three values that verify tokens for `audience`: KORTIX_AUTH_ISSUER, _AUDIENCE, _JWKS (a data URI). */
export function authEnv(issuer: string, audience: string, signer: ProjectSigner) {
  const jwks = JSON.stringify(signerJwks(signer));
  return {
    KORTIX_AUTH_ISSUER: issuer,
    KORTIX_AUTH_AUDIENCE: audience,
    KORTIX_AUTH_JWKS: `data:text/plain;charset=utf-8;base64,${Buffer.from(jwks).toString('base64')}`,
  };
}

export interface TokenSubject {
  userId: string;
  email: string | null;
  name?: string | null;
  picture?: string | null;
  /** Group names in the account. */
  groups?: string[];
  groupIds?: string[];
  /** Account role. */
  role?: string | null;
  /** `agent` when the subject is an agent's service account, not a person. */
  kind?: 'agent';
}

export interface TokenTarget {
  /** The App the token is for (`aud`). */
  audience: string;
  issuer: string;
  accountId: string;
  projectId: string;
}

/** A JWT signed by `signer`, valid for TOKEN_TTL_SECONDS. */
export function signToken(
  signer: ProjectSigner,
  target: TokenTarget,
  subject: TokenSubject,
  now = Math.floor(Date.now() / 1000),
): { token: string; expiresAt: Date } {
  const exp = now + TOKEN_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: signer.kid }));
  const payload = b64url(
    JSON.stringify({
      iss: target.issuer,
      aud: target.audience,
      sub: subject.userId,
      iat: now,
      exp,
      ...(subject.email ? { email: subject.email } : {}),
      ...(subject.name ? { name: subject.name } : {}),
      ...(subject.picture ? { picture: subject.picture } : {}),
      groups: subject.groups ?? [],
      group_ids: subject.groupIds ?? [],
      ...(subject.role ? { role: subject.role } : {}),
      account_id: target.accountId,
      project_id: target.projectId,
      ...(subject.kind ? { kind: subject.kind } : {}),
    }),
  );
  // JOSE wants the raw r||s signature, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(signer.privatePem),
    dsaEncoding: 'ieee-p1363',
  });
  return { token: `${header}.${payload}.${b64url(signature)}`, expiresAt: new Date(exp * 1000) };
}

/** A token for `app`'s project issuer with `app` as the audience. */
export async function mintAppToken(
  app: { appId: string; projectId: string; accountId: string },
  subject: TokenSubject,
): Promise<{ token: string; expiresAt: Date }> {
  const signer = await projectSigner(app.projectId);
  return signToken(
    signer,
    { audience: app.appId, issuer: projectIssuer(app.projectId), accountId: app.accountId, projectId: app.projectId },
    subject,
  );
}

/** The public values that verify tokens for `app` (an App response's `auth`). */
export async function appAuthEnv(app: { appId: string; projectId: string }) {
  return authEnv(projectIssuer(app.projectId), app.appId, await projectSigner(app.projectId));
}
