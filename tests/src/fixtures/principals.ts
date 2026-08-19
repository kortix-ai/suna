/**
 * Principal matrix provisioning against a live target.
 *
 * Global principals (provisioned once per run): OWNER, NONMEMBER, PAT_ACCT, ANON.
 * Each gets a synthesized Supabase user (service-role admin create+confirm) and a
 * real JWT (password grant). Personal account_id == user_id, created lazily by the
 * API on first token/project call (verified empirically).
 *
 * Team-scoped principals (ADMIN, MEMBER, the M_ project roles, BILLING, AUDITOR,
 * RO_ADMIN, DENY_USER) are per-team-account, so they're provisioned by the
 * `team()` fixture inside the flows that exercise them — not globally.
 */
import { Client } from '../core/client';
import type { Env } from '../core/env';
import { log } from '../core/log';
import type { Principal, Principals } from '../core/types';
import { subscribe } from './billing';
import { adminCreateUser, adminDeleteUser, passwordGrant, type AdminUser } from './supabase';

export interface Provisioned {
  principals: Partial<Principals>;
  runAccountIds: string[];
  supabaseUserIds: string[];
}

const PASSWORD = 'Ke2e-passw0rd-Aa1!';

export interface SynthUser {
  user: AdminUser;
  jwt: string;
  principal: Principal;
}

/** Create+confirm a Supabase user and exchange for a JWT. */
export async function synthUser(env: Env, label: string, runId: string): Promise<SynthUser> {
  const email = `e2e-${runId}-${label.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@${env.testEmailDomain}`;
  return synthUserWithEmail(env, email, label);
}

/**
 * Create+confirm a Supabase user with a SPECIFIC email, then exchange for a JWT.
 *
 * The default `synthUser` mints a random email, which is fine for synthesized
 * members but blocks the invite accept/decline lifecycle: an invite is
 * addressed to an exact email, and the accept/decline handlers reject any
 * caller whose email doesn't match. Passing the email in lets a flow create
 * the invite FIRST (for an address with no Kortix user yet), then mint the
 * matching identity to act as the addressee.
 */
export async function synthUserWithEmail(
  env: Env,
  email: string,
  label: string,
): Promise<SynthUser> {
  const user = await adminCreateUser(env, email, PASSWORD);
  const jwt = await passwordGrant(env, email, PASSWORD);
  const principal: Principal = {
    label,
    auth: { mode: 'bearer', token: jwt },
    email,
    userId: user.id,
    accountId: user.id, // personal account_id == user_id
  };
  return { user, jwt, principal };
}

/**
 * Decide whether a Stripe funding failure sinks the run.
 *
 * When `stripe` is a declared capability the run EXPECTS funding to work, and
 * every flow requiring `funded` (the largest capability group in the suite)
 * silently degrades to `skip` if it does not. Under `--require-all` that is a
 * red reported ~75 minutes later by a run that was doomed in its first minute.
 * So: fatal by default on a Stripe-capable target, soft on a local profile
 * without Stripe, and `KE2E_FUNDING_OPTIONAL=1` restores the old soft-fail.
 */
export function fundingFailureIsFatal(
  env: Pick<Env, 'capabilities'>,
  vars: Record<string, string | undefined> = process.env,
): boolean {
  if (!env.capabilities.stripe) return false;
  const optional = vars.KE2E_FUNDING_OPTIONAL;
  return !(optional === '1' || optional === 'true');
}

/** The exact message a fatal funding failure raises. */
export function fundingFailureMessage(cause: unknown): string {
  return (
    'OWNER funding failed — every flow requiring the `funded` capability cannot run. ' +
    'Failing fast now instead of reporting the skips at the end of the run. ' +
    'Set KE2E_FUNDING_OPTIONAL=1 to downgrade this to a warning. ' +
    `Cause: ${(cause as Error)?.message ?? cause}`
  );
}

async function provisionOwner(
  env: Env,
  runId: string,
): Promise<{ owner: SynthUser; patAcctSecret: string | undefined }> {
  const owner = await synthUser(env, 'OWNER', runId);
  // Force the personal account into existence + capture its id (== userId).
  // Funding must follow this call, not race it: the account row is created
  // lazily on the first token/project call.
  const ownerClient = new Client(env.apiUrl).as(owner.principal);
  const tok = await ownerClient.post('/v1/accounts/tokens', {
    name: `e2e-${runId}-owner-bootstrap`,
  });
  const patAcctSecret = tok.json<any>()?.secret_key as string | undefined;

  // Fund the OWNER's personal account so flows aren't blocked by the free-tier
  // 1-project / 402 limits — real Stripe test-mode subscribe → paid tier + credits.
  if (env.capabilities.stripe) {
    try {
      await subscribe(env, ownerClient, owner.principal.accountId!);
      env.capabilities.funded = true;
      log.step(`provision: OWNER ${owner.principal.accountId} funded (pro tier + credits)`);
    } catch (err) {
      if (fundingFailureIsFatal(env)) throw new Error(fundingFailureMessage(err));
      log.warn(
        `provision: OWNER funding failed — paid-tier flows will hit project_limit/402: ${(err as Error)?.message ?? err}`,
      );
    }
  }
  return { owner, patAcctSecret };
}

export async function provisionMatrix(env: Env, runId: string): Promise<Provisioned> {
  const supabaseUserIds: string[] = [];

  // NONMEMBER depends on nothing in the OWNER chain (create → bootstrap PAT →
  // Stripe subscribe), so it runs beside it instead of after it. allSettled,
  // not Promise.all: a rejected OWNER chain must not strand a created
  // NONMEMBER as an unreclaimed Supabase user.
  const [ownerSettled, nonmemberSettled] = await Promise.allSettled([
    provisionOwner(env, runId),
    synthUser(env, 'NONMEMBER', runId),
  ]);

  if (ownerSettled.status === 'rejected') {
    if (nonmemberSettled.status === 'fulfilled') {
      await adminDeleteUser(env, nonmemberSettled.value.user.id).catch(() => undefined);
    }
    throw ownerSettled.reason;
  }
  if (nonmemberSettled.status === 'rejected') {
    await adminDeleteUser(env, ownerSettled.value.owner.user.id).catch(() => undefined);
    throw nonmemberSettled.reason;
  }

  const { owner, patAcctSecret } = ownerSettled.value;
  const nonmember = nonmemberSettled.value;
  supabaseUserIds.push(owner.user.id, nonmember.user.id);

  const principals: Partial<Principals> = {
    OWNER: owner.principal,
    NONMEMBER: nonmember.principal,
    ANON: { label: 'ANON', auth: { mode: 'none' } },
    accountId: owner.principal.accountId!,
  };
  if (patAcctSecret) {
    principals.PAT_ACCT = {
      label: 'PAT_ACCT',
      auth: { mode: 'bearer', token: patAcctSecret },
      accountId: owner.principal.accountId,
      userId: owner.principal.userId,
    };
  }

  return { principals, runAccountIds: [], supabaseUserIds };
}
