'use client';

import { Copy } from '../icons/copy';
import { useTranslations } from '../i18n';
import { cn } from '../lib/utils';
import { CheckIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Hint from '../components/ui/hint';
import { errorToast, successToast } from '../components/ui/toast';

export function CopyButton({
  code,
  className,
  size,
  hintSide = 'bottom',
  label,
}: {
  code: string;
  /** The button's accessible name. Defaults to "Copy code". */
  label?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  hintSide?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const copiedLabel = tI18nComplete.raw('text8d525e5f158b');
  const copyError = tI18nComplete.raw('text4cb23f3c3b90');
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const copying = useRef(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const sizeClasses = {
    sm: 'size-6 rounded-sm',
    md: 'size-7',
    lg: 'size-9',
  };
  const handleCopy = useCallback(async () => {
    if (copying.current) return;
    copying.current = true;
    clearTimeout(resetTimer.current);
    setCopied(false);
    setAnnouncement('');
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setAnnouncement(copiedLabel);
      successToast(copiedLabel);
      resetTimer.current = setTimeout(() => {
        setCopied(false);
        setAnnouncement('');
      }, 2000);
    } catch {
      setAnnouncement(copyError);
      errorToast(copyError);
    } finally {
      copying.current = false;
    }
  }, [code, copiedLabel, copyError]);

  return (
    <>
      <Hint
        label={copied ? copiedLabel : tI18nComplete.raw('texte21f935f11d7')}
        side={hintSide}
        align="center"
      >
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? copiedLabel : (label ?? tI18nComplete.raw('text49a0053f3b0d'))}
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
      </Hint>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
