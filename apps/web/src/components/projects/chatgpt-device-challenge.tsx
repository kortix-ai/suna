'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';

export function ChatGptDeviceChallenge({ url, code }: { url: string; code: string | null }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-foreground text-xs font-medium">
          {tI18nComplete.raw('text3d927b930ba7')}
        </p>
        <p className="text-muted-foreground text-xs leading-5 text-pretty">
          {tI18nComplete.raw('text5ecf97e61ad9')}
        </p>
      </div>

      {code ? (
        <div className="border-border bg-muted flex min-h-10 items-center gap-2 rounded-sm border py-1 pr-1 pl-3">
          <code className="text-foreground min-w-0 flex-1 font-mono text-lg font-semibold tracking-widest tabular-nums">
            {code}
          </code>
          <Hint label={tI18nComplete.raw('text49a0053f3b0d')}>
            <CopyButton code={code} className="size-10 shrink-0" />
          </Hint>
        </div>
      ) : null}

      {url ? (
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            {tI18nComplete.raw('textd0858bfa4be3')}
          </a>
        </Button>
      ) : null}
    </div>
  );
}
