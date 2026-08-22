'use client';

import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { useCopy } from '@/hooks/use-copy';
import { getEnv } from '@/lib/env-config';
import { buildTunnelConnectCommand } from './tunnel-connect-command';

function ConnectSteps() {
  const tHardcodedUi = useTranslations('hardcodedUi');

  return (
    <InlineMeta className="justify-center text-pretty">
      {tHardcodedUi.raw('componentsTunnelTunnelOverview.line203JsxTextText1RunTheCommand')}
      {tHardcodedUi.raw('componentsTunnelTunnelOverview.line205JsxTextText2ApproveInBrowser')}
      {tHardcodedUi.raw('componentsTunnelTunnelOverview.line207JsxTextText3Connected')}
    </InlineMeta>
  );
}

export function ConnectCommandPanel() {
  const command = buildTunnelConnectCommand({
    backendUrl: getEnv().BACKEND_URL || '',
    origin: typeof window !== 'undefined' ? window.location.origin : '',
  });
  const { copied, copy } = useCopy({
    successMessage: 'Command copied',
    errorMessage: 'Copy failed',
    duration: 2000,
  });

  return (
    <div className="w-full space-y-4">
      <div className="bg-popover overflow-hidden rounded-md border">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="text-muted-foreground text-xs">Install command</span>
        </div>
        <div className="bg-secondary relative rounded-t-md">
          <Button
            type="button"
            variant="accent"
            size="xs"
            onClick={() => copy(command)}
            aria-label={copied ? 'Copied' : 'Copy command'}
            className="absolute top-2 right-2 shrink-0 transition-transform active:scale-[0.96]"
          >
            <span className="relative inline-flex size-3.5 items-center justify-center">
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
                    <CheckIcon className="text-kortix-green size-3.5" />
                  ) : (
                    <CopyIcon className="text-muted-foreground size-3.5" />
                  )}
                </m.span>
              </AnimatePresence>
            </span>
          </Button>

          <pre className="text-foreground/90 overflow-x-auto px-4 py-3 text-left font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            {command}
          </pre>
        </div>
      </div>
      <ConnectSteps />
    </div>
  );
}
