import { backendApi } from '../api-client';

export interface TeamsBindResult {
  ok: boolean;
  workspaceName: string | null;
  hasAccess: boolean;
  resumed: boolean;
}

export const teamsIdentityApi = {
  async bind(token: string): Promise<TeamsBindResult> {
    const res = await backendApi.post<TeamsBindResult>('/channels/teams/identity/bind', { token });
    if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Failed to connect your account');
    return res.data;
  },
};
