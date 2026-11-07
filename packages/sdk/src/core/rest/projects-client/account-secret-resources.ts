import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';
import type { SecretConsumer, SecretDeliveryStrategy, SecretValueStatus } from './secrets';

/** One plan window of a subscription login: the 5-hour window, the weekly window, or a provider-named one. */
export interface SubscriptionUsageWindow {
  /** `five_hour`, `weekly`, or the provider's own name (`seven_day_opus`). */
  id: string;
  /** Window length in minutes (300, 10080); null when the provider names none. */
  window_minutes: number | null;
  /** Share of the window's allowance used, 0–100. */
  used_percent: number;
  /** When the window resets, ISO 8601; null when unknown. */
  resets_at: string | null;
}

/** The plan usage of a ChatGPT or Claude login, as last observed. */
export interface SubscriptionUsage {
  windows: SubscriptionUsageWindow[];
  /** The provider refuses this login's requests until a window resets. */
  limited: boolean;
  observed_at: string;
  /** `response`: a model call's headers. `usage_endpoint`: the provider's usage API. */
  source: 'response' | 'usage_endpoint';
}

/** Who a ChatGPT or Claude login signs in as. Either field is null when the provider does not say. */
export interface SubscriptionAccount {
  email: string | null;
  /** The provider's plan name, lower case: `plus`, `pro`, `team`, `max`, … */
  plan: string | null;
}

export interface AccountSecretResource {
  secret_id: string;
  account_id: string;
  project_id: string | null;
  access_mode: 'project' | 'members';
  label: string;
  provider_id: string | null;
  name: string;
  consumer: SecretConsumer;
  strategy: SecretDeliveryStrategy;
  active: boolean;
  cooldown_until: string | null;
  /**
   * When the stored login first stopped working (the provider rejected its
   * refresh, or it cannot be read), as an ISO timestamp; `null` while it works.
   * The account stays usable and selected; reconnecting it clears the mark.
   * Absent from APIs older than this field.
   */
  needs_reauth_at?: string | null;
  /**
   * A ChatGPT or Claude login's last observed plan usage; `null` for an API key
   * or before the login was used. `refreshAccountSecretUsage` asks the provider
   * again. Absent from APIs older than this field.
   */
  usage?: SubscriptionUsage | null;
  /**
   * Who a ChatGPT or Claude login signs in as. ChatGPT always says; Claude only
   * when its login may read the profile. `null` for an API key. Absent from
   * APIs older than this field.
   */
  provider_account?: SubscriptionAccount | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  granted_user_ids: string[];
  can_use: boolean;
  /** Can the server decrypt the stored value? `undecryptable` means enter it
   *  again with `rotateAccountSecretResource` (a ChatGPT login: reconnect).
   *  Absent from APIs older than this field. */
  status?: SecretValueStatus;
}

/** Storage identity is separate from the ID: older logins remain in their original store. */
export interface SubscriptionConnection extends AccountSecretResource {
  storage: 'account_resource' | 'project';
}

export async function listSubscriptionConnections(accountId: string, projectId: string) {
  return unwrap(await backendApi.get<{ subscriptions: SubscriptionConnection[] }>(`/accounts/${encodeURIComponent(accountId)}/subscription-connections?project_id=${encodeURIComponent(projectId)}`));
}

export async function refreshSubscriptionConnectionUsage(accountId: string, secretId: string, projectId: string, storage: SubscriptionConnection['storage']) {
  const path = `/accounts/${encodeURIComponent(accountId)}/subscription-connections/${encodeURIComponent(secretId)}/usage`;
  return unwrap(await backendApi.post<{ usage: SubscriptionUsage | null; provider_account?: SubscriptionAccount | null }>(`${path}?project_id=${encodeURIComponent(projectId)}&storage=${storage}`));
}

export interface CreateAccountSecretResourceInput {
  /** The owning project. With this set, access defaults to all project members. */
  project_id?: string;
  /** Default is project access when project_id is set. */
  access_mode?: 'project' | 'members';
  user_ids?: string[];
  label: string;
  provider_id: string;
  name: string;
  value: string;
  consumer: 'llm_gateway';
  strategy: 'broker';
}

