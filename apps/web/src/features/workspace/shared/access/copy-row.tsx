'use client';

import { useTranslations } from '@/i18n/use-translations';
// CopyRow — a monospace value plus a copy button, in one row.
//
// Replaces the `SpDetails` rows in `sso-card.tsx`, the SCIM base-URL /
// token rows in `scim-card.tsx`, the webhook secret reveal in
// `audit-webhooks-card.tsx`, and the three private `copyValue` helpers
// that backed them.

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { errorToast, successToast } from '@/components/ui/toast';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Imperative copy for call sites that are not a `CopyRow` (a kebab item, a
 * toast action button). Same toast pair the three private copies used.
 */
export async function copyValue(value: string, successMsg: string, failureMsg: string) {
  try {
    await navigator.clipboard.writeText(value);
    successToast(successMsg);
    return true;
  } catch {
    errorToast(failureMsg);
    return false;
  }
}

export interface CopyRowProps {
  /** The value copied to the clipboard. Also what renders unless `display` is set. */
  value: string;
  /** Optional label above the value. */
  label?: ReactNode;
  /** Render something other than the raw value (a masked token, say). */
  display?: ReactNode;
  successMessage?: string;
  /** Extra controls between the value and the copy button (Reveal, Rotate…). */
  actions?: ReactNode;
  className?: string;
}

export function CopyRow({
  value,
  label,
  display,
  successMessage,
  actions,
  className,
}: CopyRowProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { copy, copied } = useCopy({
    successMessage: successMessage ?? tI18nComplete.raw('textd37078fe6a1f'),
  });
  const copyLabel = copied
    ? tI18nComplete.raw('text8d525e5f158b')
    : tI18nComplete.raw('texte21f935f11d7');

  return (
    <div className={cn('space-y-1.5', className)}>
      {label ? <span className="text-muted-foreground text-xs font-medium">{label}</span> : null}
      <div className="bg-popover flex items-center gap-2 rounded-md border px-3 py-2">
        <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
          {display ?? value}
        </code>
        {actions}
        <Hint label={copyLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={copyLabel}
            onClick={() => void copy(value)}
            className="text-muted-foreground hover:text-foreground shrink-0"
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
                    <CheckIcon className="text-kortix-green size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </Button>
        </Hint>
      </div>
    </div>
  );
}
