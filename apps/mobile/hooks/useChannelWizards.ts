/**
 * Hooks for Slack channel setup.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from '@/api/config';
import { channelKeys } from './useChannels';

/**
 * Push Slack credentials to sandbox env, reload channels, create DB record.
 */
export function useSlackConnect() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sandboxUrl,
      botToken,
      signingSecret,
      publicUrl,
      name,
      defaultAgent,
      defaultModel,
    }: {
      sandboxUrl: string;
      sandboxId: string | null;
      botToken: string;
      signingSecret: string;
      publicUrl: string;
      name?: string;
      defaultAgent?: string;
      defaultModel?: string;
    }) => {
      const authToken = await getAuthToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      };

      // Try sandbox setup endpoint first (matches web)
      try {
        const res = await fetch(`${sandboxUrl}/kortix/channels/setup/slack`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            botToken,
            signingSecret: signingSecret || undefined,
            publicUrl: publicUrl || '',
            name: name || undefined,
            defaultAgent,
            defaultModel,
          }),
        });
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          if (data.ok) return data;
          if (data.error) throw new Error(data.error);
        } catch (parseErr: any) {
          if (!(parseErr instanceof SyntaxError)) throw parseErr;
        }
      } catch (e: any) {
        if (e?.message && !e.message.includes('invalid response') && !(e instanceof TypeError)) throw e;
      }

      // Fallback: push env vars directly
      for (const [key, value] of Object.entries({
        SLACK_BOT_TOKEN: botToken,
        SLACK_SIGNING_SECRET: signingSecret,
      })) {
        await fetch(`${sandboxUrl}/env/${key}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ value }),
        });
      }

      try {
        await fetch(`${sandboxUrl}/channels/reload`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ credentials: { slack: { botToken, signingSecret } } }),
        });
      } catch {
        // Not fatal
      }

      return { ok: true, message: 'Slack bot configured' };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}
