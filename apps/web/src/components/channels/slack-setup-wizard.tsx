"use client";

import React, { useId, useMemo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Copy,
  ClipboardCheck,
} from 'lucide-react';
import { SlackIcon } from '@/components/ui/icons/slack';
import { toast } from '@/lib/toast';
import { useSlackConnect } from '@/hooks/channels/use-slack-wizard';
import { getActiveOpenCodeUrl } from '@/stores/server-store';
import { authenticatedFetch } from '@/lib/auth-token';
import { AgentSelector, flattenModels } from '@/components/session/session-chat-input';
import { ModelSelector } from '@/components/session/model-selector';
import { useVisibleAgents, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { useKortixProjects } from '@/hooks/kortix/use-kortix-projects';
import { ChannelProjectPicker } from './channel-project-picker';

interface SlackSetupWizardProps {
  onCreated: () => void;
  onBack: () => void;
  /** Pre-select a project (e.g. when launched from a project-filtered view) */
  initialProjectId?: string | null;
}

const STEP_ANIMATION = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
  transition: { duration: 0.2 },
};

const BOT_NAMES = [
  'Atlas', 'Nova', 'Sage', 'Echo', 'Bolt', 'Iris', 'Dash', 'Cleo',
  'Finn', 'Luna', 'Juno', 'Axel', 'Niko', 'Zara', 'Milo', 'Ruby',
  'Hugo', 'Aria', 'Leo', 'Ivy', 'Rex', 'Mae', 'Kai', 'Pia',
];

function defaultBotName(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `Kortix ${BOT_NAMES[hash % BOT_NAMES.length]}`;
}

