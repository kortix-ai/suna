'use client';

import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useState } from 'react';

/**
 * Copies the literal gateway wire model id (`provider/model`). Model rows in
 * this section live inside a clickable `<label>` (the visibility toggle) —
 * `stopPropagation`/`preventDefault` keep a copy click from also flipping
 * that switch. Icon-swap follows the buttery blur+scale+opacity pattern
 * (`kortix-design-system` skill) — see `CopyButton` in
 * `components/markdown/copy-button.tsx` for the same shape.
 */
export function ModelIdCopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard
        .writeText(value)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => undefined);
    },
    [value],
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Copied' : 'Copy model id'}
      className={cn(
        'text-muted-foreground/50 hover:text-foreground hover:bg-muted-foreground/10 inline-flex size-5 shrink-0 items-center justify-center rounded outline-none',
        'cursor-pointer transition-colors active:scale-[0.96]',
        className,
      )}
    >
      <span className="relative inline-flex size-3 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? 'check' : 'copy'}
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            {copied ? <Check className="text-kortix-green size-3" /> : <Copy className="size-3" />}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  );
}
