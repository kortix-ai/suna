'use client';

import { memo } from 'react';
import { Computer } from 'lucide-react';

interface EmptyStateProps {
  t: (key: string) => string;
}

export const EmptyState = memo(function EmptyState({ t }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8">
      <div className="flex flex-col items-center space-y-4 max-w-sm text-center">
        <div className="relative">
          <div className="w-16 h-16 bg-zinc-100 dark:bg-zinc-800 rounded-full flex items-center justify-center">
            <Computer className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-zinc-200 dark:bg-zinc-700 rounded-full flex items-center justify-center">
            <div className="w-2 h-2 bg-zinc-400 dark:text-zinc-500 rounded-full"></div>
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
            {t('noActionsYet')}
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t('workerActionsDescription')}
          </p>
        </div>
      </div>
    </div>
  );
});

EmptyState.displayName = 'EmptyState';

