'use client';

import { memo } from 'react';
import Image from 'next/image';

interface EmptyStateProps {
  t: (key: string) => string;
}

export const EmptyState = memo(function EmptyState({ t }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full">
      {/* Empty state container */}
      <div className="flex flex-col items-center space-y-6">
        {/* Logo with subtle glow effect */}
        <div className="relative">
          {/* Ambient glow behind logo */}
          <div className="absolute inset-0 blur-3xl opacity-15 dark:opacity-5 bg-gradient-to-b from-zinc-400 to-transparent scale-150" />
          
          {/* Logo - dark mode (white logo) */}
          <Image
            src="/kortix-computer-white.svg"
            alt="Kortix Computer"
            width={240}
            height={27}
            className="hidden dark:block relative z-10 "
            priority
          />
          
          {/* Logo - light mode (black logo) */}
          <Image
            src="/kortix-computer-black.svg"
            alt="Kortix Computer"
            width={240}
            height={27}
            className="block dark:hidden relative z-10"
            priority
          />
        </div>

        {/* Empty state text */}
        <div className="flex flex-col items-center space-y-2 max-w-xs text-center">
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-light">
            {t('emptyActionsDescription')}
          </p>
        </div>
      </div>
    </div>
  );
});

EmptyState.displayName = 'EmptyState';
