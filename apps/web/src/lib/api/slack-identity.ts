import { backendApi } from '../api-client';

export interface SlackBindResult {
  ok: boolean;
  workspaceName: string | null;
}

export const slackIdentityApi = {
  /**
   * Complete a Slack `/login` bind. `token` is the signed payload from the link
   * the bot DM'd the user; the call is authenticated with the user's bearer, so
   * the API learns which Kortix account to bind the Slack user to.
   */
  async bind(token: string): Promise<SlackBindResult> {
    const res = await backendApi.post<SlackBindResult>('/channels/slack/identity/bind', { token });
    if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Failed to connect your account');
    return res.data;
  },
};