export function SlackSetupWizard({ onCreated, onBack, initialProjectId = null }: SlackSetupWizardProps) {
  const botNameSeed = useId();
  const [step, setStep] = useState(1);
  const [botName, setBotName] = useState(() => defaultBotName(botNameSeed));
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [agentName, setAgentName] = useState<string | null>('kortix');
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(null);
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [manifestChannelId, setManifestChannelId] = useState('');
  const [manifestCopied, setManifestCopied] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const slackConnect = useSlackConnect();
  const { data: projects = [] } = useKortixProjects();
  const projectDirectory = useMemo(
    () => projects.find((p) => p.id === projectId)?.path,
    [projects, projectId],
  );
  const agents = useVisibleAgents(projectDirectory ? { directory: projectDirectory } : undefined);
  const { data: providers, isLoading: modelsLoading } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  // Reset agent if it isn't valid in the new project's scope.
  useEffect(() => {
    if (!agentName) return;
    if (agents.length === 0) return;
    const stillValid = agents.some((a) => a.name === agentName);
    if (!stillValid) setAgentName('kortix');
  }, [agents, agentName]);

  const handleGenerateManifest = async () => {
    setIsGenerating(true);
    try {
      const baseUrl = getActiveOpenCodeUrl();
      if (!baseUrl) {
        toast.error('No active sandbox', {
          description: 'Start or select an instance before generating the Slack manifest.',
        });
        return;
      }
      const res = await authenticatedFetch(`${baseUrl}/kortix/channels/slack-manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicUrl: '', botName: botName.trim() || undefined, projectId }),
      });
      const text = await res.text();
      let data: any;
        try { data = JSON.parse(text); } catch {
          toast.error('Server returned an invalid manifest response', {
            description: 'The sandbox did not return JSON. Try again after the instance reconnects.',
          });
          return;
        }
        if (data.ok && data.manifest) {
          setManifest(data.manifest);
          setWebhookUrl(data.webhookUrl || '');
          setManifestChannelId(data.channelId || '');
          toast.success('Slack manifest generated', {
            description: data.webhookUrl || 'Copy the manifest into Slack and continue to the next step.',
          });
          setStep(2);
        } else {
          toast.error('Failed to generate Slack manifest', {
            description: data.error || 'The sandbox could not create a public webhook URL.',
          });
        }
      } catch {
      toast.error('Failed to generate Slack manifest', {
        description: 'The request did not complete. Check the instance connection and try again.',
      });
      } finally {
        setIsGenerating(false);
      }
  };

  const handleCopyManifest = async () => {
    if (!manifest) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
      setManifestCopied(true);
      toast.success('Manifest copied to clipboard');
      setTimeout(() => setManifestCopied(false), 3000);
    } catch {
      toast.error('Failed to copy manifest');
    }
  };

  const handleConnect = async () => {
    const trimmedToken = botToken.trim();
    if (!trimmedToken) {
      toast.error('Enter a bot token');
      return;
    }

    const modelStr = selectedModel
      ? `${selectedModel.providerID}/${selectedModel.modelID}`
      : undefined;

    try {
      const result = await slackConnect.mutateAsync({
        botToken: trimmedToken,
        signingSecret: signingSecret.trim() || undefined,
        publicUrl: '',
        name: botName.trim() || undefined,
        channelId: manifestChannelId || undefined,
        defaultAgent: agentName || undefined,
        defaultModel: modelStr,
        projectId,
      });
      const webhookUrl = result.channel?.webhookUrl;
      if (webhookUrl) {
        toast.success('Slack bot connected', {
          description: webhookUrl,
          duration: 8000,
        });
      } else {
        toast.success('Slack bot connected', {
          description: result.message || 'Update your Slack app event subscription URL if needed.',
        });
      }
      onCreated();
    } catch (err: any) {
      toast.error('Slack setup failed', {
        description: err?.message || 'The sandbox rejected the Slack configuration request.',
      });
    }
  };

  const stepLabels = ['Configure', 'Create App', 'Connect'];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button onClick={onBack} variant="ghost" size="icon">
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </Button>
        <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50">
          <SlackIcon className="h-4.5 w-4.5 text-foreground" />
        </div>
        <div>
          <h3 className="text-base font-semibold">Slack Setup</h3>
          <p className="text-xs text-muted-foreground">Connect a Slack bot to your agent</p>
        </div>
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2">
        {stepLabels.map((label, i) => {
          const s = i + 1;
          return (
            <div key={s} className="flex items-center gap-2">
              <div className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium transition-colors ${
                s < step ? 'bg-primary text-primary-foreground' :
                s === step ? 'bg-primary text-primary-foreground' :
                'bg-muted text-muted-foreground'
              }`}>
                {s < step ? <CheckCircle2 className="h-3.5 w-3.5" /> : s}
              </div>
              <span className={`text-xs ${s === step ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                {label}
              </span>
              {s < stepLabels.length && <div className="w-6 h-px bg-border" />}
            </div>
          );
        })}
      </div>

      {/* Steps */}
      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="step1" {...STEP_ANIMATION} className="space-y-4">
            {/* Bot Name */}
            <div className="space-y-2">
              <Label htmlFor="slack-bot-name">Bot Name</Label>
              <Input
                id="slack-bot-name"
                placeholder="Kortix Agent"
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">Display name in Slack.</p>
            </div>

            {/* Project */}
            <div className="space-y-1.5">
              <Label className="text-xs">Project</Label>
              <ChannelProjectPicker value={projectId} onChange={setProjectId} className="bg-card" />
              <p className="text-[11px] text-muted-foreground px-0.5">
                {projectId
                  ? 'Bot runs inside this project — agent pick is scoped to it.'
                  : 'Workspace channel — uses the global agent set.'}
              </p>
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

            <div className="flex justify-end">
              <Button
                onClick={handleGenerateManifest}
                disabled={isGenerating}
                className="gap-2"
              >
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                Generate Manifest
              </Button>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="step2" {...STEP_ANIMATION} className="space-y-3">
            <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground text-sm">Create your Slack app</p>
              <ol className="list-decimal list-inside space-y-1 text-[12px]">
                <li>Go to{' '}
                  <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                    api.slack.com/apps <ExternalLink className="h-2.5 w-2.5" />
                  </a>{' '}
                  → <strong className="text-foreground">Create New App</strong> → <strong className="text-foreground">From an app manifest</strong>
                </li>
                <li>Select your workspace, paste the manifest below (JSON format)</li>
                <li>After creating, <strong className="text-foreground">Install to Workspace</strong> from OAuth & Permissions</li>
              </ol>
            </div>

            {manifest && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">App Manifest</Label>
                  <Button variant="ghost" size="sm" className="gap-1 h-6 text-[11px] px-2" onClick={handleCopyManifest}>
                    {manifestCopied ? <ClipboardCheck className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {manifestCopied ? 'Copied' : 'Copy JSON'}
                  </Button>
                </div>
                <pre className="rounded-lg border bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground max-h-24 overflow-y-auto leading-tight whitespace-pre-wrap break-all">
                  {JSON.stringify(manifest, null, 2)}
                </pre>
              </div>
            )}

            {webhookUrl && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 space-y-1">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-medium text-foreground">Event Subscriptions URL</p>
                  <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] gap-1" onClick={() => { navigator.clipboard.writeText(webhookUrl); toast.success('Copied'); }}>
                    <Copy className="h-2.5 w-2.5" /> Copy
                  </Button>
                </div>
                <code className="block text-[11px] text-muted-foreground break-all">{webhookUrl}</code>
                <p className="text-[10px] text-muted-foreground">This URL is already in the manifest. Slack will verify it automatically.</p>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" size="sm" onClick={() => setStep(1)} className="h-8 text-xs">
                <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                Back
              </Button>
              <Button onClick={() => setStep(3)} className="gap-1.5 h-8 text-xs">
                <ArrowRight className="h-3.5 w-3.5" />
                Enter Credentials
              </Button>
            </div>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div key="step3" {...STEP_ANIMATION} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="slack-token" className="text-xs">Bot User OAuth Token</Label>
              <Input
                id="slack-token"
                type="password"
                placeholder="xoxb-..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Find this in your{' '}
                <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Slack app</a>
                {' '}→ <strong className="text-foreground">OAuth & Permissions</strong> → <strong className="text-foreground">Bot User OAuth Token</strong>
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="slack-signing" className="text-xs">Signing Secret (optional)</Label>
              <Input
                id="slack-signing"
                type="password"
                placeholder="abc123..."
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              />
              <p className="text-[11px] text-muted-foreground">
                Find this in your{' '}
                <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Slack app</a>
                {' '}→ <strong className="text-foreground">Basic Information</strong> → <strong className="text-foreground">App Credentials</strong> → Signing Secret
              </p>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button variant="ghost" size="sm" onClick={() => setStep(2)} className="h-8 text-xs">
                <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                Back
              </Button>
              <Button
                onClick={handleConnect}
                disabled={!botToken.trim() || slackConnect.isPending}
                className="gap-1.5 h-8 text-xs"
              >
                {slackConnect.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Connect Bot
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
