'use client';

import { Copy } from '@/features/icon/icons/copy';
import { cn } from '@/lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useState } from 'react';

/**
 * Deep-links one release. The URL is built at click time from
 * `window.location` rather than the canonical origin, so a reader on dev,
 * staging, or localhost copies a link to the page they are actually reading.
 *
 * The icon cross-fades (scale + opacity + blur) instead of hard-swapping —
 * the label stays fixed at "Copy link" so the row never reflows.
 */
export function CopyLinkButton({ anchor, className }: { anchor: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const { origin, pathname } = window.location;
    try {
      await navigator.clipboard.writeText(`${origin}${pathname}#${anchor}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  }, [anchor]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? 'Link copied' : 'Copy link to this release'}
      className={cn(
        'text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm',
        'hit-area-2 cursor-pointer transition-[color,scale] duration-150 outline-none focus-visible:underline',
        'focus-visible:underline-offset-4 active:scale-[0.98]',
        className,
      )}
    >
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          <m.span
            key={copied ? 'check' : 'copy'}
            initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
            exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            {copied ? <CheckIcon className="size-4" /> : <Copy className="size-4" />}
          </m.span>
        </AnimatePresence>
      </span>
      Copy link
    </button>
  );
}
