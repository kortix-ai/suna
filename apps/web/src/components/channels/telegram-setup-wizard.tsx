"use client";

import React, { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { TelegramIcon } from '@/components/ui/icons/telegram';
import { toast } from 'sonner';
import { useTelegramVerifyToken, useTelegramConnect } from '@/hooks/channels/use-telegram-wizard';
import { AgentSelector, flattenModels } from '@/components/session/session-chat-input';
import { ModelSelector } from '@/components/session/model-selector';
import { useVisibleAgents, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { useKortixProjects } from '@/hooks/kortix/use-kortix-projects';
import { ChannelProjectPicker } from './channel-project-picker';

interface TelegramSetupWizardProps {
  onCreated: () => void;
  onBack: () => void;
  /** Pre-select a project (e.g. when launched from a project-filtered view) */
  initialProjectId?: string | null;
}

export function TelegramSetupWizard({ onCreated, onBack, initialProjectId = null }: TelegramSetupWizardProps) {
  const [botToken, setBotToken] = useState('');
  const [botInfo, setBotInfo] = useState<{ id: number; username: string; firstName: string } | null>(null);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [agentName, setAgentName] = useState<string | null>('kortix');
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(null);

  const verifyToken = useTelegramVerifyToken();
  const connect = useTelegramConnect();

  // Project list — used to resolve the project's working directory so the
  // agent picker shows that project's per-role agents (engineer, qa, …).
  const { data: projects = [] } = useKortixProjects();
  const projectDirectory = useMemo(
    () => projects.find((p) => p.id === projectId)?.path,
    [projects, projectId],
  );

  const agents = useVisibleAgents(projectDirectory ? { directory: projectDirectory } : undefined);
  const { data: providers, isLoading: modelsLoading } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  // When the project changes, the available agent set changes — reset the
  // picked agent if it isn't valid for the new scope so we never persist
  // a stale slug. `kortix` is always present, so it's a safe default.
  useEffect(() => {
    if (!agentName) return;
    if (agents.length === 0) return;
    const stillValid = agents.some((a) => a.name === agentName);
    if (!stillValid) setAgentName('kortix');
  }, [agents, agentName]);

  const handleVerify = async () => {
    const trimmed = botToken.trim();
    if (!trimmed) return;
    const result = await verifyToken.mutateAsync({ botToken: trimmed });
    if (result.ok && result.bot) {
      setBotInfo(result.bot);
      toast.success(`Verified: @${result.bot.username}`);
    } else {
      toast.error(result.error || 'Invalid token');
    }
  };

  const handleConnect = async () => {
    const trimmed = botToken.trim();
    if (!trimmed) return;

    if (!botInfo) {
      const result = await verifyToken.mutateAsync({ botToken: trimmed });
      if (!result.ok || !result.bot) {
        toast.error(result.error || 'Invalid token');
        return;
      }
      setBotInfo(result.bot);
    }

    const modelStr = selectedModel
      ? `${selectedModel.providerID}/${selectedModel.modelID}`
      : undefined;

    try {
      const result = await connect.mutateAsync({
        botToken: trimmed,
        publicUrl: '',
        defaultAgent: agentName || undefined,
        defaultModel: modelStr,
        projectId,
      });
      const webhookUrl = result.channel?.webhookUrl;
      if (webhookUrl) {
        toast.success(`Connected! Webhook: ${webhookUrl}`, { duration: 8000 });
      } else {
        toast.success(result.message || 'Telegram bot connected!');
      }
      onCreated();
    } catch (err: any) {
      toast.error(err.message || 'Setup failed');
    }
  };

  const isWorking = verifyToken.isPending || connect.isPending;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button onClick={onBack} variant="ghost" size="icon">
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </Button>
        <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50">
          <TelegramIcon className="h-4.5 w-4.5 text-foreground" />
        </div>
        <div>
          <h3 className="text-base font-semibold">Telegram Setup</h3>
          <p className="text-xs text-muted-foreground">Connect a Telegram bot to your agent</p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Instructions */}
        <div className="rounded-xl border border-border/50 bg-muted/30 p-4 text-sm text-muted-foreground space-y-2">
          <p>
            <span className="font-medium text-foreground">1.</span>{' '}
            Open{' '}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
              @BotFather <ExternalLink className="h-3 w-3" />
            </a>{' '}
            in Telegram
          </p>
          <p>
            <span className="font-medium text-foreground">2.</span>{' '}
            Send <code className="px-1.5 py-0.5 rounded bg-muted text-foreground text-xs">/newbot</code> and follow the prompts
          </p>
          <p>
            <span className="font-medium text-foreground">3.</span>{' '}
            Copy the bot token and paste it below
          </p>
        </div>

        {/* Token input */}
        <div className="space-y-2">
          <Label htmlFor="bot-token">Bot Token</Label>
          <Input
            id="bot-token"
            type="password"
            placeholder="123456789:ABCdefGhIJKlmnOPQRstUVWxyz..."
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !botInfo && handleVerify()}
          />
        </div>

        {/* Verified badge */}
        {botInfo && (
          <div className="flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
            <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">@{botInfo.username}</p>
              <p className="text-[11px] text-muted-foreground">{botInfo.firstName}</p>
            </div>
            <Badge variant="highlight" className="text-[11px]">Verified</Badge>
          </div>
        )}

        {/* Project & Agent & Model — shown after token is verified */}
        {botInfo && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Project</Label>
              <ChannelProjectPicker value={projectId} onChange={setProjectId} className="bg-card" />
              <p className="text-[11px] text-muted-foreground px-0.5">
                {projectId
                  ? 'Bot runs inside this project — agents pick is scoped to it.'
                  : 'Workspace channel — uses the global agent set.'}
              </p>
            </div>

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

            <div className="space-y-1.5">
              <Label className="text-xs">Model</Label>
              {modelsLoading ? (
                <div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading...
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
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          {!botInfo ? (
            <Button
              onClick={handleVerify}
              disabled={!botToken.trim() || isWorking}
              className="gap-2"
            >
              {verifyToken.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Verify Token
            </Button>
          ) : (
            <Button
              onClick={handleConnect}
              disabled={isWorking}
              className="gap-2"
            >
              {connect.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Connect Bot
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
