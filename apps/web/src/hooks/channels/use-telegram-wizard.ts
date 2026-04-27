import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '@/lib/auth-token';
import { getActiveOpenCodeUrl } from '@/stores/server-store';

export interface VerifyTokenResult {
  ok: boolean;
  bot?: { id: number; username: string; firstName: string };
  error?: string;
}

/**
 * Verify a Telegram bot token by calling the Telegram API directly from the browser.
 */
export function useTelegramVerifyToken() {
  return useMutation({
    mutationFn: async ({ botToken }: { botToken: string }): Promise<VerifyTokenResult> => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as {
          ok: boolean;
          result?: { id: number; first_name: string; username: string };
          description?: string;
        };

        if (data.ok && data.result) {
          return {
            ok: true,
            bot: {
              id: data.result.id,
              username: data.result.username,
              firstName: data.result.first_name,
            },
          };
        }
        return { ok: false, error: data.description || 'Invalid token' };
      } catch {
        return { ok: false, error: 'Failed to reach Telegram API' };
      }
    },
  });
}

export function useTelegramConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ botToken, publicUrl, createdBy, defaultAgent, defaultModel, projectId }: {
      botToken: string;
      publicUrl: string;
      createdBy?: string;
      defaultAgent?: string;
      defaultModel?: string;
      projectId?: string | null;
    }) => {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) throw new Error('No active instance');

      // Try sandbox setup endpoint
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/setup/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, publicUrl, createdBy, defaultAgent, defaultModel, projectId }),
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        // Endpoint returned HTML — fall back to direct setup
        const secret = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        // Push env vars
        await authenticatedFetch(`${baseUrl}/env/TELEGRAM_BOT_TOKEN`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: botToken }),
        });
        await authenticatedFetch(`${baseUrl}/env/TELEGRAM_WEBHOOK_SECRET_TOKEN`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: secret }),
        });

        // Resolve public URL from env or param
        let resolvedUrl = publicUrl || '';
        if (!resolvedUrl) {
          try {
            const envRes = await authenticatedFetch(`${baseUrl}/env/PUBLIC_BASE_URL`);
            if (envRes.ok) {
              const envData = await envRes.json() as Record<string, string>;
              resolvedUrl = envData?.PUBLIC_BASE_URL || '';
            }
          } catch { /* ignore */ }
        }

        // Set Telegram webhook if we have a public URL
        let webhookUrl: string | null = null;
        if (resolvedUrl) {
          webhookUrl = `${resolvedUrl.replace(/\/$/, '')}/hooks/telegram/env-telegram`;
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                url: webhookUrl,
                secret_token: secret,
                allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
              }),
            });
          } catch { /* webhook may fail locally */ }
        }

        // Reload channels service
        try {
          await authenticatedFetch(`${baseUrl}/channels/reload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credentials: { telegram: { botToken, secretToken: secret } } }),
          });
        } catch { /* reload may not exist */ }

        return {
          ok: true,
          channel: { webhookUrl },
          message: webhookUrl
            ? `Telegram bot configured. Webhook: ${webhookUrl}`
            : 'Telegram bot configured (no public URL — set PUBLIC_BASE_URL for webhooks)',
        };
      }
      if (!data.ok) throw new Error(data.error || 'Setup failed');
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}
