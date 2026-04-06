"use client";

import React, { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  QrCode,
  RefreshCw,
} from 'lucide-react';
import { WhatsAppIcon } from '@/components/ui/icons/whatsapp';
import { toast } from 'sonner';
import { useWhatsAppGenerateQr, useWhatsAppWaitForConnection, useWhatsAppConnect } from '@/hooks/channels/use-whatsapp-wizard';
import { AgentSelector, flattenModels } from '@/components/session/session-chat-input';
import { ModelSelector } from '@/components/session/model-selector';
import { useOpenCodeAgents, useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';

interface WhatsAppSetupWizardProps {
  onCreated: () => void;
  onBack: () => void;
}

export function WhatsAppSetupWizard({ onCreated, onBack }: WhatsAppSetupWizardProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [waitingForScan, setWaitingForScan] = useState(false);
  const [agentName, setAgentName] = useState<string | null>('kortix');
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(null);

  const generateQr = useWhatsAppGenerateQr();
  const waitForConnection = useWhatsAppWaitForConnection();
  const connect = useWhatsAppConnect();

  const { data: agents = [], isLoading: agentsLoading } = useOpenCodeAgents();
  const { data: providers, isLoading: modelsLoading } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);

  const handleGenerateQr = async (force = false) => {
    setQrDataUrl(null);
    setConnected(false);
    try {
      const result = await generateQr.mutateAsync({ force });
      if (result.alreadyConnected) {
        setConnected(true);
        toast.success('WhatsApp is already connected!');
        return;
      }
      if (result.qrDataUrl) {
        setQrDataUrl(result.qrDataUrl);
        // Auto-wait for scan
        setWaitingForScan(true);
        try {
          const waitResult = await waitForConnection.mutateAsync({ timeoutMs: 120_000 });
          if (waitResult.connected) {
            setConnected(true);
            setQrDataUrl(null);
            toast.success('WhatsApp connected!');
          } else {
            setQrDataUrl(null);
            toast.error('QR expired or scan failed. Try again.');
          }
        } finally {
          setWaitingForScan(false);
        }
      } else {
        // Reconnecting with saved credentials
        toast.info(result.message || 'Reconnecting...');
        setWaitingForScan(true);
        try {
          const waitResult = await waitForConnection.mutateAsync({ timeoutMs: 30_000 });
          if (waitResult.connected) {
            setConnected(true);
            toast.success('WhatsApp reconnected!');
          }
        } finally {
          setWaitingForScan(false);
        }
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate QR code');
    }
  };

  const handleConnect = async () => {
    const modelStr = selectedModel
      ? `${selectedModel.providerID}/${selectedModel.modelID}`
      : undefined;
    try {
      await connect.mutateAsync({
        defaultAgent: agentName || undefined,
        defaultModel: modelStr,
      });
      toast.success('WhatsApp channel created!');
      onCreated();
    } catch (err: any) {
      toast.error(err.message || 'Setup failed');
    }
  };

  const isWorking = generateQr.isPending || waitForConnection.isPending || connect.isPending;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button onClick={onBack} variant="ghost" size="icon">
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </Button>
        <div className="flex items-center justify-center w-9 h-9 rounded-[10px] bg-[#25D366]/10 border border-[#25D366]/20">
          <WhatsAppIcon className="h-4.5 w-4.5 text-[#25D366]" />
        </div>
        <div>
          <h3 className="text-base font-semibold">WhatsApp Setup</h3>
          <p className="text-xs text-muted-foreground">Link your WhatsApp account via QR code</p>
        </div>
      </div>

      <div className="space-y-4">
        {/* QR Code Display Area */}
        {!connected && (
          <div className="flex flex-col items-center gap-3 min-h-[280px] justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-6">
            {qrDataUrl ? (
              <>
                <img
                  src={qrDataUrl}
                  alt="WhatsApp QR Code"
                  className="w-64 h-64 rounded-lg"
                  style={{ imageRendering: 'pixelated' }}
                />
                {waitingForScan && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Waiting for scan...
                  </div>
                )}
                <p className="text-xs text-muted-foreground text-center">
                  Open WhatsApp on your phone &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
                </p>
              </>
            ) : generateQr.isPending ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Generating QR code...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <QrCode className="h-10 w-10 text-muted-foreground/60" />
                <div>
                  <p className="text-sm font-medium">WhatsApp QR Login</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Generate a QR code and scan it with your phone to link your WhatsApp account.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Connected state */}
        {connected && !connect.isSuccess && (
          <>
            <div className="flex items-center gap-2.5 rounded-lg border border-[#25D366]/20 bg-[#25D366]/5 px-3 py-2">
              <CheckCircle2 className="h-4 w-4 text-[#25D366] shrink-0" />
              <p className="text-sm font-medium text-foreground">WhatsApp Connected</p>
            </div>

            {/* Agent & Model selection */}
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
          </>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          {!connected ? (
            <>
              {qrDataUrl && !waitingForScan && (
                <Button
                  onClick={() => handleGenerateQr(true)}
                  disabled={isWorking}
                  variant="outline"
                  className="gap-2"
                >
                  <RefreshCw className="h-4 w-4" />
                  New QR
                </Button>
              )}
              {!qrDataUrl && !generateQr.isPending && (
                <Button
                  onClick={() => handleGenerateQr(false)}
                  disabled={isWorking}
                  className="gap-2 bg-[#25D366] hover:bg-[#25D366]/90 text-white"
                >
                  <QrCode className="h-4 w-4" />
                  Generate QR Code
                </Button>
              )}
            </>
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
              Create Channel
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
