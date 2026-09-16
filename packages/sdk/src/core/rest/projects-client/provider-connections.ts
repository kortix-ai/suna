import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';
import type { ProviderOAuthStart } from './secrets';

export interface UserProviderConnection {
  connection_id: string;
  provider_id: string;
  auth_type: 'api_key' | 'device_oauth';
  created_at: string;
  updated_at: string;
  label?: string;
}
export interface UserProviderConnectionOptions {
  create?: boolean;
  connection_id?: string;
  label?: string;
}
export interface ProjectPersonalProviderSelection {
  connection_id?: string;
  pool?: boolean;
}
export interface UserProviderConnections {
  providers: { provider_id: string; name: string; auth_type: 'api_key' | 'device_oauth' }[];
  items: UserProviderConnection[];
}
export type UserProviderOAuthPoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'failed'; error: string }
  | { status: 'success'; connection: UserProviderConnection };

const path = (provider: string) => `/provider-connections/${encodeURIComponent(provider)}`;
const bindingsPath = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/personal-providers`;

/** Requires the user's sign-in token. Account and session tokens cannot manage global credentials. */
export async function listUserProviderConnections(): Promise<UserProviderConnections> {
  return unwrap(await backendApi.get<UserProviderConnections>('/provider-connections'));
}
export async function saveUserProviderApiKey(
  provider: string,
  apiKey: string,
  options: UserProviderConnectionOptions = {},
): Promise<UserProviderConnection> {
  return unwrap(
    await backendApi.put<UserProviderConnection>(path(provider), { api_key: apiKey, ...options }),
  );
}
export async function deleteUserProviderConnection(
  provider: string,
  connectionId?: string,
): Promise<{ ok: boolean }> {
  const target = connectionId
    ? `${path(provider)}/connections/${encodeURIComponent(connectionId)}`
    : path(provider);
  return unwrap(await backendApi.delete<{ ok: boolean }>(target));
}
export async function startUserProviderOAuth(
  provider: string,
  options: UserProviderConnectionOptions = {},
): Promise<ProviderOAuthStart> {
  return unwrap(await backendApi.post<ProviderOAuthStart>(`${path(provider)}/start`, options));
}
export async function pollUserProviderOAuth(
  provider: string,
  flowId: string,
): Promise<UserProviderOAuthPoll> {
  return unwrap(
    await backendApi.post<UserProviderOAuthPoll>(`${path(provider)}/poll`, { flow_id: flowId }),
  );
}
export async function listProjectPersonalProviders(
  projectId: string,
): Promise<{ items: { provider_id: string; connection_id: string; pool?: boolean }[] }> {
  return unwrap(
    await backendApi.get<{
      items: { provider_id: string; connection_id: string; pool?: boolean }[];
    }>(bindingsPath(projectId)),
  );
}
export async function setProjectPersonalProvider(
  projectId: string,
  provider: string,
  enabled: boolean,
  selection: ProjectPersonalProviderSelection = {},
): Promise<{ ok: boolean }> {
  return unwrap(
    await backendApi.put<{ ok: boolean }>(
      `${bindingsPath(projectId)}/${encodeURIComponent(provider)}`,
      { enabled, ...selection },
    ),
  );
}
