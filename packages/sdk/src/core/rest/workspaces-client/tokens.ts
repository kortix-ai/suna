// CLI PAT minting — account-scoped personal access tokens (`kortix_pat_...`)
// and their workspace-scoped siblings. Both mint via the same backend
// repository (`repositories/account-tokens.ts`); the workspace-scoped route
// additionally binds the minted token to one `workspace_id` (the auth
// middleware then rejects it outside that workspace). These are the tokens
// the CLI / "Kortix as a Backend" hosts use to authenticate without a human
// Supabase session — the account variant is minted by a human from
// account settings, the workspace variant is auto-minted at session-create
// time and injected into the sandbox as `KORTIX_TOKEN`.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** One account-scoped CLI PAT (secret never returned again after creation). */
export interface AccountToken {
  token_id: string;
  name: string;
  /** Set when this token was minted workspace-scoped (still visible from the
   *  account-wide list). */
  workspace_id: string | null;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreateAccountTokenInput {
  name: string;
  /** Defaults to the caller's resolved account when omitted. */
  accountId?: string;
  /** ISO-8601. Omit for a non-expiring token. */
  expiresAt?: string;
  /** Scope the minted token to a single workspace (still a "kortix_pat_..." token,
   *  but the auth middleware rejects it outside this workspace). */
  workspaceId?: string;
}

/** The newly minted token — `secret_key` is the plaintext PAT, returned ONCE. */
export interface CreatedAccountToken {
  token_id: string;
  name: string;
  workspace_id: string | null;
  public_key: string;
  secret_key: string;
  status: string;
  expires_at: string | null;
  created_at: string;
}

/** List CLI PATs for an account (defaults to the caller's resolved account). */
export async function listAccountTokens(accountId?: string) {
  const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(await backendApi.get<AccountToken[]>(`/accounts/tokens${qs}`));
}

/** Mint a new account-scoped CLI PAT. The `secret_key` is returned once — the
 *  caller must persist it immediately; subsequent reads only ever see `public_key`. */
export async function createAccountToken(input: CreateAccountTokenInput) {
  const { accountId, expiresAt, workspaceId, name } = input;
  return unwrap(
    await backendApi.post<CreatedAccountToken>('/accounts/tokens', {
      name,
      ...(accountId ? { account_id: accountId } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    }),
  );
}

/** Revoke an account-scoped CLI PAT. */
export async function revokeAccountToken(tokenId: string, accountId?: string) {
  const qs = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(`/accounts/tokens/${tokenId}${qs}`),
  );
}

// ── Workspace-scoped CLI tokens ────────────────────────────────────────────────
// These are PATs bound to a single workspace — auto-minted at session-create
// time and injected into the sandbox as `KORTIX_TOKEN`, so the in-container
// CLI works with zero config. Minting/revoking is a human/`manage` operation;
// an agent-session token is denied outright server-side (privilege-escalation
// guard — see apps/api/src/workspaces/routes/r3.ts).

export interface WorkspaceCliToken {
  token_id: string;
  name: string;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface WorkspaceCliTokenListResponse {
  items: WorkspaceCliToken[];
}

/** The newly minted workspace-scoped token — `secret_key` is returned once. */
export interface CreatedWorkspaceCliToken {
  token_id: string;
  name: string;
  public_key: string;
  secret_key: string;
  status: string;
  workspace_id: string;
  expires_at: string | null;
  created_at: string;
}

export async function listWorkspaceCliTokens(workspaceId: string) {
  return unwrap(
    await backendApi.get<WorkspaceCliTokenListResponse>(`/workspaces/${workspaceId}/cli-token`),
  );
}

/** Mint a workspace-scoped CLI PAT. Defaults `name` to "cli · <workspace name>" server-side. */
export async function createWorkspaceCliToken(
  workspaceId: string,
  input?: { name?: string },
) {
  return unwrap(
    await backendApi.post<CreatedWorkspaceCliToken>(
      `/workspaces/${workspaceId}/cli-token`,
      input ?? {},
    ),
  );
}

export async function revokeWorkspaceCliToken(workspaceId: string, tokenId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${workspaceId}/cli-token/${tokenId}`,
    ),
  );
}
