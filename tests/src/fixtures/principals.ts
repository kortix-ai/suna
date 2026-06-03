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
import { Client } from "../core/client";
import type { Env } from "../core/env";
import type { Principal, Principals } from "../core/types";
import { adminCreateUser, passwordGrant, type AdminUser } from "./supabase";

export interface Provisioned {
  principals: Partial<Principals>;
  runAccountIds: string[];
  supabaseUserIds: string[];
}

const PASSWORD = "Ke2e-passw0rd-Aa1!";

export interface SynthUser {
  user: AdminUser;
  jwt: string;
  principal: Principal;
}

/** Create+confirm a Supabase user and exchange for a JWT. */
export async function synthUser(env: Env, label: string, runId: string): Promise<SynthUser> {
  const email = `e2e-${runId}-${label.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@${env.testEmailDomain}`;
  const user = await adminCreateUser(env, email, PASSWORD);
  const jwt = await passwordGrant(env, email, PASSWORD);
  const principal: Principal = {
    label,
    auth: { mode: "bearer", token: jwt },
    email,
    userId: user.id,
    accountId: user.id, // personal account_id == user_id
  };
  return { user, jwt, principal };
}

export async function provisionMatrix(env: Env, runId: string): Promise<Provisioned> {
  const supabaseUserIds: string[] = [];

  const owner = await synthUser(env, "OWNER", runId);
  supabaseUserIds.push(owner.user.id);
  // Force the personal account into existence + capture its id (== userId).
  const ownerClient = new Client(env.apiUrl).as(owner.principal);
  const tok = await ownerClient.post("/v1/accounts/tokens", { name: `e2e-${runId}-owner-bootstrap` });
  const patAcctSecret = tok.json<any>()?.secret_key as string | undefined;

  const nonmember = await synthUser(env, "NONMEMBER", runId);
  supabaseUserIds.push(nonmember.user.id);

  const principals: Partial<Principals> = {
    OWNER: owner.principal,
    NONMEMBER: nonmember.principal,
    ANON: { label: "ANON", auth: { mode: "none" } },
    accountId: owner.principal.accountId!,
  };
  if (patAcctSecret) {
    principals.PAT_ACCT = {
      label: "PAT_ACCT",
      auth: { mode: "bearer", token: patAcctSecret },
      accountId: owner.principal.accountId,
      userId: owner.principal.userId,
    };
  }

  return { principals, runAccountIds: [], supabaseUserIds };
}
