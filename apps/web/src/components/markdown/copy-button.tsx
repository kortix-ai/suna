'use client';

import { Copy } from '@/features/icon/icons/copy';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useState } from 'react';

export function CopyButton({
  code,
  className,
  size,
}: {
  code: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [copied, setCopied] = useState(false);
  const sizeClasses = {
    sm: 'size-6 rounded-sm',
    md: 'size-7',
    lg: 'size-9',
  };
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [code]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy code'}
      className={cn(
        'inline-flex items-center justify-center rounded-md',
        'text-foreground hover:text-foreground hover:bg-muted-foreground/10',
        'cursor-pointer transition-colors active:scale-[0.97]',
        'hit-area-3 outline-none focus-visible:outline-none',
        className,
        sizeClasses[size ?? 'md'],
      )}
    >
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <m.span
            key={copied ? 'check' : 'copy'}
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            {copied ? (
              <CheckIcon className="text-foreground size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </m.span>
        </AnimatePresence>
      </span>
    </button>
  );
}
