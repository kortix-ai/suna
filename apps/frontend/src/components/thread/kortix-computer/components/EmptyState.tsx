'use client';

import { memo, useState, useEffect } from 'react';
import Image from 'next/image';

interface EmptyStateProps {
  t: (key: string) => string;
}

export const EmptyState = memo(function EmptyState({ t }: EmptyStateProps) {
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full">
      {/* Boot screen container */}
      <div className="flex flex-col items-center space-y-8">
        {/* Logo with subtle glow effect */}
        <div className="relative">
          {/* Ambient glow behind logo */}
          <div className="absolute inset-0 blur-3xl opacity-20 dark:opacity-10 bg-gradient-to-b from-zinc-400 to-transparent scale-150" />
          
          {/* Logo - dark mode (white logo) */}
          <Image
            src="/kortix-computer-white.svg"
            alt="Kortix Computer"
            width={280}
            height={31}
            className="hidden dark:block relative z-10 animate-fade-in"
            priority
          />
          
          {/* Logo - light mode (black logo) */}
          <Image
            src="/kortix-computer-black.svg"
            alt="Kortix Computer"
            width={280}
            height={31}
            className="block dark:hidden relative z-10 animate-fade-in"
            priority
          />
        </div>

        {/* Loading indicator section */}
        <div className="flex flex-col items-center space-y-4">
          {/* Animated progress bar */}
          <div className="w-48 h-0.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-zinc-400 dark:bg-zinc-500 rounded-full animate-boot-progress" />
          </div>
          
          {/* Status text with animated dots */}
          <p className="text-sm text-zinc-500 dark:text-zinc-500 font-light tracking-wide">
            <span>{t('workerActionsDescription')}</span>
            <span className="inline-block w-4 text-left">{dots}</span>
          </p>
        </div>
      </div>

      {/* Add keyframe animations via style tag */}
      <style jsx>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: scale(0.96);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        
        @keyframes boot-progress {
          0% {
            width: 0%;
            margin-left: 0%;
          }
          50% {
            width: 40%;
            margin-left: 30%;
          }
          100% {
            width: 0%;
            margin-left: 100%;
          }
        }
        
        :global(.animate-fade-in) {
          animation: fade-in 0.8s ease-out forwards;
        }
        
        :global(.animate-boot-progress) {
          animation: boot-progress 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
});

EmptyState.displayName = 'EmptyState';
