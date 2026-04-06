"use client";

import React, { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Copy,
} from 'lucide-react';
import { WhatsAppIcon } from '@/components/ui/icons/whatsapp';
import { toast } from 'sonner';
import { useWhatsAppVerify, useWhatsAppConnect } from '@/hooks/channels/use-whatsapp-wizard';
import { AgentSelector, flattenModels } from '@/components/session/session-chat-input';
import { ModelSelector } from '@/components/session/model-selector';
import { useOpenCodeAgents, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';

interface WhatsAppSetupWizardProps {
  onCreated: () => void;
  onBack: () => void;
}

export function WhatsAppSetupWizard({ onCreated, onBack }: WhatsAppSetupWizardProps) {
  const [accessToken, setAccessToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [phoneInfo, setPhoneInfo] = useState<{ display_phone_number: string; verified_name: string } | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<{ webhookUrl: string; verifyToken: string } | null>(null);
  const [agentName, setAgentName] = useState<string | null>('kortix');
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(null);

  const verify = useWhatsAppVerify();
  const connect = useWhatsAppConnect();

  const { data: agents = [], isLoading: agentsLoading } = useOpenCodeAgents();
  const { data: providers, isLoading: modelsLoading } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  const handleVerify = async () => {
    const trimmedToken = accessToken.trim();
    const trimmedPhone = phoneNumberId.trim();
    if (!trimmedToken || !trimmedPhone) return;
    const result = await verify.mutateAsync({ accessToken: trimmedToken, phoneNumberId: trimmedPhone });
    if (result.ok && result.phone) {
      setPhoneInfo({ display_phone_number: result.phone.display_phone_number, verified_name: result.phone.verified_name });
      toast.success(`Verified: ${result.phone.verified_name || result.phone.display_phone_number}`);
    } else {
      toast.error(result.error || 'Invalid credentials');
    }
  };

  const handleConnect = async () => {
    const trimmedToken = accessToken.trim();
    const trimmedPhone = phoneNumberId.trim();
    if (!trimmedToken || !trimmedPhone) return;

    if (!phoneInfo) {
      const result = await verify.mutateAsync({ accessToken: trimmedToken, phoneNumberId: trimmedPhone });
      if (!result.ok || !result.phone) {
        toast.error(result.error || 'Invalid credentials');
        return;
      }
      setPhoneInfo({ display_phone_number: result.phone.display_phone_number, verified_name: result.phone.verified_name });
    }

    const modelStr = selectedModel
      ? `${selectedModel.providerID}/${selectedModel.modelID}`
      : undefined;

    try {
      const result = await connect.mutateAsync({
        accessToken: trimmedToken,
        phoneNumberId: trimmedPhone,
        defaultAgent: agentName || undefined,
        defaultModel: modelStr,
      });

      if (result.channel?.webhookUrl) {
        setWebhookInfo({
          webhookUrl: result.channel.webhookUrl,
          verifyToken: result.channel.webhookVerifyToken,
        });
        toast.success('WhatsApp channel created! Configure your webhook below.', { duration: 8000 });
      } else {
        toast.success(result.message || 'WhatsApp channel connected!');
        onCreated();
      }
    } catch (err: any) {
      toast.error(err.message || 'Setup failed');
    }
  };

  const handleDone = () => {
    onCreated();
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied!`);
  };

  const isWorking = verify.isPending || connect.isPending;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button onClick={onBack} variant="ghost" size="icon">
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </Button>
        <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-muted border border-border/50">
          <WhatsAppIcon className="h-4.5 w-4.5" />
        </div>
        <div>
          <h3 className="text-base font-semibold">WhatsApp Setup</h3>
          <p className="text-xs text-muted-foreground">Connect a WhatsApp Business number to your agent</p>
        </div>
      </div>

      <div className="space-y-4">
        {!webhookInfo ? (
          <>
            {/* Instructions */}
            <div className="rounded-xl border border-border/50 bg-muted/30 p-4 text-sm text-muted-foreground space-y-2">
              <p>
                <span className="font-medium text-foreground">1.</span>{' '}
                Go to{' '}
                <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                  Meta for Developers <ExternalLink className="h-3 w-3" />
                </a>{' '}
                and create or select an app with WhatsApp product
              </p>
              <p>
                <span className="font-medium text-foreground">2.</span>{' '}
                In WhatsApp {'>'} API Setup, copy your{' '}
                <span className="font-medium text-foreground">Access Token</span> and{' '}
                <span className="font-medium text-foreground">Phone Number ID</span>
              </p>
              <p>
                <span className="font-medium text-foreground">3.</span>{' '}
                Paste them below
              </p>
            </div>

            {/* Token inputs */}
            <div className="space-y-2">
              <Label htmlFor="wa-token">Access Token</Label>
              <Input
                id="wa-token"
                type="password"
                placeholder="EAAxxxxxxx..."
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wa-phone-id">Phone Number ID</Label>
              <Input
                id="wa-phone-id"
                type="text"
                placeholder="123456789012345"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !phoneInfo && handleVerify()}
              />
            </div>

            {/* Verified badge */}
            {phoneInfo && (
              <div className="flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
                <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{phoneInfo.verified_name}</p>
                  <p className="text-[11px] text-muted-foreground">{phoneInfo.display_phone_number}</p>
                </div>
                <Badge variant="highlight" className="text-[11px]">Verified</Badge>
              </div>
            )}

            {/* Agent & Model — shown after verified */}
            {phoneInfo && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Agent</Label>
                  {agentsLoading ? (
                    <div className="flex items-center gap-2 h-9 px-3 text-sm text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                    </div>
                  ) : (
                    <div className="rounded-xl border bg-card px-2 py-1">
                      <AgentSelector
                        agents={agents}
                        selectedAgent={agentName}
                        onSelect={(next) => setAgentName(next)}
                      />
                    </div>
                  )}
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
              {!phoneInfo ? (
                <Button
                  onClick={handleVerify}
                  disabled={!accessToken.trim() || !phoneNumberId.trim() || isWorking}
                  className="gap-2"
                >
                  {verify.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  Verify Credentials
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
                  Connect WhatsApp
                </Button>
              )}
            </div>
          </>
        ) : (
          /* Webhook configuration step */
          <>
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <p className="text-sm font-medium">Channel created! Now configure your webhook:</p>
              </div>

              <div className="rounded-xl border border-border/50 bg-muted/30 p-4 text-sm text-muted-foreground space-y-2">
                <p>
                  <span className="font-medium text-foreground">1.</span>{' '}
                  In your Meta App Dashboard, go to WhatsApp {'>'} Configuration {'>'} Webhook
                </p>
                <p>
                  <span className="font-medium text-foreground">2.</span>{' '}
                  Set the Callback URL and Verify Token below
                </p>
                <p>
                  <span className="font-medium text-foreground">3.</span>{' '}
                  Subscribe to the <code className="px-1.5 py-0.5 rounded bg-muted text-foreground text-xs">messages</code> webhook field
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Callback URL</Label>
                <div className="flex gap-2">
                  <Input value={webhookInfo.webhookUrl} readOnly className="text-xs font-mono" />
                  <Button variant="outline" size="icon" onClick={() => copyToClipboard(webhookInfo.webhookUrl, 'Webhook URL')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Verify Token</Label>
                <div className="flex gap-2">
                  <Input value={webhookInfo.verifyToken} readOnly className="text-xs font-mono" />
                  <Button variant="outline" size="icon" onClick={() => copyToClipboard(webhookInfo.verifyToken, 'Verify token')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end">
              <Button onClick={handleDone} className="gap-2">
                <CheckCircle2 className="h-4 w-4" />
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
