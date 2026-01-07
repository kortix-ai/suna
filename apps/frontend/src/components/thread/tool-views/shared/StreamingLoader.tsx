'use client';

import React, { useState, useEffect, memo } from 'react';
import Image from 'next/image';
import { KortixLoader } from '@/components/ui/kortix-loader';

const streamingPhrases = [
  'Generating content',
  'Writing code',
  'Crafting your file',
  'Building structure',
  'Almost there',
  'Putting it together',
];

interface StreamingLoaderProps {
  /** Optional custom message to display instead of cycling phrases */
  message?: string;
  /** Whether to show the Kortix Computer branding */
  showBranding?: boolean;
  /** Custom class name */
  className?: string;
}

export const StreamingLoader = memo(function StreamingLoader({
  message,
  showBranding = true,
  className,
}: StreamingLoaderProps) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [dots, setDots] = useState('');

  // Cycle through phrases
  useEffect(() => {
    if (message) return; // Don't cycle if custom message provided

    const interval = setInterval(() => {
      setIsTransitioning(true);
      setTimeout(() => {
        setPhraseIndex((prev) => (prev + 1) % streamingPhrases.length);
        setIsTransitioning(false);
      }, 200);
    }, 2400);

    return () => clearInterval(interval);
  }, [message]);

  // Animate dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
    }, 400);

    return () => clearInterval(interval);
  }, []);

  const displayText = message || streamingPhrases[phraseIndex];

  return (
    <div className={`flex items-center justify-center h-full p-8 bg-zinc-50/50 dark:bg-zinc-900/50 ${className || ''}`}>
      <div className="flex flex-col items-center space-y-6 max-w-sm text-center">
        {/* Animated logo section */}
        <div className="relative">
          {/* Outer pulsing ring */}
          <div className="absolute inset-0 -m-4 rounded-full bg-gradient-to-r from-zinc-200 via-zinc-300 to-zinc-200 dark:from-zinc-700 dark:via-zinc-600 dark:to-zinc-700 opacity-30 animate-pulse" />
          
          {/* Spinning gradient border */}
          <div className="absolute inset-0 -m-2 rounded-full animate-spin-slow">
            <div className="absolute inset-0 rounded-full bg-gradient-conic from-zinc-300 via-transparent to-zinc-300 dark:from-zinc-600 dark:via-transparent dark:to-zinc-600 opacity-50" />
          </div>
          
          {/* Main container */}
          <div className="relative w-20 h-20 rounded-full bg-white dark:bg-zinc-800 shadow-lg border border-zinc-200 dark:border-zinc-700 flex items-center justify-center overflow-hidden">
            {/* Subtle gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-zinc-100/50 dark:to-zinc-900/50" />
            
            {/* Kortix loader */}
            <KortixLoader customSize={36} speed={1} />
          </div>
        </div>

        {/* Branding */}
        {showBranding && (
          <div className="relative opacity-60">
            <Image
              src="/kortix-computer-white.svg"
              alt="Kortix Computer"
              width={140}
              height={16}
              className="hidden dark:block"
              priority
            />
            <Image
              src="/kortix-computer-black.svg"
              alt="Kortix Computer"
              width={140}
              height={16}
              className="block dark:hidden"
              priority
            />
          </div>
        )}

        {/* Status text with animation */}
        <div className="space-y-2">
          <div className="flex items-center justify-center gap-2">
            {/* Cycling text */}
            <span 
              className={`text-sm font-medium text-zinc-700 dark:text-zinc-300 streaming-text ${
                isTransitioning ? 'streaming-text-exit' : 'streaming-text-enter'
              }`}
            >
              {displayText}
            </span>
            
            {/* Animated dots */}
            <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400 w-4 text-left">
              {dots}
            </span>
          </div>

          {/* Subtitle */}
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Content will appear as it&apos;s generated
          </p>
        </div>

        {/* Bouncing activity indicator */}
        <div className="flex items-center gap-1.5">
          <span className="streaming-dot streaming-dot-1" />
          <span className="streaming-dot streaming-dot-2" />
          <span className="streaming-dot streaming-dot-3" />
          <span className="streaming-dot streaming-dot-4" />
        </div>
      </div>

      <style jsx>{`
        .streaming-text {
          transition: opacity 0.2s ease, transform 0.2s ease;
        }

        .streaming-text-enter {
          opacity: 1;
          transform: translateY(0);
        }

        .streaming-text-exit {
          opacity: 0;
          transform: translateY(-6px);
        }

        .streaming-dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: currentColor;
          opacity: 0.4;
          animation: streamingBounce 1.2s ease-in-out infinite;
        }

        .streaming-dot-1 { animation-delay: 0ms; }
        .streaming-dot-2 { animation-delay: 150ms; }
        .streaming-dot-3 { animation-delay: 300ms; }
        .streaming-dot-4 { animation-delay: 450ms; }

        @keyframes streamingBounce {
          0%, 80%, 100% {
            transform: scale(1);
            opacity: 0.3;
          }
          40% {
            transform: scale(1.4);
            opacity: 1;
          }
        }

        @keyframes spin-slow {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .animate-spin-slow {
          animation: spin-slow 8s linear infinite;
        }

        .bg-gradient-conic {
          background: conic-gradient(from 0deg, var(--tw-gradient-from), var(--tw-gradient-via), var(--tw-gradient-to));
        }
      `}</style>
    </div>
  );
});

StreamingLoader.displayName = 'StreamingLoader';

