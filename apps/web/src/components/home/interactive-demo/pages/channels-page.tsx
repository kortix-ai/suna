'use client';

import { Button } from '@/components/ui/button';
import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { ChevronDown, Message as MessageSquare } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PageHead } from '../primitives';

export function ChannelsPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [showByo, setShowByo] = useState(false);
  return (
    <div>
      <PageHead
        title="Channels"
        sub={tI18nHardcoded.raw(
          'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxAttrSub03b65d67',
        )}
      />

      <div className="border-border bg-card overflow-hidden rounded-md border">
        <div className="flex flex-col items-start gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="border-border flex size-14 shrink-0 items-center justify-center rounded-lg border">
              <Icon.Slack className="size-7" />
            </span>
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">
                {tI18nHardcoded.raw(
                  'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextAdd56167f5a',
                )}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {tI18nHardcoded.raw(
                  'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextOne711d17b7',
                )}
              </p>
            </div>
          </div>
          <Button size="sm" className="shrink-0">
            <Icon.Slack className="size-3.5" />{' '}
            {tI18nHardcoded.raw(
              'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextAdd238856dd',
            )}
          </Button>
        </div>

        <button
          type="button"
          onClick={() => setShowByo((v) => !v)}
          className="border-border hover:bg-muted/30 flex w-full items-center justify-between gap-3 border-t px-4 py-3 text-left transition-colors"
          aria-expanded={showByo}
        >
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextBringaefcc1f4',
              )}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {tI18nHardcoded.raw(
                'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextFor7cbd4533',
              )}
            </p>
          </div>
          <ChevronDown
            className={cn(
              'text-muted-foreground size-4 shrink-0 transition-transform',
              showByo && 'rotate-180',
            )}
          />
        </button>
        {showByo && (
          <div className="border-border text-muted-foreground border-t px-4 py-3 text-xs">
            {tI18nHardcoded.raw(
              'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextPaste0cac2ba3',
            )}
            <span className="text-foreground font-mono">project_secrets</span>.
          </div>
        )}
      </div>

      <div className="border-border/60 bg-muted/20 text-muted-foreground mt-3 flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs">
        <MessageSquare className="size-3.5 shrink-0" />
        {tI18nHardcoded.raw(
          'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextInvite62b0b613',
        )}{' '}
        <span className="text-foreground font-mono">
          {tI18nHardcoded.raw(
            'autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextMention48d6e12f',
          )}
        </span>{' '}
        {tI18nHardcoded.raw('autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextIt4dd92d7f')}
      </div>
    </div>
  );
}
