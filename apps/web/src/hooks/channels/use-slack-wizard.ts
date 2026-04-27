import { useMutation } from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { getActiveOpenCodeUrl } from '@/stores/server-store';

export function useSlackConnect() {
  return useMutation({
    mutationFn: async ({ botToken, signingSecret, publicUrl, name, createdBy, channelId, defaultAgent, defaultModel, projectId }: {
      botToken: string;
      signingSecret?: string;
      publicUrl?: string;
      name?: string;
      createdBy?: string;
      channelId?: string;
      defaultAgent?: string;
      defaultModel?: string;
      projectId?: string | null;
    }) => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) throw new Error('No active instance');
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/setup/slack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, signingSecret, publicUrl, name, createdBy, channelId, defaultAgent, defaultModel, projectId }),
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        // Endpoint returned HTML — fall back to direct env push
        await authenticatedFetch(`${baseUrl}/env/SLACK_BOT_TOKEN`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: botToken }),
        });
        if (signingSecret) {
          await authenticatedFetch(`${baseUrl}/env/SLACK_SIGNING_SECRET`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: signingSecret }),
          });
        }
        try {
          await authenticatedFetch(`${baseUrl}/channels/reload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credentials: { slack: { botToken, signingSecret } } }),
          });
        } catch { /* reload may not exist */ }
        return { ok: true, message: 'Slack bot configured (env vars set)' };
      }
      if (!data.ok) throw new Error(data.error || 'Setup failed');
      return data;
    },
  });
}
