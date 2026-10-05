'use client';

import { ArrowCounterClockwiseIcon, CopyIcon, TrashIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import type { PendingSessionPrompt } from '@kortix/sdk';
import { useTranslations } from '@/i18n/use-translations';

interface ProviderFailureRecoveryProps {
  pendingPrompt: PendingSessionPrompt | null;
  isRetrying: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

/** One recovery surface for every terminal sandbox-provider failure. */
export function ProviderFailureRecovery({
  pendingPrompt,
  isRetrying,
  onRetry,
  onCopy,
  onDelete,
}: ProviderFailureRecoveryProps) {
  const t = useTranslations('sessionUi.providerRecovery');
  const attachmentNames = pendingPrompt?.attachment_names ?? [];

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      {pendingPrompt ? (
        <div className="border-border/60 bg-muted/40 w-full rounded-md border px-3 py-2.5 text-left">
          <p className="text-muted-foreground mb-1 text-xs font-medium">{t('savedPrompt')}</p>
          {pendingPrompt.text ? (
            <p className="text-foreground max-h-40 overflow-y-auto text-xs leading-relaxed wrap-break-word whitespace-pre-wrap">
              {pendingPrompt.text}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">{t('noText')}</p>
          )}
          {attachmentNames.length > 0 ? (
            <div className="border-border/60 mt-2 border-t pt-2">
              <p className="text-muted-foreground mb-1 text-xs font-medium">
                {t('attachments', { count: attachmentNames.length })}
              </p>
              <ul className="text-muted-foreground/70 space-y-0.5 text-xs">
                {attachmentNames.map((name, index) => (
                  <li key={`${name}-${index}`} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground/70 mt-1 text-xs">{t('reattach')}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('unavailable')}</p>
      )}

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={isRetrying}
          aria-busy={isRetrying}
        >
          {isRetrying ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <ArrowCounterClockwiseIcon className="size-3.5 shrink-0" />
          )}
          {isRetrying ? t('retrying') : t('retry')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCopy}
          disabled={!pendingPrompt?.text}
        >
          <CopyIcon className="size-3.5 shrink-0" />
          {t('copy')}
        </Button>
        <Button type="button" size="sm" variant="destructive" onClick={onDelete}>
          <TrashIcon className="size-3.5 shrink-0" />
          {t('delete')}
        </Button>
      </div>
    </div>
  );
}
