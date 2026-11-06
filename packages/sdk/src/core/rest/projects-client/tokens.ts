// CLI PAT minting — account-scoped personal access tokens (`kortix_pat_...`)
// and their project-scoped siblings. Both mint via the same backend
// repository (`repositories/account-tokens.ts`); the project-scoped route
// additionally binds the minted token to one `project_id` (the auth
// middleware then rejects it outside that project). These are the tokens
// the CLI / "Kortix as a Backend" hosts use to authenticate without a human
// Supabase session — the account variant is minted by a human from
// account settings, the project variant is auto-minted at session-create
// time and injected into the sandbox as `KORTIX_TOKEN`.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

/** One account-scoped CLI PAT (secret never returned again after creation). */
export interface AccountToken {
  token_id: string;
  name: string;
  /** Set when this token was minted project-scoped (still visible from the
   *  account-wide list). */
  project_id: string | null;
  /** The workspace the key is bound to: the same value as `project_id`. Absent on older APIs. */
  workspace_id?: string | null;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  /** What the key may do inside its creator's role. Absent on older APIs (= `full`). */
  scope?: WorkspaceKeyScopeLabel;
  /** A `custom` scope: its permissions, legacy spelling. Null otherwise. */
  permissions?: string[] | null;
  /** A `custom` scope: its permissions, workspace spelling. Null otherwise. */
  workspace_permissions?: string[] | null;
  /** True when each use moves `expires_at` out again (the CLI login), so a key in use does not expire. */
  expiry_renews?: boolean;
}

/**
 * What a workspace key may do inside its creator's role:
 *   - `full`: the creator's whole role (the default);
 *   - `read`: every `*.read` permission; the key makes GET requests only;
 *   - `custom`: exactly the listed permissions.
 * The API checks the creator's CURRENT role on every request, so a key never
 * exceeds it.
 */
export type WorkspaceKeyScopeLabel = 'full' | 'read' | 'custom';

/** The `scopes` a mint request sends: a preset, or a list of permissions in either spelling. */
export type WorkspaceKeyScopes = 'full' | 'read' | string[];

export interface CreateAccountTokenInput {
  name: string;
  /** Defaults to the caller's resolved account when omitted. */
  accountId?: string;
  /** ISO-8601. Omitted: the API's default (90 days on current APIs). `null`:
   *  no expiry, only where the workspace key policy allows it. */
  expiresAt?: string | null;
  /** A renewing expiry: each use moves `expires_at` out again. A personal key
   *  minted from a browser session only (the CLI login). */
  renews?: boolean;
  /** Scope the minted token to a single project (still a "kortix_pat_..." token,
   *  but the auth middleware rejects it outside this project). */
  projectId?: string;
}

/** The newly minted token — `secret_key` is the plaintext PAT, returned ONCE. */
export interface CreatedAccountToken {
  token_id: string;
  name: string;
  project_id: string | null;
  public_key: string;
  secret_key: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  /** The workspace the key is bound to (= `project_id`). Absent on older APIs. */
  workspace_id?: string | null;
  /** What the key may do inside its creator's role. Absent on older APIs (= `full`). */
  scope?: WorkspaceKeyScopeLabel;
  /** A `custom` scope: its permissions, legacy spelling. */
  permissions?: string[] | null;
  /** A `custom` scope: its permissions, workspace spelling. */
  workspace_permissions?: string[] | null;
  /** True for a renewing expiry. */
  expiry_renews?: boolean;
}

export interface ListAccountTokensOptions {
  /**
   * Narrow the list to the CALLER'S OWN hand-minted keys — no other member's
   * keys, no session connector tokens, no service-account bearers. This is the
   * read behind a person's own settings page; omit it for the administrative
   * account-wide list.
   *
   * The narrowing is server-side on purpose: the response carries no
   * `user_id`, `session_id` or `service_account_id`, so a client cannot do it.
   */
  mine?: boolean;
}

/** List CLI PATs for an account (defaults to the caller's resolved account).
 *
 * @deprecated Use `listWorkspaceTokens(workspaceId, options)`. Kept permanently.
 */
export async function listAccountTokens(
  accountId?: string,
  options?: ListAccountTokensOptions,
) {
  const params = new URLSearchParams();
  if (accountId) params.set('account_id', accountId);
  if (options?.mine) params.set('mine', 'true');
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  return unwrap(await backendApi.get<AccountToken[]>(`/accounts/tokens${qs}`));
}

