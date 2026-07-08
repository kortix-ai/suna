import { createAccountToken } from '../repositories/account-tokens';
import { upsertSubject } from './repository';
import { lockedSubjectGrant } from './session-scope';

/**
 * Mint a subject-scoped session token — the server-side operation an operator's BFF
 * calls to get a credential it can safely hand to an untrusted end-user's browser.
 *
 * Composition (all parts individually tested / typed):
 *   1. upsertSubject          — idempotently assert the external end-user.
 *   2. lockedSubjectGrant     — interact-only grant (no secrets, no CLI, no connectors).
 *   3. createAccountToken      — a real account_tokens row, backend_scoped + session-bound,
 *                                short-lived; its single-session boundary is enforced by
 *                                the auth middleware (checkSessionScope).
 *
 * The caller supplies an ALREADY-CREATED session id (the BFF ensures/creates the session
 * with an operator credential first). Wiring an HTTP route + session provisioning on top of
 * this — and the secret-less runtime for backend-mode sessions — is the next step tracked in
 * docs/specs/2026-07-08-kortix-as-a-backend-subject-identity.md (§2 Item 2/3).
 */
export interface MintSubjectSessionTokenParams {
  accountId: string;
  projectId: string;
  /** The operator/user id the token is attributed to for provenance (the launcher). */
  userId: string;
  /** The already-created session (sandbox) this token is bound to. */
  sessionId: string;
  /** The session's boot agent — carried through the locked grant for attribution. */
  agent: string;
  /** The operator's own id for this end-user (unique per project). */
  externalRef: string;
  displayName?: string | null;
  /** Token lifetime in seconds. Keep short (minutes); the BFF re-mints on refresh. */
  ttlSeconds?: number;
}

export interface MintSubjectSessionTokenResult {
  subjectId: string;
  sessionId: string;
  /** Plaintext token — returned ONCE. Hand to the end-user's browser; never log it. */
  token: string;
  expiresAt: Date;
}

const DEFAULT_TTL_SECONDS = 15 * 60;

export async function mintSubjectSessionToken(
  params: MintSubjectSessionTokenParams,
): Promise<MintSubjectSessionTokenResult> {
  const subject = await upsertSubject({
    accountId: params.accountId,
    projectId: params.projectId,
    externalRef: params.externalRef,
    displayName: params.displayName ?? null,
  });

  const ttl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  const created = await createAccountToken({
    accountId: params.accountId,
    userId: params.userId,
    name: `subject:${subject.externalRef}:${params.sessionId}`,
    projectId: params.projectId,
    sessionId: params.sessionId,
    agentGrant: lockedSubjectGrant(params.agent),
    subjectId: subject.subjectId,
    backendScoped: true,
    expiresAt,
  });

  return {
    subjectId: subject.subjectId,
    sessionId: params.sessionId,
    token: created.secretKey,
    expiresAt,
  };
}
