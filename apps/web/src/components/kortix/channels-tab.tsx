'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Radio, Plus, Power, PowerOff, RefreshCcw, Trash2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { SlackIcon } from '@/components/ui/icons/slack';
import { TelegramIcon } from '@/components/ui/icons/telegram';
import { DiscordIcon } from '@/components/ui/icons/discord';
import { toast } from '@/lib/toast';
import {
  createProjectChannel,
  deleteProjectChannel,
  listProjectChannels,
  startProjectChannelOAuth,
  updateProjectChannel,
  type ProjectChannel,
  type ProjectChannelPlatform,
} from '@/lib/projects-client';

const platformLabels: Record<ProjectChannelPlatform, string> = {
  slack: 'Slack',
  telegram: 'Telegram',
  msteams: 'MS Teams',
  discord: 'Discord',
};

const platformIcons: Partial<Record<ProjectChannelPlatform, React.ComponentType<{ className?: string }>>> = {
  slack: SlackIcon,
  telegram: TelegramIcon,
  discord: DiscordIcon,
};

type Draft = {
  platform: ProjectChannelPlatform;
  external_channel_id: string;
  external_team_id: string;
  name: string;
  secret: string;
  agent_name: string;
  prompt_template: string;
};

const defaultDraft: Draft = {
  platform: 'slack',
  external_channel_id: '',
  external_team_id: '',
  name: '',
  secret: '',
  agent_name: 'default',
  prompt_template: '{{ message.text }}',
};