/** Approve a CLI device login (`kortix login` on a machine with no browser
 *  callback): the signed-in browser confirms the code the terminal shows. The
 *  API answers 404 for an expired or used code and 403 for a non-browser
 *  caller; both reject with the API's sentence. `accountId` names the
 *  workspace's account the CLI key belongs to; omitted, the API picks the
 *  person's default workspace. A person with no workspace gets the 409
 *  `no_workspace` error (`isNoWorkspaceError`). */
export async function approveCliDevice(userCode: string, options?: { accountId?: string }) {
  return unwrap(
    await backendApi.post<{ ok: boolean }>('/cli/device/decide', {
      user_code: userCode,
      approve: true,
      ...(options?.accountId ? { account_id: options.accountId } : {}),
    }),
  );
}

/** Mint a new account-scoped CLI PAT. The `secret_key` is returned once — the
 *  caller must persist it immediately; subsequent reads only ever see `public_key`.
 *
 * A key minted here without `projectId` is a PERSONAL key: it acts as the
 * person in every workspace of theirs (listed by `listPersonalTokens`). A key
 * for one workspace only is `createWorkspaceToken(workspaceId, input)`.
 *
 * Use it for personal keys only: the CLI browser login (`renews: true`) and
 * clients released before workspace keys. The API marks the route deprecated
 * for any other use; every new key a person mints for automation is a
 * workspace key, `createWorkspaceToken(workspaceId, input)`. Not tagged
 * `@deprecated`: a personal key has a different reach than a workspace key,
 * so the two functions are not equivalents.
 */