export interface SessionProviderSecretPool {
  provider_id: string;
  configured: boolean;
  secret_ids: string[];
}

const accountPath = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}/secret-resources`;
const secretPath = (accountId: string, secretId: string) => `${accountPath(accountId)}/${encodeURIComponent(secretId)}`;
const poolPath = (projectId: string, sessionId: string, providerId: string) =>
  `/workspaces/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/provider-secret-pools/${encodeURIComponent(providerId)}`;

export async function listAccountSecretResources(accountId: string, projectId?: string) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return unwrap(await backendApi.get<{ secrets: AccountSecretResource[] }>(`${accountPath(accountId)}${query}`));
}
export async function createAccountSecretResource(accountId: string, input: CreateAccountSecretResourceInput) {
  return unwrap(await backendApi.post<AccountSecretResource>(accountPath(accountId), input));
}
export async function rotateAccountSecretResource(accountId: string, secretId: string, value: string) {
  return unwrap(await backendApi.put<AccountSecretResource>(`${secretPath(accountId, secretId)}/value`, { value }));
}
/** End the rate-limit rest of one stored account now (owner, admin or creator). */
export async function retryAccountSecretResource(accountId: string, secretId: string) {
  return unwrap(await backendApi.post<AccountSecretResource>(`${secretPath(accountId, secretId)}/retry`));
}
/**
 * The current plan usage of one ChatGPT or Claude login. The server asks the
 * provider at most once a minute per login (no plan quota) and otherwise answers
 * the stored snapshot; `usage` is null when the provider reports none.
 */
export async function refreshAccountSecretUsage(accountId: string, secretId: string, projectId?: string) {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return unwrap(await backendApi.post<{ usage: SubscriptionUsage | null; provider_account?: SubscriptionAccount | null }>(`${secretPath(accountId, secretId)}/usage${query}`));
}
export async function deleteAccountSecretResource(accountId: string, secretId: string) {
  return unwrap(await backendApi.delete<{ ok: boolean }>(secretPath(accountId, secretId)));
}
export async function grantAccountSecretResource(accountId: string, secretId: string, userId: string, options?: { showErrors?: boolean }) {
  return unwrap(await backendApi.put<AccountSecretResource>(`${secretPath(accountId, secretId)}/grants/${encodeURIComponent(userId)}`, {}, options));
}
export async function revokeAccountSecretResourceGrant(accountId: string, secretId: string, userId: string, options?: { showErrors?: boolean }) {
  return unwrap(await backendApi.delete<AccountSecretResource>(`${secretPath(accountId, secretId)}/grants/${encodeURIComponent(userId)}`, options));
}
export async function setAccountSecretResourceAccess(accountId: string, secretId: string, mode: 'project' | 'members', userIds: string[]) {
  return unwrap(await backendApi.put<AccountSecretResource>(`${secretPath(accountId, secretId)}/access`, { mode, user_ids: userIds }));
}
export async function getSessionProviderSecretPool(projectId: string, sessionId: string, providerId: string) {
  return unwrap(await backendApi.get<SessionProviderSecretPool>(poolPath(projectId, sessionId, providerId)));
}
export async function listSessionProviderSecretPools(projectId: string, sessionId: string) {
  const path = `/workspaces/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/provider-secret-pools`;
  return unwrap(await backendApi.get<{
    pools: SessionProviderSecretPool[];
    can_edit: boolean;
    /**
     * The person whose own keys this session reaches, or `null` when it reaches
     * only keys shared with the whole project. Absent from older APIs.
     */
    personal_user_id?: string | null;
    /** Why `personal_user_id` is null. Absent from older APIs. */
    personal_keys_reason?: 'shared' | 'prompted_by_another_member' | 'no_person' | null;
  }>(path));
}
export async function setSessionProviderSecretPool(projectId: string, sessionId: string, providerId: string, secretIds: string[] | null) {
  return unwrap(await backendApi.put<SessionProviderSecretPool>(poolPath(projectId, sessionId, providerId), { secret_ids: secretIds }));
}
