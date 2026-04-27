'use client';

/**
 * Project Channels tab — filtered view of /kortix/channels scoped to
 * `project_id = <projectId>`. Mirrors TriggersTab in shape: same section
 * lives on the workspace-global Channels page; this tab is just the
 * narrowed slice plus an "Add" button that pre-stamps project_id so the
 * new channel surfaces here on next load.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { TelegramIcon } from '@/components/ui/icons/telegram';
import { SlackIcon } from '@/components/ui/icons/slack';
import { Plus, Power, PowerOff, Settings, Trash2, Radio, MessageSquare } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useServerStore } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { ChannelConfigDialog } from '@/components/channels/channel-config-dialog';
import { ChannelSettingsDialog } from '@/components/channels/channel-settings-dialog';

interface Channel {
  id: string;
  platform: 'telegram' | 'slack';
  name: string;
  enabled: boolean;
  bot_username: string | null;
  default_agent: string;
  default_model: string;
  instructions?: string;
  project_id?: string | null;
  webhook_path: string;
  webhook_url?: string | null;
  created_by: string | null;
  created_at: string;
}

async function projectChannelsFetch(serverUrl: string, path: string, opts?: RequestInit): Promise<any> {
  try {
    const res = await authenticatedFetch(`${serverUrl}/kortix/channels${path}`, opts);
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (res.ok) return data;
    return data || { ok: false, error: text || `Request failed (${res.status})` };
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Request failed' };
  }
}

export function ChannelsTab({ projectId }: { projectId: string }) {
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);
  const [configPlatform, setConfigPlatform] = useState<'telegram' | 'slack' | undefined>(undefined);
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Channel | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    if (!serverUrl) return;
    setLoading(true);
    const data = await projectChannelsFetch(
      serverUrl,
      `?project_id=${encodeURIComponent(projectId)}`,
    );
    if (data?.ok && Array.isArray(data.channels)) {
      setChannels(data.channels);
    } else {
      setChannels([]);
    }
    setLoading(false);
  }, [serverUrl, projectId]);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (id: string, enabled: boolean) => {
    if (!serverUrl) return;
    setChannels((prev) => prev.map((ch) => ch.id === id ? { ...ch, enabled } : ch));
    const data = await projectChannelsFetch(serverUrl, `/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    if (!data?.ok) {
      setChannels((prev) => prev.map((ch) => ch.id === id ? { ...ch, enabled: !enabled } : ch));
      toast.error('Failed to update channel', { description: data?.error });
    } else {
      toast.success(enabled ? 'Channel enabled' : 'Channel disabled');
    }
  };

  const handleRemoveConfirm = async () => {
    if (!removeTarget || !serverUrl) return;
    setRemoving(true);
    const ch = removeTarget;
    setChannels((prev) => prev.filter((c) => c.id !== ch.id));
    const data = await projectChannelsFetch(serverUrl, `/${ch.id}`, { method: 'DELETE' });
    setRemoving(false);
    setRemoveTarget(null);
    if (!data?.ok) {
      toast.error('Failed to remove channel', { description: data?.error });
      await load();
      return;
    }
    toast.success('Channel removed');
    if (settingsChannel?.id === ch.id) {
      setSettingsOpen(false);
      setSettingsChannel(null);
    }
    await load();
  };

  const telegram = useMemo(() => channels.filter((c) => c.platform === 'telegram'), [channels]);
  const slack = useMemo(() => channels.filter((c) => c.platform === 'slack'), [channels]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border/40 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Channels</span>
          <Badge variant="secondary" className="text-[10px] tabular-nums">{channels.length}</Badge>
        </div>
        <Button
          size="sm"
          className="gap-1.5 h-7 text-[12px]"
          onClick={() => { setConfigPlatform(undefined); setConfigOpen(true); }}
          disabled={!serverUrl}
        >
          <Plus className="h-3 w-3" />
          Add
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-xl border bg-card p-3 flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : channels.length === 0 ? (
          <EmptyState
            onAdd={(p) => { setConfigPlatform(p); setConfigOpen(true); }}
          />
        ) : (
          <div className="space-y-4">
            {telegram.length > 0 && (
              <ChannelGroup
                title="Telegram"
                Icon={TelegramIcon}
                channels={telegram}
                onToggle={handleToggle}
                onRemove={(c) => setRemoveTarget(c)}
                onSettings={(c) => { setSettingsChannel(c); setSettingsOpen(true); }}
              />
            )}
            {slack.length > 0 && (
              <ChannelGroup
                title="Slack"
                Icon={SlackIcon}
                channels={slack}
                onToggle={handleToggle}
                onRemove={(c) => setRemoveTarget(c)}
                onSettings={(c) => { setSettingsChannel(c); setSettingsOpen(true); }}
              />
            )}
          </div>
        )}
      </div>

      <ChannelConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        onCreated={() => { void load(); }}
        initialPlatform={configPlatform}
        initialProjectId={projectId}
      />

      <ChannelSettingsDialog
        channel={settingsChannel}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onUpdated={load}
      />

      <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open && !removing) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove channel?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `This disconnects ${removeTarget.name} from this project.`
                : 'This disconnects the selected channel.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => { e.preventDefault(); void handleRemoveConfirm(); }}
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

// ─── Sub-components ─────────────────────────────────────────────────────────

function ChannelGroup({
  title,
  Icon,
  channels,
  onToggle,
  onRemove,
  onSettings,
}: {
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  channels: Channel[];
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (ch: Channel) => void;
  onSettings: (ch: Channel) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-3 w-3 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
        <Badge variant="secondary" className="text-[10px] tabular-nums">{channels.length}</Badge>
      </div>
      <div className="space-y-2">
        <AnimatePresence mode="popLayout">
          {channels.map((ch) => (
            <motion.div
              key={ch.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.15 }}
            >
              <ChannelRow ch={ch} Icon={Icon} onToggle={onToggle} onRemove={onRemove} onSettings={onSettings} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ChannelRow({
  ch,
  Icon,
  onToggle,
  onRemove,
  onSettings,
}: {
  ch: Channel;
  Icon: React.ComponentType<{ className?: string }>;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (ch: Channel) => void;
  onSettings: (ch: Channel) => void;
}) {
  const modelShort = ch.default_model ? ch.default_model.split('/').pop() : null;
  return (
    <div
      className="rounded-xl border border-border/50 bg-card p-3 flex items-start gap-3 cursor-pointer hover:bg-muted/30 transition-colors group"
      onClick={() => onSettings(ch)}
    >
      <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted border border-border/50 shrink-0">
        <Icon className="h-4 w-4 text-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <h4 className="text-sm font-semibold text-foreground truncate">{ch.name}</h4>
          <Badge variant={ch.enabled ? 'highlight' : 'secondary'} className="text-[10px] shrink-0">
            {ch.enabled ? 'Live' : 'Off'}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground truncate">
          @{ch.bot_username || '?'}
          {modelShort ? ` · ${modelShort}` : ''}
          {ch.default_agent && ch.default_agent !== 'kortix' ? ` · ${ch.default_agent}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => onSettings(ch)}>
          <Settings className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onToggle(ch.id, !ch.enabled)}>
          {ch.enabled ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => onRemove(ch)}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: (platform: 'telegram' | 'slack') => void }) {
  return (
    <div className="space-y-3 py-4">
      <div className="text-center py-4">
        <div className="w-10 h-10 rounded-xl bg-muted border flex items-center justify-center mx-auto mb-2">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
        </div>
        <h4 className="text-sm font-semibold mb-0.5">No channels in this project</h4>
        <p className="text-[12px] text-muted-foreground max-w-sm mx-auto">
          Connect Telegram or Slack — messages will dispatch to this project's agents.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md mx-auto">
        <button
          onClick={() => onAdd('telegram')}
          className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer text-left group"
        >
          <div className="w-8 h-8 rounded-lg bg-muted border border-border/50 flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
            <TelegramIcon className="h-4 w-4 text-foreground" />
          </div>
          <div>
            <p className="text-[13px] font-medium">Telegram</p>
            <p className="text-[11px] text-muted-foreground">Connect a Telegram bot</p>
          </div>
        </button>
        <button
          onClick={() => onAdd('slack')}
          className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer text-left group"
        >
          <div className="w-8 h-8 rounded-lg bg-muted border border-border/50 flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
            <SlackIcon className="h-4 w-4 text-foreground" />
          </div>
          <div>
            <p className="text-[13px] font-medium">Slack</p>
            <p className="text-[11px] text-muted-foreground">Connect a Slack app</p>
          </div>
        </button>
      </div>
    </div>
  );
}