export async function createAccountToken(input: CreateAccountTokenInput) {
  const { accountId, expiresAt, projectId, name, renews } = input;
  return unwrap(
    await backendApi.post<CreatedAccountToken>('/accounts/tokens', {
      name,
      ...(accountId ? { account_id: accountId } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(projectId ? { project_id: projectId } : {}),
      ...(renews ? { renews: true } : {}),
    }),
  );
}

/** Revoke an account-scoped CLI PAT. With `{ deleteRevoked: true }`, DELETE
 *  becomes "remove this dead row": the API only honors it for a personal key
 *  that is already revoked (the caller's own), and answers 404 otherwise —
 *  the settings page's Delete action for a revoked key rides on it.
 *
 * @deprecated Use `revokeWorkspaceToken(workspaceId, tokenId, options)`. Kept permanently.
 */
export async function revokeAccountToken(
  tokenId: string,
  accountId?: string,
  options?: { deleteRevoked?: boolean },
) {
  const params = new URLSearchParams();
  if (accountId) params.set('account_id', accountId);
  if (options?.deleteRevoked) params.set('delete_revoked', 'true');
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  return unwrap(
    await backendApi.delete<{ ok: boolean; deleted?: boolean }>(
      `/accounts/tokens/${encodeURIComponent(tokenId)}${qs}`,
    ),
  );
}

// ── Project-scoped CLI tokens ────────────────────────────────────────────────
// These are PATs bound to a single project — auto-minted at session-create
// time and injected into the sandbox as `KORTIX_TOKEN`, so the in-container
// CLI works with zero config. Minting/revoking is a human/`manage` operation;
// an agent-session token is denied outright server-side (privilege-escalation
// guard — see apps/api/src/projects/routes/project-credentials.ts).

// ─── Connected apps (OAuth grants) ─────────────────────────────────────────

/**
 * An app the caller approved with "Sign in with Kortix": an MCP client such as
 * Claude Code or Cursor, or an account's own OAuth app. Per person, across all
 * accounts. `GET /oauth/grants`.
 */
export interface OAuthGrant {
  client_id: string;
  name: string;
  client_type: string;
  /** Registered by the app itself (RFC 7591): its name is its own claim. */
  self_registered: boolean;
  /** Where the app sends the user back after sign-in. */
  redirect_hosts: string[];
  scopes: string[];
  granted_at: string | null;
  /** When the app last got a token; it refreshes about hourly while in use. */
  last_active_at: string | null;
  /** Holds a live token right now. */
  active: boolean;
}

/** The caller's connected apps, most recently active first. */
export async function listOAuthGrants(): Promise<OAuthGrant[]> {
  return unwrap(await backendApi.get<{ grants: OAuthGrant[] }>('/oauth/grants')).grants;
}

/**
 * Revoke a connected app: its consent (it must ask again) and every live token
 * it holds for the caller.
 */
export async function revokeOAuthGrant(clientId: string) {
  return unwrap(
    await backendApi.delete<{ ok: true; revoked_tokens: number }>(`/oauth/grants/${encodeURIComponent(clientId)}`),
  );
}

// ─── Signed-in devices (browser sign-ins) ─────────────────────────────────

/**
 * One place the caller is signed in: a live Supabase auth session, as the
 * auth server recorded it. `GET /accounts/me/devices`.
 */
export interface SignedInDevice {
  session_id: string;
  /** The User-Agent the device signed in with. */
  user_agent: string | null;
  ip: string | null;
  signed_in_at: string;
  /** When the device last refreshed its token; it refreshes about hourly while open. */
  last_active_at: string;
  /** The device that made this request. */
  current: boolean;
}

/** The caller's signed-in devices, most recently active first. */
export async function listSignedInDevices(): Promise<SignedInDevice[]> {
  return unwrap(await backendApi.get<{ devices: SignedInDevice[] }>('/me/devices'))
    .devices;
}

/** Sign one other device out. The current device signs out with `auth.signOut()`. */
export async function signOutDevice(sessionId: string) {
  return unwrap(
    await backendApi.delete<{ ok: true }>(`/me/devices/${encodeURIComponent(sessionId)}`),
  );
}

/** @deprecated Use `WorkspaceCliToken`. Kept permanently. */
export interface ProjectCliToken {
  token_id: string;
  name: string;
  public_key: string;
  status: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** The workspace name of {@link ProjectCliToken}: the same type. */
export type WorkspaceCliToken = ProjectCliToken;

/** @deprecated Use `WorkspaceCliTokenListResponse`. Kept permanently. */
export interface ProjectCliTokenListResponse {
  items: ProjectCliToken[];
  /** Session-bound tokens the list hides — the runtime mints one per session
   *  (the sandbox's `KORTIX_TOKEN`) and revokes it with the session, so they
   *  are not CLI credentials a person manages. The count keeps their
   *  provenance visible instead of a silent hole in the list. */
  session_tokens: number;
}

/** The workspace name of {@link ProjectCliTokenListResponse}: the same type. */
export type WorkspaceCliTokenListResponse = ProjectCliTokenListResponse;

/**
 * The newly minted project-scoped token — `secret_key` is returned once.
 *
 * @deprecated Use `CreatedWorkspaceCliToken`. Kept permanently.
 */
export interface CreatedProjectCliToken {
  token_id: string;
  name: string;
  public_key: string;
  secret_key: string;
  status: string;
  project_id: string;
  expires_at: string | null;
  created_at: string;
}

/** The workspace name of {@link CreatedProjectCliToken}: the same type. */
export type CreatedWorkspaceCliToken = CreatedProjectCliToken;

export async function listWorkspaceCliTokens(projectId: string) {
  return unwrap(
    await backendApi.get<ProjectCliTokenListResponse>(`/workspaces/${projectId}/cli-token`),
  );
}

/** @deprecated Use `listWorkspaceCliTokens`. Kept permanently. */
export const listProjectCliTokens = listWorkspaceCliTokens;

/** Mint a project-scoped CLI PAT. Defaults `name` to "cli · <project name>" server-side. */
export async function createWorkspaceCliToken(
  projectId: string,
  input?: { name?: string },
) {
  return unwrap(
    await backendApi.post<CreatedProjectCliToken>(
      `/workspaces/${projectId}/cli-token`,
      input ?? {},
    ),
  );
}

/** @deprecated Use `createWorkspaceCliToken`. Kept permanently. */
export const createProjectCliToken = createWorkspaceCliToken;

export async function revokeWorkspaceCliToken(projectId: string, tokenId: string) {
  return unwrap(
    await backendApi.delete<{ ok: boolean }>(
      `/workspaces/${projectId}/cli-token/${tokenId}`,
    ),
  );
}

/** @deprecated Use `revokeWorkspaceCliToken`. Kept permanently. */
export const revokeProjectCliToken = revokeWorkspaceCliToken;
