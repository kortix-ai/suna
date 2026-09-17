import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';
import type { SecretConsumer, SecretDeliveryStrategy } from './secrets';

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
  created_by: string;
  created_at: string;
  updated_at: string;
  granted_user_ids: string[];
  can_use: boolean;
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
  `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/provider-secret-pools/${encodeURIComponent(providerId)}`;

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
  const path = `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/provider-secret-pools`;
  return unwrap(await backendApi.get<{ pools: SessionProviderSecretPool[]; can_edit: boolean }>(path));
}
export async function setSessionProviderSecretPool(projectId: string, sessionId: string, providerId: string, secretIds: string[] | null) {
  return unwrap(await backendApi.put<SessionProviderSecretPool>(poolPath(projectId, sessionId, providerId), { secret_ids: secretIds }));
}
