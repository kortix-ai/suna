'use client';

/**
 * Static "how this looks in Slack" preview — a tokenized Block Kit message card.
 * Demonstrates cross-surface parity: the same Review Item posts in-thread with
 * Approve / Deny / Ask for changes buttons that resume the agent. Illustrative;
 * buttons call back into the same handler so the prototype stays clickable.
 */

import { cn } from '@/lib/utils';
import { ArrowUpRight, SparklesSolid } from '@mynaui/icons-react';
import type { ReviewItem } from './types';

type SlackVerb = 'approve' | 'deny' | 'changes';

function BlockButton({
  children,
  tone = 'default',
  onClick,
}: {
  children: React.ReactNode;
  tone?: 'primary' | 'danger' | 'default';
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-3 py-1 text-xs font-medium transition-transform active:scale-[0.96]',
        tone === 'primary' && 'border-kortix-green/40 bg-kortix-green/10 text-kortix-green',
        tone === 'danger' && 'border-kortix-red/40 bg-kortix-red/10 text-kortix-red',
        tone === 'default' && 'border-border bg-background text-foreground hover:bg-muted/50',
      )}
    >
      {children}
    </button>
  );
}

export function SlackPreview({
  item,
  onAction,
}: {
  item: ReviewItem;
  onAction?: (verb: SlackVerb) => void;
}) {
  const riskLine =
    item.risk === 'high'
      ? '⚠️ High-risk — sends/charges in the real world'
      : item.risk === 'medium'
        ? 'Medium-risk action'
        : null;

  return (
    <div className="bg-background rounded-lg border p-3">
      <div className="flex items-start gap-2.5">
        <span className="bg-kortix-base/15 flex size-8 shrink-0 items-center justify-center rounded-md">
          <SparklesSolid className="text-kortix-base size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-foreground text-sm font-semibold">Kortix</span>
            <span className="bg-muted text-muted-foreground rounded px-1 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
              App
            </span>
            <span className="text-muted-foreground/70 text-xs">just now</span>
          </div>

          {/* Block Kit "section" */}
          <div className="text-foreground mt-1 text-sm">
            <span className="font-semibold">{item.title}</span>
            <div className="text-muted-foreground mt-0.5 text-[13px] text-pretty">
              {item.summary}
            </div>
            {riskLine && <div className="text-muted-foreground mt-1 text-xs">{riskLine}</div>}
          </div>

          {/* Block Kit "actions" */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <BlockButton tone="primary" onClick={() => onAction?.('approve')}>
              {item.kind === 'change' ? 'Ship it' : item.kind === 'decision' ? 'Answer' : 'Approve'}
            </BlockButton>
            {item.kind !== 'decision' && (
              <BlockButton tone="danger" onClick={() => onAction?.('deny')}>
                {item.kind === 'change' ? 'Reject' : 'Deny'}
              </BlockButton>
            )}
            <BlockButton onClick={() => onAction?.('changes')}>Ask for changes</BlockButton>
            <BlockButton>
              View in Kortix
              <ArrowUpRight className="size-3" />
            </BlockButton>
          </div>

          <div className="text-muted-foreground/60 mt-2 text-[11px]">
            ↩ Click a button, or reply in this thread to answer
          </div>
        </div>
      </div>
    </div>
  );
}
