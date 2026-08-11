'use client';

import { dosco } from '@/features/icon/icons/kortix';
import { Slack } from '@/features/icon/icons/slack';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { thread } from './content';

/** The square avatar every turn carries: an initial for a person, the dosco
 *  mark for the agent. Drawn rather than imported so nothing here needs an
 *  image request or a real face. */
function Avatar({ kind, who }: { kind: string; who: string }): ReactNode {
  if (kind === 'person') {
    return (
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-sm text-[11px] font-medium"
      >
        {who.slice(0, 1)}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="border-border bg-background flex size-7 shrink-0 items-center justify-center rounded-sm border"
    >
      <dosco className="size-3" />
    </span>
  );
}

/**
 * One Slack thread, drawn from divs and mono type rather than a screenshot: it
 * stays sharp, it themes correctly, and a screen reader gets the conversation
 * as the list it is.
 *
 * The claim this visual has to carry is the whole page in one frame — a message
 * becomes a session, the session is a branch on a real machine, and the decision
 * comes back as buttons in the same thread. The rule down the middle is the
 * session; everything above it is chat and everything below it is the round trip.
 *
 * ACCURACY: the buttons are a Review Center card, which genuinely renders in
 * Slack. The diff summary beside it is a label, not a rendered diff — reading a
 * diff happens in the web app. Do not redraw this as a code review pane.
 */
export function ThreadMock(): ReactNode {
  const { mock } = thread;

  return (
    <figure className="border-border bg-card flex h-full flex-col overflow-hidden rounded-sm border">
      {/* channel header */}
      <div className="border-border flex items-center gap-3 border-b px-5 py-3.5 sm:px-6">
        <Slack className="size-4 shrink-0" />
        <span className="text-muted-foreground font-mono text-xs">{mock.channel}</span>
      </div>

      {/* `justify-between` rather than a fixed height: the thread sits at the
          top and the decision at the bottom, so the card fills its column
          beside the four-step list without inventing empty space in between. */}
      <div className="flex min-h-0 flex-1 flex-col justify-between px-5 py-5 sm:px-6 sm:py-6">
        <ul className="grid gap-5">
          {mock.turns.map((turn) => (
            <li key={turn.id} className="flex items-start gap-3">
              <Avatar kind={turn.kind} who={turn.who} />
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-[13px] font-medium">{turn.who}</span>
                {turn.kind === 'file' ? (
                  <span className="border-border bg-background mt-2 flex w-fit items-center gap-2.5 rounded-sm border px-3 py-2">
                    <span aria-hidden className="bg-muted-foreground/25 size-2.5 rounded-full" />
                    <span className="text-muted-foreground font-mono text-xs">{turn.text}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
                    {turn.text}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>

        {/* the session, drawn as the rule the thread hangs on */}
        <div className="my-6 flex flex-wrap items-center gap-3">
          <span className="border-border bg-background text-foreground shrink-0 rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
            {mock.system.label}
          </span>
          <span className="text-muted-foreground/60 shrink-0 font-mono text-xs">
            {mock.system.id}…
          </span>
          <span aria-hidden className="bg-border h-px min-w-6 flex-1" />
          <span className="text-muted-foreground/60 font-mono text-[11px]">{mock.system.note}</span>
        </div>

        {/* the decision, back in the thread */}
        <div className="border-border bg-background rounded-sm border p-4 sm:p-5">
          <p className="text-foreground text-sm font-medium">{mock.review.title}</p>
          <p className="text-muted-foreground/70 mt-1.5 font-mono text-xs">{mock.review.body}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {mock.review.actions.map((action, i) => (
              <span
                key={action}
                className={cn(
                  'rounded-sm border px-3 py-1.5 text-xs font-medium',
                  i === 0
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground',
                )}
              >
                {action}
              </span>
            ))}
          </div>
        </div>
      </div>

      <figcaption className="border-border text-muted-foreground/50 border-t px-5 py-3 font-mono text-[10px] tracking-wide sm:px-6">
        {mock.caption}
      </figcaption>
    </figure>
  );
}
