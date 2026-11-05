'use client';

import { useTranslations } from '../../i18n';
import type { QueueRow } from './queue-projection';

/**
 * The queue of a messages-only thread (a space's thread, flag `chat`), said
 * in calm lines above the reply box instead of the queue card. The inbox rows
 * stay the source of truth; this is a view on them:
 * - a message of yours whose delivery failed: its words, "Not sent", "Retry";
 * - a Stop holding the queue: "Stopped", "Resume";
 * - every other row (queued, sending): the queue card, via `children`.
 * Platform rows (a worker's report, `synthetic`) are not a person's message:
 * they wait behind Resume and are not listed.
 */
export function ChatQueueLines({
  rows,
  heldCount,
  resumePending,
  onResume,
  onRetry,
  children,
}: {
  rows: readonly QueueRow[];
  heldCount: number;
  resumePending: boolean;
  onResume: () => void;
  onRetry?: (promptId: string) => void;
  /** The card for the rows these lines do not say. */
  children?: React.ReactNode;
}) {
  const t = useTranslations('sessionUi.turn');
  const failed = rows.filter((row) => row.state === 'failed' && !row.synthetic);
  if (failed.length === 0 && heldCount === 0 && !children) return null;
  return (
    <div className="space-y-1.5">
      {failed.map((row) => (
        <div key={row.id} role="status" className="flex min-w-0 items-center gap-1.5 px-1 text-xs">
          <span className="text-foreground min-w-0 truncate" title={row.text}>
            {row.text}
          </span>
          <span className="text-muted-foreground shrink-0">· {t('notSent')}</span>
          {row.retryable && onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(row.id)}
              className="text-foreground focus-visible:ring-ring shrink-0 rounded-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2"
            >
              {t('retry')}
            </button>
          ) : null}
        </div>
      ))}
      {heldCount > 0 ? (
        <div role="status" className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs">
          <span>{t('stopped')}</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onResume}
            disabled={resumePending}
            aria-busy={resumePending || undefined}
            className="text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 disabled:opacity-50"
          >
            {t('resume')}
          </button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
