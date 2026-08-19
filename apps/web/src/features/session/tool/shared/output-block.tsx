'use client';

/**
 * The ONE way a tool view shows raw or lightly-structured output (spec S1).
 * Every bare `<pre>{output}</pre>` in tool/tools/ converts to this, so the
 * grammar (mono, capped scroll, muted wrap) can never drift per-file again.
 */

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { cn } from '@/lib/utils';
import { CaretRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

/**
 * This is deliberately NOT a card, which is why it keeps its own `bg-muted/20
 * rounded-sm px-3 py-2` while every card normalized onto the surface gates.
 *
 * `ToolOutputCard`, `ToolResultCard`, `ToolCodeCard` and bash's command card
 * are all TOP-LEVEL: each is the one object a tool row hangs under itself, so
 * each draws the hairline frame, owns a horizontal scroll axis, and de-nests on
 * the panel because the row card is already that frame. This block is none of
 * those. It is a nested passage of wrapped text — mono or markdown, `whitespace-
 * pre-wrap wrap-break-word`, so it has no x-scroll to reconcile — and it has no
 * frame to drop, because `bg-muted/20 rounded-sm` is a shade change, not an
 * edge. It marks "this stretch is the tool's raw words" the way a blockquote
 * marks quoted text, and it does that whether it sits inside a card, inside a
 * `ToolSection`/`FoldedSection`, or straight in a row body. Handing it to
 * `useToolCardFrame`/`useToolCardPad` would delete the only cue separating it
 * from the prose around it and buy back nothing, since it has no second frame
 * and no second inset to collapse. So the gates stop at the cards, and the
 * literals here stay.
 */
export function OutputBlock({
  text,
  markdown = false,
  className,
}: {
  text: string;
  markdown?: boolean;
  className?: string;
}) {
  return (
    <div
      data-scrollable
      className={cn('bg-muted/20 max-h-96 overflow-auto rounded-sm px-3 py-2', className)}
    >
      {markdown ? (
        <UnifiedMarkdown content={text} />
      ) : (
        <pre className="text-muted-foreground/80 font-mono text-xs wrap-break-word whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </div>
  );
}

/** The one sanctioned section label (spec S1) — kills every ad-hoc
 *  sky/amber/connector uppercase treatment. */
export function ToolSection({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-muted-foreground/60 text-[10px] font-medium tracking-wider uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * A {@link ToolSection} whose body is FOLDED AWAY until the reader asks for it.
 *
 * The memory, connector and trigger views answered a call by stacking every
 * section they could parse — request, facts, concepts, files, tags, schemas —
 * all open, all at once. Inline that is a wall; in the Easy panel, where the
 * detail un-caps every `data-scrollable` height, it is a longer wall. But the
 * answer is usually ONE of those sections (a memory's content, a page's text)
 * and the rest is provenance. So the answer stays on screen and the provenance
 * becomes a row you can open.
 *
 * The trigger is the section label itself — same 10px uppercase treatment as
 * `ToolSection`, so a folded section and an open one read as the same kind of
 * thing — plus the `CaretRightIcon` that every disclosure in this feature uses
 * as its mark. `role`, `tabIndex`, `aria-expanded` and the Enter/Space handler
 * come from `DisclosureTrigger`; nothing here re-implements them.
 *
 * `label` takes a node, not just a string, because a folded row sometimes has
 * to carry its own summary — a memory hit folds its content behind the one
 * line that says which memory it is. `triggerClassName` retypes that row for
 * those cases; leave it unset for a section label.
 */
export function FoldedSection({
  label,
  children,
  defaultOpen = false,
  className,
  triggerClassName,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  /** Closed is the point. Pass `true` only where the fold is a courtesy. */
  defaultOpen?: boolean;
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Disclosure open={open} onOpenChange={setOpen} className={cn('space-y-1', className)}>
      <DisclosureTrigger>
        <div
          className={cn(
            'text-muted-foreground/60 hover:text-muted-foreground flex w-full cursor-pointer items-center gap-1 text-left text-[10px] font-medium tracking-wider uppercase transition-colors',
            triggerClassName,
          )}
        >
          <CaretRightIcon
            aria-hidden
            // CSS, not `motion`: one property, one state change, and a memory
            // card can hold five of these at once.
            className={cn(
              'size-3 shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
          />
          {label}
        </div>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="pt-1">{children}</div>
      </DisclosureContent>
    </Disclosure>
  );
}

export function ToolField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-muted-foreground/60 shrink-0">{label}</span>
      <span className={cn('text-foreground/80 min-w-0 truncate', mono && 'font-mono')}>
        {value}
      </span>
    </div>
  );
}
