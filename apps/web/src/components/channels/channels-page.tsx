"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Radio,
  Plus,
  Power,
  PowerOff,
  Trash2,
  RefreshCw,
  Settings,
  MessageSquare,
  ExternalLink,
} from 'lucide-react';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { PageHeader } from '@/components/ui/page-header';
import { SlackIcon } from '@/components/ui/icons/slack';
import { TelegramIcon } from '@/components/ui/icons/telegram';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/lib/toast';
import { useServerStore, getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { ChannelConfigDialog } from './channel-config-dialog';
import { ChannelSettingsDialog } from './channel-settings-dialog';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  platform: 'telegram' | 'slack';
  name: string;
  enabled: boolean;
  bot_username: string | null;
  default_agent: string;
  default_model: string;
  instructions?: string;
  webhook_path: string;
  webhook_url?: string | null;
  created_by: string | null;
  created_at: string;
}

// ─── API ────────────────────────────────────────────────────────────────────

async function channelFetch(path: string, opts?: RequestInit): Promise<any> {
  const url = getActiveOpenCodeUrl();
  if (!url) return { ok: false, error: 'No active sandbox' };
  try {
    const res = await authenticatedFetch(`${url}/kortix/channels${path}`, opts);
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (res.ok) return data;
    return data || { ok: false, error: text || `Request failed (${res.status})` };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Request failed' };
  }
}

async function detectChannelsFromEnv(): Promise<Channel[]> {
  const url = getActiveOpenCodeUrl();
  if (!url) return [];
  const channels: Channel[] = [];
  try {
    const res = await authenticatedFetch(`${url}/env/TELEGRAM_BOT_TOKEN`);
    if (res.ok) {
      const data = await res.json() as Record<string, string>;
      if (data?.TELEGRAM_BOT_TOKEN) {
        channels.push({ id: 'env-telegram', platform: 'telegram', name: 'Telegram Bot', enabled: true, bot_username: null, default_agent: '', default_model: '', webhook_path: '', created_by: null, created_at: new Date().toISOString() });
      }
    }
  } catch { /* ignore */ }
  try {
    const res = await authenticatedFetch(`${url}/env/SLACK_BOT_TOKEN`);
    if (res.ok) {
      const data = await res.json() as Record<string, string>;
      if (data?.SLACK_BOT_TOKEN) {
        channels.push({ id: 'env-slack', platform: 'slack', name: 'Slack Bot', enabled: true, bot_username: null, default_agent: '', default_model: '', webhook_path: '', created_by: null, created_at: new Date().toISOString() });
      }
    }
  } catch { /* ignore */ }
  return channels;
}

// ─── Channel Card ───────────────────────────────────────────────────────────