export function ChannelsTab({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<ProjectChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [oauthStarting, setOauthStarting] = useState<ProjectChannelPlatform | null>(null);
  const [draft, setDraft] = useState<Draft>(defaultDraft);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChannels(await listProjectChannels(projectId));
    } catch (error) {
      toast.error('Failed to load channels', { description: error instanceof Error ? error.message : String(error) });
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    return channels.reduce<Record<ProjectChannelPlatform, ProjectChannel[]>>((acc, channel) => {
      acc[channel.platform] = [...(acc[channel.platform] ?? []), channel];
      return acc;
    }, { slack: [], telegram: [], msteams: [], discord: [] });
  }, [channels]);

  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleCreate = async () => {
    if (!draft.external_channel_id.trim()) {
      toast.error('External channel id is required');
      return;
    }
    if (!draft.secret.trim()) {
      toast.error('Signing secret is required');
      return;
    }

    setSaving(true);
    try {
      await createProjectChannel(projectId, {
        platform: draft.platform,
        external_channel_id: draft.external_channel_id.trim(),
        external_team_id: draft.external_team_id.trim() || null,
        name: draft.name.trim() || null,
        config: { secret: draft.secret.trim() },
        agent_name: draft.agent_name.trim() || 'default',
        prompt_template: draft.prompt_template.trim() || '{{ message.text }}',
        enabled: true,
      });
      setDraft(defaultDraft);
      toast.success('Channel added');
      await load();
    } catch (error) {
      toast.error('Failed to add channel', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (channel: ProjectChannel) => {
    const enabled = !channel.enabled;
    setChannels((current) => current.map((item) => item.channel_id === channel.channel_id ? { ...item, enabled } : item));
    try {
      await updateProjectChannel(projectId, channel.channel_id, { enabled });
      toast.success(enabled ? 'Channel enabled' : 'Channel disabled');
    } catch (error) {
      setChannels((current) => current.map((item) => item.channel_id === channel.channel_id ? { ...item, enabled: channel.enabled } : item));
      toast.error('Failed to update channel', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleDelete = async (channel: ProjectChannel) => {
    setChannels((current) => current.filter((item) => item.channel_id !== channel.channel_id));
    try {
      await deleteProjectChannel(projectId, channel.channel_id);
      toast.success('Channel removed');
    } catch (error) {
      toast.error('Failed to remove channel', { description: error instanceof Error ? error.message : String(error) });
      await load();
    }
  };

  const handleOAuth = async (platform: ProjectChannelPlatform) => {
    setOauthStarting(platform);
    try {
      const result = await startProjectChannelOAuth(projectId, { platform, app: platform });
      window.location.href = result.authorization_url;
    } catch (error) {
      toast.error('OAuth is not configured for this channel', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOauthStarting(null);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Channels</span>
          <Badge variant="secondary" className="text-[10px] tabular-nums">{channels.length}</Badge>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[12px]" onClick={() => void load()} disabled={loading}>
          <RefreshCcw className="h-3 w-3" />
          Refresh
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        <div className="rounded-lg border border-border/50 bg-card p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Add channel</h3>
              <p className="text-[12px] text-muted-foreground">Public events must be signed with this channel secret.</p>
            </div>
            <div className="flex items-center gap-1">
              {(['slack', 'telegram', 'discord'] as ProjectChannelPlatform[]).map((platform) => (
                <Button
                  key={platform}
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[12px]"
                  onClick={() => void handleOAuth(platform)}
                  disabled={oauthStarting !== null}
                >
                  <ExternalLink className="h-3 w-3" />
                  {oauthStarting === platform ? 'Opening' : platformLabels[platform]}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Platform</span>
              <select
                value={draft.platform}
                onChange={(event) => updateDraft('platform', event.target.value as ProjectChannelPlatform)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {Object.entries(platformLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Name</span>
              <Input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="engineering" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">External channel id</span>
              <Input value={draft.external_channel_id} onChange={(event) => updateDraft('external_channel_id', event.target.value)} placeholder="C0123 or chat id" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">External team id</span>
              <Input value={draft.external_team_id} onChange={(event) => updateDraft('external_team_id', event.target.value)} placeholder="T0123" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Signing secret</span>
              <Input type="password" value={draft.secret} onChange={(event) => updateDraft('secret', event.target.value)} placeholder="Webhook signing secret" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">Agent</span>
              <Input value={draft.agent_name} onChange={(event) => updateDraft('agent_name', event.target.value)} placeholder="default" />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">Prompt template</span>
            <Textarea
              value={draft.prompt_template}
              onChange={(event) => updateDraft('prompt_template', event.target.value)}
              className="min-h-20"
              placeholder="{{ message.text }}"
            />
          </label>
          <div className="flex justify-end">
            <Button size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => void handleCreate()} disabled={saving}>
              <Plus className="h-3 w-3" />
              {saving ? 'Adding' : 'Add channel'}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <div key={index} className="rounded-lg border border-border/50 bg-card p-3">
                <Skeleton className="h-4 w-36 mb-2" />
                <Skeleton className="h-3 w-64" />
              </div>
            ))}
          </div>
        ) : channels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-6 text-center">
            <p className="text-sm font-medium">No project channels</p>
            <p className="text-[12px] text-muted-foreground mt-1">Add Slack, Telegram, MS Teams, or Discord ingress for this project.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {(Object.keys(platformLabels) as ProjectChannelPlatform[])
              .filter((platform) => grouped[platform].length > 0)
              .map((platform) => (
                <ChannelGroup
                  key={platform}
                  platform={platform}
                  channels={grouped[platform]}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelGroup({
  platform,
  channels,
  onToggle,
  onDelete,
}: {
  platform: ProjectChannelPlatform;
  channels: ProjectChannel[];
  onToggle: (channel: ProjectChannel) => void;
  onDelete: (channel: ProjectChannel) => void;
}) {
  const Icon = platformIcons[platform] ?? Radio;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{platformLabels[platform]}</span>
        <Badge variant="secondary" className="text-[10px] tabular-nums">{channels.length}</Badge>
      </div>
      <div className="space-y-2">
        {channels.map((channel) => (
          <ChannelRow key={channel.channel_id} channel={channel} Icon={Icon} onToggle={onToggle} onDelete={onDelete} />
        ))}
      </div>
    </section>
  );
}

function ChannelRow({
  channel,
  Icon,
  onToggle,
  onDelete,
}: {
  channel: ProjectChannel;
  Icon: React.ComponentType<{ className?: string }>;
  onToggle: (channel: ProjectChannel) => void;
  onDelete: (channel: ProjectChannel) => void;
}) {
  const webhookPath = `/v1/channels/${channel.platform}/${channel.channel_id}/events`;
  return (
    <div className="rounded-lg border border-border/50 bg-card p-3 flex items-start gap-3">
      <div className="h-9 w-9 rounded-md border border-border/50 bg-muted flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold truncate">{channel.name || channel.external_channel_id}</p>
          <Badge variant={channel.enabled && channel.status === 'active' ? 'highlight' : 'secondary'} className="text-[10px]">
            {channel.enabled && channel.status === 'active' ? 'Live' : channel.status}
          </Badge>
          {channel.config?.has_secret ? <Badge variant="secondary" className="text-[10px]">Secret set</Badge> : null}
        </div>
        <p className="text-[12px] text-muted-foreground truncate">
          {channel.external_channel_id}{channel.external_team_id ? ` / ${channel.external_team_id}` : ''} - {channel.agent_name}
        </p>
        <code className="mt-1 block text-[11px] text-muted-foreground truncate">{webhookPath}</code>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onToggle(channel)}>
          {channel.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => onDelete(channel)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
