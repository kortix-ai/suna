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
import { WhatsAppIcon } from '@/components/ui/icons/whatsapp';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useServerStore, getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { ChannelConfigDialog } from './channel-config-dialog';
import { ChannelSettingsDialog } from './channel-settings-dialog';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  platform: 'telegram' | 'slack' | 'whatsapp';
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
  if (!url) return null;
  try {
    const res = await authenticatedFetch(`${url}/kortix/channels${path}`, opts);
    return await res.json();
  } catch {
    return null;
  }
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
  const Icon = channel.platform === 'telegram' ? TelegramIcon : channel.platform === 'whatsapp' ? WhatsAppIcon : SlackIcon;
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

  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  const load = useCallback(async () => {
    const data = await channelFetch('');
    if (data?.ok) {
      setChannels(data.channels);
    } else {
      setChannels([]);
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
      toast.success(enabled ? 'Enabled' : 'Disabled');
    } else {
      setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, enabled: !enabled } : ch));
      toast.error('Failed');
    }
  };

  const handleRemove = async (id: string) => {
    const ch = channels.find(c => c.id === id);
    if (!confirm(`Remove ${ch?.name}?`)) return;
    setChannels(prev => prev.filter(c => c.id !== id));
    const data = await channelFetch(`/${id}`, { method: 'DELETE' });
    if (data?.ok) {
      toast.success('Removed');
    } else {
      load();
      toast.error('Failed');
    }
  };

  const openSetupDialog = (platform?: 'telegram' | 'slack' | 'whatsapp') => {
    setConfigDialogPlatform(platform);
    setConfigDialogOpen(true);
  };

  const telegramChannels = channels.filter(c => c.platform === 'telegram');
  const slackChannels = channels.filter(c => c.platform === 'slack');
  const whatsappChannels = channels.filter(c => c.platform === 'whatsapp');

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
              <button
                onClick={() => openSetupDialog('whatsapp')}
                className="flex items-center gap-3 p-4 rounded-2xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer text-left group"
              >
                <div className="w-10 h-10 rounded-xl bg-muted border border-border/50 flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
                  <WhatsAppIcon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-medium">WhatsApp</p>
                  <p className="text-[11px] text-muted-foreground">Connect a WhatsApp Business number</p>
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

            {whatsappChannels.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <WhatsAppIcon className="h-3.5 w-3.5" />
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">WhatsApp</span>
                  <Badge variant="secondary" className="text-[10px] tabular-nums">{whatsappChannels.length}</Badge>
                </div>
                <div className="space-y-2">
                  <AnimatePresence mode="popLayout">
                    {whatsappChannels.map((ch, i) => (
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
    </div>
  );
}
