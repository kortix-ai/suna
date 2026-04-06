"use client";

import React, { useState, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { TelegramIcon } from '@/components/ui/icons/telegram';
import { SlackIcon } from '@/components/ui/icons/slack';
import { WhatsAppIcon } from '@/components/ui/icons/whatsapp';
import { TelegramSetupWizard } from './telegram-setup-wizard';
import { SlackSetupWizard } from './slack-setup-wizard';
import { WhatsAppSetupWizard } from './whatsapp-setup-wizard';

type Platform = 'telegram' | 'slack' | 'whatsapp' | null;

interface ChannelConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  /** Pre-select a platform when opening (bypasses the picker) */
  initialPlatform?: 'telegram' | 'slack' | 'whatsapp';
}

export function ChannelConfigDialog({ open, onOpenChange, onCreated, initialPlatform }: ChannelConfigDialogProps) {
  const [platform, setPlatform] = useState<Platform>(initialPlatform ?? null);

  // Sync platform when dialog opens with a new initialPlatform
  useEffect(() => {
    if (open) {
      setPlatform(initialPlatform ?? null);
    }
  }, [open, initialPlatform]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      // Reset platform selection when closing
      setPlatform(initialPlatform ?? null);
    }
    onOpenChange(next);
  }, [onOpenChange, initialPlatform]);

  const handleCreated = useCallback(() => {
    onCreated();
    handleOpenChange(false);
  }, [onCreated, handleOpenChange]);

  const handleBack = useCallback(() => {
    setPlatform(null);
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto" aria-describedby="channel-config-description">
        {!platform ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect a Channel</DialogTitle>
              <DialogDescription id="channel-config-description">
                Choose a platform to connect your agent to.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-4 pt-2">
              <button
                onClick={() => setPlatform('telegram')}
                className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-xl bg-muted border border-border/50 flex items-center justify-center group-hover:border-primary/30 transition-colors">
                  <TelegramIcon className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm font-medium">Telegram</p>
              </button>
              <button
                onClick={() => setPlatform('slack')}
                className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-xl bg-muted border border-border/50 flex items-center justify-center group-hover:border-primary/30 transition-colors">
                  <SlackIcon className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm font-medium">Slack</p>
              </button>
              <button
                onClick={() => setPlatform('whatsapp')}
                className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-border/50 bg-card hover:bg-muted/50 transition-colors cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-xl bg-[#25D366]/10 border border-[#25D366]/20 flex items-center justify-center group-hover:border-[#25D366]/40 transition-colors">
                  <WhatsAppIcon className="h-6 w-6 text-[#25D366]" />
                </div>
                <p className="text-sm font-medium">WhatsApp</p>
              </button>
            </div>
          </>
        ) : platform === 'telegram' ? (
          <>
            <VisuallyHidden><DialogTitle>Telegram Setup</DialogTitle></VisuallyHidden>
            <TelegramSetupWizard onCreated={handleCreated} onBack={handleBack} />
          </>
        ) : platform === 'slack' ? (
          <>
            <VisuallyHidden><DialogTitle>Slack Setup</DialogTitle></VisuallyHidden>
            <SlackSetupWizard onCreated={handleCreated} onBack={handleBack} />
          </>
        ) : (
          <>
            <VisuallyHidden><DialogTitle>WhatsApp Setup</DialogTitle></VisuallyHidden>
            <WhatsAppSetupWizard onCreated={handleCreated} onBack={handleBack} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