function ChannelCard({
  channel,
  index,
  onToggle,
  onRemove,
  onSettings,
}: {
  channel: Channel;
  index: number;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onSettings: (channel: Channel) => void;
}) {
  const Icon = channel.platform === 'telegram' ? TelegramIcon : SlackIcon;
  const modelShort = channel.default_model ? channel.default_model.split('/').pop() : null;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.3) }}
    >
      <SpotlightCard className="bg-card border border-border/50">
        <div className="p-4 flex items-start gap-3 cursor-pointer group" onClick={() => onSettings(channel)}>
          {/* Icon */}
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-muted border border-border/50 shrink-0">
            <Icon className="h-5 w-5 text-foreground" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="text-sm font-semibold text-foreground truncate">{channel.name}</h3>
              <Badge
                variant={channel.enabled ? "highlight" : "secondary"}
                className="text-[10px] shrink-0"
              >
                {channel.enabled ? "Live" : "Off"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              @{channel.bot_username || '?'}
              {modelShort ? ` · ${modelShort}` : ''}
              {channel.default_agent && channel.default_agent !== 'kortix' ? ` · ${channel.default_agent}` : ''}
            </p>
            {channel.webhook_url && (
              <p className="text-[10px] text-muted-foreground/50 truncate mt-0.5 font-mono">
                {channel.webhook_url.replace(/^https?:\/\//, '').slice(0, 45)}…
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => onSettings(channel)}>
              <Settings className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onToggle(channel.id, !channel.enabled)}>
              {channel.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => onRemove(channel.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </SpotlightCard>
    </motion.div>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

export function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [configDialogPlatform, setConfigDialogPlatform] = useState<'telegram' | 'slack' | undefined>(undefined);
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Channel | null>(null);
  const [removing, setRemoving] = useState(false);

  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  const load = useCallback(async () => {
    const data = await channelFetch('');
    if (data?.ok && data.channels?.length > 0) {
      setChannels(data.channels);
    } else {
      // Fallback: detect from env vars
      const envChannels = await detectChannelsFromEnv();
      setChannels(envChannels);
    }
    setLoading(false);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (serverUrl) load();
  }, [serverUrl, load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!loaded) load();
    }, 2000);
    return () => clearTimeout(timer);
  }, [loaded, load]);

  const handleToggle = async (id: string, enabled: boolean) => {
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, enabled } : ch));
    const data = await channelFetch(`/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    if (data?.ok) {
      toast.success(enabled ? 'Channel enabled' : 'Channel disabled');
    } else {
      setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, enabled: !enabled } : ch));
      toast.error('Failed to update channel', {
        description: data?.error || 'The sandbox did not accept the channel state change.',
      });
    }
  };

  const handleRemove = (id: string) => {
    const ch = channels.find(c => c.id === id) || null;
    setRemoveTarget(ch);
  };

  const confirmRemove = async () => {
    const ch = removeTarget;
    if (!ch) return;
    setRemoving(true);
    setChannels(prev => prev.filter(c => c.id !== ch.id));

    try {
      // Env-based channels: remove env vars
      if (ch.id === 'env-telegram') {
        const url = getActiveOpenCodeUrl();
        if (url) {
          try {
            const envRes = await authenticatedFetch(`${url}/env/TELEGRAM_BOT_TOKEN`);
            if (envRes.ok) {
              const data = await envRes.json() as Record<string, string>;
              if (data?.TELEGRAM_BOT_TOKEN) {
                await fetch(`https://api.telegram.org/bot${data.TELEGRAM_BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
              }
            }
          } catch { /* ignore */ }
          for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET_TOKEN']) {
            try { await authenticatedFetch(`${url}/env/${key}`, { method: 'DELETE' }); } catch { /* ignore */ }
          }
        }
        toast.success('Telegram channel removed');
        setRemoveTarget(null);
        await load();
        return;
      }

      if (ch.id === 'env-slack') {
        const url = getActiveOpenCodeUrl();
        if (url) {
          for (const key of ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']) {
            try { await authenticatedFetch(`${url}/env/${key}`, { method: 'DELETE' }); } catch { /* ignore */ }
          }
        }
        toast.success('Slack channel removed');
        setRemoveTarget(null);
        await load();
        return;
      }

      // Regular DB-backed channels
      const data = await channelFetch(`/${ch.id}`, { method: 'DELETE' });
      if (data?.ok) {
        toast.success('Channel removed', {
          description: data?.message || `${ch.name} removed`,
        });
        if (settingsChannel?.id === ch.id) {
          setSettingsOpen(false);
          setSettingsChannel(null);
        }
        setRemoveTarget(null);
        await load();
      } else {
        await load();
        toast.error('Failed to remove channel', {
          description: data?.error || 'The sandbox did not remove the channel.',
        });
      }
    } catch (error: any) {
      await load();
      toast.error('Failed to remove channel', {
        description: error?.message || 'The sandbox did not remove the channel.',
      });
    } finally {
      setRemoving(false);
    }
  };

  const openSetupDialog = (platform?: 'telegram' | 'slack') => {
    setConfigDialogPlatform(platform);
    setConfigDialogOpen(true);
  };

  const telegramChannels = channels.filter(c => c.platform === 'telegram');
  const slackChannels = channels.filter(c => c.platform === 'slack');

  return (
    <div className="min-h-[100dvh]">
      {/* Page header — matches /triggers and /tunnel */}
      <div className="container mx-auto max-w-7xl px-3 sm:px-4 py-3 sm:py-4 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">
        <PageHeader icon={Radio}>
          <div className="space-y-2 sm:space-y-4">
            <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
              <span className="text-primary">Channels</span>
            </div>
          </div>
        </PageHeader>
      </div>

      <div className="container mx-auto max-w-7xl px-3 sm:px-4 pb-8">
        {/* Action bar */}
        {channels.length > 0 && (
          <div className="flex items-center justify-between gap-4 pb-4 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both delay-75">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your Channels</span>
              <Badge variant="secondary" className="text-xs tabular-nums">{channels.length}</Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={load}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" className="gap-1.5" onClick={() => openSetupDialog()}>
                <Plus className="h-3.5 w-3.5" />
                Add Channel
              </Button>
            </div>
          </div>
        )}
        {loading && !loaded ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-2xl border bg-card p-4 flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : channels.length === 0 ? (
          /* ── Empty state ── */
          <div className="space-y-4">
            <div className="text-center py-8">
              <div className="w-12 h-12 rounded-2xl bg-muted border flex items-center justify-center mx-auto mb-3">
                <MessageSquare className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-base font-semibold mb-1">No channels yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Connect a messaging platform so users can talk to your agent directly.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg mx-auto">
              <button
                onClick={() => openSetupDialog('telegram')}
                className="flex items-center gap-3 p-4 rounded-2xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-muted border border-border/50 flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
                  <TelegramIcon className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Telegram</p>
                  <p className="text-[11px] text-muted-foreground">Connect a Telegram bot</p>
                </div>
              </button>
              <button
                onClick={() => openSetupDialog('slack')}
                className="flex items-center gap-3 p-4 rounded-2xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-muted border border-border/50 flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
                  <SlackIcon className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Slack</p>
                  <p className="text-[11px] text-muted-foreground">Connect a Slack app</p>
                </div>
              </button>
            </div>
          </div>
        ) : (
          /* ── Channel list ── */
          <div className="space-y-6">
            {telegramChannels.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <TelegramIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Telegram</span>
                  <Badge variant="secondary" className="text-[10px] tabular-nums">{telegramChannels.length}</Badge>
                </div>
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {telegramChannels.map((ch, i) => (
                      <ChannelCard key={ch.id} channel={ch} index={i} onToggle={handleToggle} onRemove={handleRemove} onSettings={(ch) => { setSettingsChannel(ch); setSettingsOpen(true); }} />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {slackChannels.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <SlackIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Slack</span>
                  <Badge variant="secondary" className="text-[10px] tabular-nums">{slackChannels.length}</Badge>
                </div>
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {slackChannels.map((ch, i) => (
                      <ChannelCard key={ch.id} channel={ch} index={i} onToggle={handleToggle} onRemove={handleRemove} onSettings={(ch) => { setSettingsChannel(ch); setSettingsOpen(true); }} />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <ChannelConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        onCreated={() => load()}
        initialPlatform={configDialogPlatform}
      />

      <ChannelSettingsDialog
        channel={settingsChannel}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onUpdated={load}
      />

      <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => {
        if (!open && !removing) setRemoveTarget(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove channel?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `This will disconnect ${removeTarget.name} from this instance.`
                : 'This will disconnect the selected channel from this instance.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void confirmRemove();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? 'Removing…' : 'Remove channel'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
