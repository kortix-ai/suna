'use client';

import { Button } from '@/components/ui/marketing/button';
import { Copy } from '@kortix/ui/icons';
import { CheckIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useState } from 'react';

/**
 * Copies a link to one release (`anchor` on this page) or one week's page
 * (`href`). The URL is built at click time from
 * `window.location` rather than the canonical origin, so a reader on dev,
 * staging, or localhost copies a link to the page they are actually reading.
 *
 * The icon cross-fades (scale + opacity + blur) instead of hard-swapping —
 * the label stays fixed at "Copy link" so the row never reflows.
 */
export function CopyLinkButton({
  anchor,
  href,
  className,
}: {
  anchor?: string;
  href?: string;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const { origin, pathname } = window.location;
    try {
      await navigator.clipboard.writeText(
        href ? `${origin}${href}` : `${origin}${pathname}#${anchor}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  }, [anchor, href]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      aria-label={
        copied ? tI18nComplete.raw('textd12860c21e78') : tI18nComplete.raw('text005ff7fe0036')
      }
      className={className}
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
      {tI18nComplete.raw('textdbf362d4f210')}
    </Button>
  );
}
