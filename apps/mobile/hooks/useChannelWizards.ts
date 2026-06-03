/**
 * Hooks for Telegram & Slack channel setup wizards.
 * Mirrors frontend's use-telegram-wizard.ts and use-slack-wizard.ts.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from '@/api/config';
import { channelKeys } from './useChannels';

// ─── Helpers ────────────────────────────────────────────────────────────────

function secureSecretToken(): string {
  const bytes = new Uint8Array(24);
  const crypto = globalThis.crypto as Crypto | undefined;
  if (!crypto?.getRandomValues) {
    throw new Error('Secure random generator unavailable');
  }
  crypto.getRandomValues(bytes);
  return `oc-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

// ─── Telegram ───────────────────────────────────────────────────────────────

export interface TelegramVerifyResult {
  valid: boolean;
  error?: string;
  bot?: { id: number; username: string; firstName: string };
}

/**
 * Verify a Telegram bot token by calling api.telegram.org directly.
 */
export function useTelegramVerifyToken() {
  return useMutation({
    mutationFn: async ({ botToken }: { botToken: string }): Promise<TelegramVerifyResult> => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await res.json() as {
          ok: boolean;
          result?: { id: number; first_name: string; username: string };
          description?: string;
        };
        if (data.ok && data.result) {
          return {
            valid: true,
            bot: { id: data.result.id, username: data.result.username, firstName: data.result.first_name },
          };
        }
        return { valid: false, error: data.description || 'Invalid token' };
      } catch {
        return { valid: false, error: 'Failed to reach Telegram API' };
      }
    },
  });
}

/**
 * Connect Telegram bot — tries sandbox setup endpoint first, falls back to direct setup.
 */
export function useTelegramConnect() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sandboxUrl,
      botToken,
      defaultAgent,
      defaultModel,
    }: {
      sandboxUrl: string;
      botToken: string;
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
        const res = await fetch(`${sandboxUrl}/kortix/channels/setup/telegram`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ botToken, publicUrl: '', defaultAgent, defaultModel }),
        });
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          if (data.ok) return data;
          if (data.error) throw new Error(data.error);
        } catch (parseErr: any) {
          // JSON parse failed (HTML response) — fall through to fallback
          if (!(parseErr instanceof SyntaxError)) throw parseErr;
        }
      } catch (e: any) {
        // Re-throw real errors (not parse/fallback errors)
        if (e?.message && !e.message.includes('invalid response') && !(e instanceof TypeError)) throw e;
      }

      // Fallback: direct Telegram API setup
      const secretToken = secureSecretToken();

      // Push env vars
      for (const [key, value] of Object.entries({
        TELEGRAM_BOT_TOKEN: botToken,
        TELEGRAM_WEBHOOK_SECRET_TOKEN: secretToken,
      })) {
        await fetch(`${sandboxUrl}/env/${key}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ value }),
        });
      }

      // Resolve public URL from sandbox env
      let resolvedUrl = '';
      try {
        const envRes = await fetch(`${sandboxUrl}/env/PUBLIC_BASE_URL`, { headers });
        if (envRes.ok) {
          const envData = await envRes.json() as Record<string, string>;
          resolvedUrl = envData?.PUBLIC_BASE_URL || '';
        }
      } catch { /* ignore */ }

      // Set Telegram webhook if public URL available
      let webhookUrl: string | null = null;
      if (resolvedUrl) {
        webhookUrl = `${resolvedUrl.replace(/\/$/, '')}/hooks/telegram/env-telegram`;
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: webhookUrl,
              secret_token: secretToken,
              allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
            }),
          });
        } catch { /* webhook may fail */ }
      }

      // Reload channels service
      try {
        await fetch(`${sandboxUrl}/channels/reload`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ credentials: { telegram: { botToken, secretToken } } }),
        });
      } catch { /* not fatal */ }

      return {
        ok: true,
        channel: { webhookUrl },
        message: webhookUrl
          ? `Telegram bot configured. Webhook: ${webhookUrl}`
          : 'Telegram bot configured (set PUBLIC_BASE_URL for webhooks)',
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

// ─── Slack ───────────────────────────────────────────────────────────────────

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
