'use client';

import { useTranslations } from '@/i18n/use-translations';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';

import { Button } from '@/components/ui/button';
import { useCopy } from '@/hooks/use-copy';
import { getEnv } from '@/lib/env-config';
import { buildTunnelConnectCommand } from './tunnel-connect-command';

/** The npx pairing command, for a machine without the desktop app. */
export function ConnectCommandPanel({ projectId }: { projectId?: string }) {
  const t = useTranslations('computers');
  const reduceMotion = useReducedMotion();
  const command = buildTunnelConnectCommand({
    backendUrl: getEnv().BACKEND_URL || '',
    origin: typeof window !== 'undefined' ? window.location.origin : '',
    projectId,
  });
  const { copied, copy } = useCopy({
    successMessage: t('commandCopied'),
    errorMessage: t('copyFailed'),
    duration: 2000,
  });
  const hidden = reduceMotion ? { opacity: 0 } : { scale: 0.25, opacity: 0, filter: 'blur(4px)' };
  const shown = reduceMotion ? { opacity: 1 } : { scale: 1, opacity: 1, filter: 'blur(0px)' };

  return (
    <div className="bg-secondary relative w-full rounded-md">
      <Button
        type="button"
        variant="accent"
        size="xs"
        onClick={() => copy(command)}
        aria-label={copied ? t('commandCopied') : t('copyCommand')}
        className="absolute top-2 right-2 shrink-0 transition-transform active:scale-[0.96]"
      >
        <span className="relative inline-flex size-3.5 items-center justify-center">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={copied ? 'check' : 'copy'}
              initial={hidden}
              animate={shown}
              exit={hidden}
              transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              className="absolute inset-0 inline-flex items-center justify-center"
            >
              {copied ? (
                <CheckIcon className="text-kortix-green size-3.5" />
              ) : (
                <CopyIcon className="text-muted-foreground size-3.5" />
              )}
            </m.span>
          </AnimatePresence>
        </span>
      </Button>
      <pre className="text-foreground overflow-x-auto py-3 pr-12 pl-4 text-left font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
        {command}
      </pre>
    </div>
  );
}
