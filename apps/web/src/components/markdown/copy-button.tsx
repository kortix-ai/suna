'use client';

import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useState } from 'react';

export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

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
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy code'}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md',
        'text-foreground hover:text-foreground hover:bg-muted-foreground/10',
        'cursor-pointer transition-colors active:scale-[0.97]',
        'outline-none focus-visible:outline-none',
      )}
    >
      <span className="relative inline-flex size-3.5 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? 'check' : 'copy'}
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            {copied ? (
              <Check className="text-kortix-green size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  );
}
