'use client';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';

/**
 * Where a prompt came from, drawn above its bubble: mark · source · sender.
 * One pill for every non-typed origin — a Slack / Teams / Telegram message
 * (`ChannelMessage`) and a prompt another Kortix session sent
 * (`MessageAuthorLabel`), a reminder fire and a trigger fire — so they never
 * drift apart. Hovering or focusing it opens `card` with the origin's detail;
 * `cardClassName` widens the card when a row holds a long value.
 */
export function SourcePill({
  mark,
  source,
  sourceColor,
  sender,
  card,
  cardClassName,
}: {
  mark: React.ReactNode;
  source: string;
  sourceColor?: string;
  sender: string;
  card: React.ReactNode;
  cardClassName?: string;
}) {
  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-testid="message-source"
          className="bg-foreground/5 text-muted-foreground hover:bg-foreground/10 focus-visible:ring-ring inline-flex max-w-[80%] items-center gap-1.5 rounded-full py-0.5 pr-2.5 pl-2 text-xs transition-colors duration-(--duration-normal) focus-visible:ring-2 focus-visible:outline-none"
        >
          {mark}
          <span style={sourceColor ? { color: sourceColor } : undefined}>{source}</span>
          <span aria-hidden="true">·</span>
          <span className="text-foreground truncate font-medium">{sender}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className={cn('w-60 p-0', cardClassName)}>
        {card}
      </HoverCardContent>
    </HoverCard>
  );
}

/** The hover card body: a titled header, label/value rows (empty rows drop) and an optional footer. */
export function SourceCard({
  mark,
  title,
  rows = [],
  footer,
}: {
  mark: React.ReactNode;
  title: string;
  rows?: Array<{ label: string; value: React.ReactNode }>;
  footer?: React.ReactNode;
}) {
  const shown = rows.filter((row) => row.value);
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3 text-xs">
      <div className="text-foreground flex items-center gap-1.5 font-medium">
        {mark}
        {title}
      </div>
      {shown.length > 0 && (
        <dl className="flex flex-col gap-1">
          {shown.map((row) => (
            <div key={row.label} className="flex items-center gap-3">
              <dt className="text-muted-foreground w-18 shrink-0 whitespace-nowrap">{row.label}</dt>
              <dd className="text-foreground min-w-0 truncate">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {footer}
    </div>
  );
}
