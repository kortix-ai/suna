import { ArrowUpLeftIcon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import type { ComposerQuote } from './composer-logic';
import { QuoteList } from './quote-list';
import { COMPOSER_INPUT_SLOT_CLASS, type SessionChatInputProps } from './composer';

interface ComposerAboveCardProps {
  dockId: string;
  slashMenuPlacement: 'above' | 'below';
  quotes: ComposerQuote[];
  quoteListLabels: { count: string; expand: string; collapse: string; remove: string };
  onRemoveQuote: (id: string) => void;
  threadContext: SessionChatInputProps['threadContext'];
  inputSlot: SessionChatInputProps['inputSlot'];
  notice: SessionChatInputProps['notice'];
  onNoticeRetry: SessionChatInputProps['onNoticeRetry'];
  backToParentLabel: string;
}

export function ComposerAboveCard({
  dockId,
  slashMenuPlacement,
  quotes,
  quoteListLabels,
  onRemoveQuote,
  threadContext,
  inputSlot,
  notice,
  onNoticeRetry,
  backToParentLabel,
}: ComposerAboveCardProps) {
  const showQueueStrip = Boolean(threadContext || inputSlot);
  return (
    <>
      {slashMenuPlacement === 'above' && <div id={dockId} />}
      <div className="mb-2 w-full empty:hidden">
        <QuoteList
          key={quotes.length === 0 ? 'empty' : 'quotes'}
          quotes={quotes}
          labels={quoteListLabels}
          onRemove={onRemoveQuote}
        />
      </div>
      {(notice || showQueueStrip) && (
        <div className="relative isolate flex w-full flex-col items-center justify-center">
          {showQueueStrip && (
            <div className={COMPOSER_INPUT_SLOT_CLASS}>
              {threadContext && (
                <button
                  onClick={threadContext.onBackToParent}
                  className="group text-muted-foreground hover:text-foreground hover:bg-muted/80 flex cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                >
                  <ArrowUpLeftIcon className="text-muted-foreground size-3.5 flex-shrink-0 transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {backToParentLabel}{' '}
                    <span className="text-foreground font-medium">{threadContext.parentTitle}</span>
                  </span>
                </button>
              )}
              {inputSlot}
            </div>
          )}
          {notice && (
            <div
              role="status"
              aria-live="polite"
              className="bg-sidebar border-border flex w-full items-center gap-2 rounded-t-xl border border-b-0 px-3 py-1.5"
            >
              <Loading className="size-3.5 shrink-0" />
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                {notice}
              </span>
              {onNoticeRetry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground hover:text-foreground h-auto shrink-0 px-1.5 py-0.5 text-xs"
                  onClick={onNoticeRetry}
                >
                  {'Retry'}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
