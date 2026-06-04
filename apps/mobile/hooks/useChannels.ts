/**
 * React Query hooks for Channels management.
 * Mirrors the frontend's channels API against the backend /channels endpoints.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from '@/api/config';
import { useSandboxContext } from '@/contexts/SandboxContext';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChannelType = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'teams' | 'voice' | 'email' | 'sms';

export interface ChannelConfig {
  id: string;
  channelConfigId?: string;
  platform: ChannelType;
  channelType?: ChannelType;
  name: string;
  enabled: boolean;
  bot_username: string | null;
  default_agent: string | null;
  default_model: string | null;
  instructions: string | null;
  webhook_path: string | null;
  webhook_url: string | null;
  platformConfig?: Record<string, unknown>;
  agentName?: string | null;
  metadata?: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at?: string;
  createdAt?: string;
  updatedAt?: string;
  sandboxId?: string | null;
  sandbox?: { name: string; status: string };
}

export interface CreateChannelData {
  name: string;
  channel_type: ChannelType;
  platform_config?: Record<string, unknown>;
  instructions?: string;
  agent_name?: string;
  default_agent?: string;
  default_model?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateChannelData {
  name?: string;
  platform_config?: Record<string, unknown>;
  bridge_instructions?: string;
  instructions?: string;
  agent_name?: string;
  default_agent?: string;
  default_model?: string;
  metadata?: Record<string, unknown>;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function sandboxChannelFetch<T>(sandboxUrl: string, path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/kortix/channels${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body?.error || body?.message || `Request failed (${res.status})`);
  }
  return body;
}

// ─── API Functions ───────────────────────────────────────────────────────────

async function listChannels(sandboxUrl: string): Promise<ChannelConfig[]> {
  // Try the channels API first
  try {
    const data = await sandboxChannelFetch<{ ok?: boolean; channels?: ChannelConfig[]; data?: ChannelConfig[] }>(
      sandboxUrl, '',
    );
    const channels = data.channels || data.data || [];
    if (channels.length > 0) return channels;
  } catch {
    // Channels API may not be available
  }

  // Fallback: detect configured channels from env vars
  const channels: ChannelConfig[] = [];
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const telegramRes = await fetch(`${sandboxUrl}/env/TELEGRAM_BOT_TOKEN`, { headers });
    if (telegramRes.ok) {
      const telegramData = await telegramRes.json() as Record<string, string>;
      if (telegramData?.TELEGRAM_BOT_TOKEN) {
        channels.push({
          id: 'env-telegram',
          platform: 'telegram',
          name: 'Telegram Bot',
          enabled: true,
          bot_username: null,
          default_agent: null,
          default_model: null,
          instructions: null,
          webhook_path: null,
          webhook_url: null,
          created_by: null,
          created_at: new Date().toISOString(),
        });
      }
    }
  } catch { /* ignore */ }

  try {
    const slackRes = await fetch(`${sandboxUrl}/env/SLACK_BOT_TOKEN`, { headers });
    if (slackRes.ok) {
      const slackData = await slackRes.json() as Record<string, string>;
      if (slackData?.SLACK_BOT_TOKEN) {
        channels.push({
          id: 'env-slack',
          platform: 'slack',
          name: 'Slack Bot',
          enabled: true,
          bot_username: null,
          default_agent: null,
          default_model: null,
          instructions: null,
          webhook_path: null,
          webhook_url: null,
          created_by: null,
          created_at: new Date().toISOString(),
        });
      }
    }
  } catch { /* ignore */ }

  return channels;
}

async function getChannel(sandboxUrl: string, id: string): Promise<ChannelConfig> {
  const data = await sandboxChannelFetch<{ ok: boolean; channel: ChannelConfig }>(
    sandboxUrl, `/${id}`,
  );
  return data.channel;
}

async function updateChannel(sandboxUrl: string, id: string, body: UpdateChannelData): Promise<ChannelConfig> {
  const data = await sandboxChannelFetch<{ ok: boolean; channel: ChannelConfig }>(
    sandboxUrl, `/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return data.channel;
}

async function deleteChannel(sandboxUrl: string, id: string): Promise<void> {
  // Env-based channels: remove the env vars instead
  if (id === 'env-telegram') {
    const token = await getAuthToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    // Delete webhook from Telegram
    try {
      const envRes = await fetch(`${sandboxUrl}/env/TELEGRAM_BOT_TOKEN`, { headers });
      if (envRes.ok) {
        const data = await envRes.json() as Record<string, string>;
        if (data?.TELEGRAM_BOT_TOKEN) {
          await fetch(`https://api.telegram.org/bot${data.TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
        }
      }
    } catch { /* ignore */ }
    // Remove env vars
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET_TOKEN']) {
      try { await fetch(`${sandboxUrl}/env/${key}`, { method: 'DELETE', headers }); } catch { /* ignore */ }
    }
    return;
  }
  if (id === 'env-slack') {
    const token = await getAuthToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    for (const key of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) {
      try { await fetch(`${sandboxUrl}/env/${key}`, { method: 'DELETE', headers }); } catch { /* ignore */ }
    }
    return;
  }
  // Regular DB-backed channels
  try {
    await sandboxChannelFetch(sandboxUrl, `/${id}`, { method: 'DELETE' });
  } catch { /* ignore if endpoint unavailable */ }
}

async function enableChannel(sandboxUrl: string, id: string): Promise<ChannelConfig> {
  const data = await sandboxChannelFetch<{ ok: boolean; channel: ChannelConfig }>(
    sandboxUrl, `/${id}/enable`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return data.channel;
}

async function disableChannel(sandboxUrl: string, id: string): Promise<ChannelConfig> {
  const data = await sandboxChannelFetch<{ ok: boolean; channel: ChannelConfig }>(
    sandboxUrl, `/${id}/disable`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return data.channel;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const channelKeys = {
  all: ['channels'] as const,
  list: (sandboxId?: string) => [...channelKeys.all, 'list', sandboxId] as const,
  detail: (id: string) => [...channelKeys.all, 'detail', id] as const,
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useChannels() {
  const { sandboxUrl } = useSandboxContext();
  return useQuery({
    queryKey: channelKeys.list(sandboxUrl),
    queryFn: () => listChannels(sandboxUrl!),
    enabled: !!sandboxUrl,
    staleTime: 60 * 1000,
  });
}

export function useChannel(id: string) {
  const { sandboxUrl } = useSandboxContext();
  return useQuery({
    queryKey: channelKeys.detail(id),
    queryFn: () => getChannel(sandboxUrl!, id),
    enabled: !!sandboxUrl && !!id,
    staleTime: 60 * 1000,
  });
}

export function useUpdateChannel() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateChannelData }) => updateChannel(sandboxUrl!, id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

export function useDeleteChannel() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChannel(sandboxUrl!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

export function useToggleChannel() {
  const { sandboxUrl } = useSandboxContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? enableChannel(sandboxUrl!, id) : disableChannel(sandboxUrl!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function getChannelTypeLabel(type: ChannelType): string {
  const labels: Record<ChannelType, string> = {
    telegram: 'Telegram',
    slack: 'Slack',
    discord: 'Discord',
    whatsapp: 'WhatsApp',
    teams: 'Teams',
    voice: 'Voice',
    email: 'Email',
    sms: 'SMS',
  };
  return labels[type] || type;
}

export function formatChannelDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
