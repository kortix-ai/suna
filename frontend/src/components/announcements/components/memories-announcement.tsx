'use client';

import { Button } from '@/components/ui/button';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Brain, Sparkles, Shield, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AnnouncementComponentProps } from '../registry';

export function MemoriesAnnouncement({ onClose }: AnnouncementComponentProps) {
  const t = useTranslations('announcements.memories');

  return (
    <div className="relative">
      <div className="relative w-full h-40 overflow-hidden bg-gradient-to-br from-muted/50 via-muted/30 to-transparent">
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="relative">
            <div className="absolute -inset-8 bg-primary/5 rounded-full blur-2xl" />
            <div className="shadow-2xl shadow-black relative mt-10 h-32 w-32 rounded-3xl bg-primary/10 border border-border flex items-center justify-center">
              <Brain className="h-16 w-16 text-primary" />
            </div>
          </div>
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
        <button
          onClick={onClose}
          className="absolute top-3 right-3 h-8 w-8 rounded-full bg-background/80 backdrop-blur-sm flex items-center justify-center hover:bg-background transition-colors border border-border/50 z-10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="p-6 space-y-5">
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {t('description')}
          </p>
        </div>
        <div className="grid gap-2">
          <SpotlightCard className="bg-card border border-border">
            <div className="flex items-center gap-3 p-3">
              <div className="flex-shrink-0 h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm text-foreground">{t('features.personalized.title')}</p>
                <p className="text-xs text-muted-foreground">{t('features.personalized.description')}</p>
              </div>
            </div>
          </SpotlightCard>
          <SpotlightCard className="bg-card border border-border">
            <div className="flex items-center gap-3 p-3">
              <div className="flex-shrink-0 h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Brain className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm text-foreground">{t('features.retention.title')}</p>
                <p className="text-xs text-muted-foreground">{t('features.retention.description')}</p>
              </div>
            </div>
          </SpotlightCard>
          <SpotlightCard className="bg-card border border-border">
            <div className="flex items-center gap-3 p-3">
              <div className="flex-shrink-0 h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Shield className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm text-foreground">{t('features.control.title')}</p>
                <p className="text-xs text-muted-foreground">{t('features.control.description')}</p>
              </div>
            </div>
          </SpotlightCard>
        </div>
        <Button
          className="w-full"
          onClick={onClose}
        >
          {t('dismissButton')}
        </Button>
      </div>
    </div>
  );
}
