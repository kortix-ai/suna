"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Loader2, Save, Copy, Check, ExternalLink } from 'lucide-react';
import { SlackIcon } from '@/components/ui/icons/slack';
import { TelegramIcon } from '@/components/ui/icons/telegram';
import { toast } from '@/lib/toast';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { AgentSelector, flattenModels } from '@/components/session/session-chat-input';
import { ModelSelector } from '@/components/session/model-selector';
import { useVisibleAgents, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';

interface Channel {
  id: string;
  platform: 'telegram' | 'slack';
  name: string;
  enabled: boolean;
  bot_username: string | null;
  default_agent: string;
  default_model: string;
  bridge_instructions?: string;
  instructions?: string;
  webhook_path: string;
  webhook_url?: string | null;
  created_by: string | null;
  created_at: string;
}

interface ChannelSettingsDialogProps {
  channel: Channel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

function WebhookCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button variant="ghost" size="sm" onClick={handleCopy} className="h-6 px-2 text-[11px] gap-1">
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function ChannelSettingsDialog({ channel, open, onOpenChange, onUpdated }: ChannelSettingsDialogProps) {
  const [name, setName] = useState('');
  const [agentName, setAgentName] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(null);
  const [bridgeInstructions, setBridgeInstructions] = useState('');
  const [instructions, setInstructions] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const agents = useVisibleAgents();
  const { data: providers, isLoading: modelsLoading } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  useEffect(() => {
    if (channel) {
      setName(channel.name);
      setAgentName(channel.default_agent || 'kortix');
      setBridgeInstructions(channel.bridge_instructions || '');
      setInstructions(channel.instructions || '');
      setEnabled(channel.enabled);

      // Parse "provider/model" string into the selector format
      if (channel.default_model && channel.default_model.includes('/')) {
        const [providerID, ...rest] = channel.default_model.split('/');
        setSelectedModel({ providerID, modelID: rest.join('/') });
      } else if (channel.default_model) {
        setSelectedModel({ providerID: 'kortix', modelID: channel.default_model });
      } else {
        setSelectedModel(null);
      }
    }
  }, [channel]);

  const handleSave = async () => {
    if (!channel) return;
    setSaving(true);
    try {
      const url = getActiveOpenCodeUrl();
      if (!url) throw new Error('No sandbox');

      // Build model string from selector
      const modelStr = selectedModel
        ? `${selectedModel.providerID}/${selectedModel.modelID}`
        : '';

      const res = await authenticatedFetch(`${url}/kortix/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          default_agent: agentName || undefined,
          default_model: modelStr || undefined,
          bridge_instructions: bridgeInstructions.trim(),
          instructions: instructions.trim(),
          enabled,
        }),
      });
      const data = await res.json() as any;
      if (data.ok) {
        toast.success('Channel settings saved', {
          description: data?.sessionReset
            ? 'Active channel sessions were reset so agent/model/instruction changes apply on the next message.'
            : 'Changes saved successfully.',
        });
        onUpdated();
        onOpenChange(false);
      } else {
        toast.error('Failed to save channel settings', {
          description: data.error || 'The sandbox rejected the channel update.',
        });
      }
    } catch (err: any) {
      toast.error('Failed to save channel settings', {
        description: err.message || 'The request did not complete.',
      });
    } finally {
      setSaving(false);
    }
  };

  if (!channel) return null;

  const Icon = channel.platform === 'telegram' ? TelegramIcon : SlackIcon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50">
              <Icon className="h-4.5 w-4.5 text-foreground" />
            </div>
            <div>
              <DialogTitle>{channel.name}</DialogTitle>
              <p className="text-xs text-muted-foreground">@{channel.bot_username || '?'} · {channel.platform}</p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {/* Enabled */}
          <div className="flex items-center justify-between rounded-xl border px-4 py-3">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground">Receive and respond to messages</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <Label className="text-xs">Channel Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Bot" />
          </div>

          {/* Agent */}
          <div className="space-y-1.5">
            <Label className="text-xs">Agent</Label>
            <div className="rounded-xl border bg-card px-2 py-1">
              <AgentSelector
                agents={agents}
                selectedAgent={agentName}
                onSelect={(next) => setAgentName(next)}
              />
            </div>
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <Label className="text-xs">Model</Label>
            {modelsLoading ? (
              <div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
              </div>
            ) : (
              <div className="rounded-xl border bg-card px-2 py-1">
                <ModelSelector
                  models={models}
                  selectedModel={selectedModel}
                  onSelect={(next) => setSelectedModel(next)}
                />
              </div>
            )}
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <Label className="text-xs">Bridge Instructions</Label>
            <Textarea
              value={bridgeInstructions}
              onChange={(e) => setBridgeInstructions(e.target.value)}
              placeholder="Optional per-channel delivery instructions appended to the Slack/Telegram bridge prompt..."
              rows={3}
              className="text-sm resize-none"
            />
            <p className="text-[11px] text-muted-foreground">
              Appended to the built-in platform bridge instructions on every incoming message.
            </p>
          </div>

          {/* System Instructions */}
          <div className="space-y-1.5">
            <Label className="text-xs">System Instructions</Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Optional custom instructions for this channel's agent..."
              rows={3}
              className="text-sm resize-none"
            />
            <p className="text-[11px] text-muted-foreground">
              Used as the system prompt for sessions started from this channel. Saving resets active channel sessions so changes apply on the next message.
            </p>
          </div>

          {/* Webhook URL */}
          <div className="rounded-xl border bg-muted/30 px-4 py-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                <Label className="text-xs font-medium">Webhook URL</Label>
              </div>
              {channel.webhook_url && <WebhookCopyButton value={channel.webhook_url} />}
            </div>
            {channel.webhook_url ? (
              <Input value={channel.webhook_url} readOnly className="font-mono text-xs" />
            ) : (
              <>
                <Input value={channel.webhook_path} readOnly className="font-mono text-xs text-muted-foreground" />
                <p className="text-[11px] text-amber-600">Public URL not resolved. Set PUBLIC_BASE_URL or configure the share system.</p>
              </>
            )}
            <p className="text-[11px] text-muted-foreground">
              {channel.platform === 'telegram'
                ? 'Telegram sends webhook events to this URL. It was set during bot setup.'
                : 'Set this as the Request URL in your Slack app → Event Subscriptions.'}
            </p>
          </div>

          {/* Save */}
          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Settings
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
