'use client';

import { Brain, Sparkles } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTranslations } from 'next-intl';

export function MemorySettings() {
  const t = useTranslations('settings.memory');

  return (
    <div className="p-4 sm:p-6 pb-12 sm:pb-6 space-y-5 sm:space-y-6 min-w-0 max-w-full overflow-x-hidden">
      <div>
        <div className="flex items-start justify-between mb-6">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Brain className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">{t('title') || 'Memory'}</h3>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {t('description') || 'Personalized context from your conversations'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <Alert className="border-primary/20 bg-primary/5">
          <Sparkles className="h-4 w-4 text-primary" />
          <AlertDescription className="text-sm">
            <strong className="text-foreground">Coming Soon</strong>
            <p className="text-muted-foreground mt-1">
              Memory is currently under development. This feature will allow Kortix to remember important information from your conversations to provide more personalized and context-aware responses.
            </p>
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
