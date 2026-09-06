'use client';

/**
 * One outcome, one row.
 *
 * Purely presentational: it fetches nothing and knows about no modal. The host
 * passes `onOpen` and decides what "open" means for that kind, which is what
 * lets one component serve a change request, a schedule and a GitHub pull
 * request without a `kind` switch in its body.
 *
 * The visual contract is `changes-view.tsx`'s row, which the Kortix design
 * system names as the reference for this shape: a tinted `size-9` tile carries
 * the colour, the chip stays neutral, the enter is a staggered CSS animation.
 * Expressed through `Item` slots so the anatomy is named rather than implied.
 *
 * NOT the Show tool. Show answers "look at this"; this answers "this now
 * exists". See the design doc, §2.2.
 */

import { ArrowSquareOutIcon, GitPullRequestIcon, type Icon } from '@phosphor-icons/react';
import React, { memo } from 'react';

import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { cn } from '@/lib/utils';

import Link from 'next/link';
import type { Outcome, OutcomeKind } from './outcome-types';
import { outcomeMetaLine, outcomeTint, truncateOutcomeTitle } from './outcome-vocabulary';

export const OUTCOME_ICON: Record<OutcomeKind, Icon> = {
  change_request: GitPullRequestIcon,
  external: ArrowSquareOutIcon,
};

/** Matches `changes-view.tsx`: 40ms apart, capped at 8 so a long footer never
 *  crawls. Beyond ~320ms the last row reads as broken rather than staggered. */
const STAGGER_MS = 40;
const STAGGER_CAP = 8;

/**
 * Memoised: `outcome` is stable identity once `derived` (session-chat.tsx) is
 * itself stabilised by content, `index` is a primitive, and `onOpen` is
 * already `useCallback`'d at the call site — so a re-render here would mean
 * every prop happened to be referentially equal AND something else forced the
 * parent to re-render anyway. Context bypasses `React.memo` on its own
 * (`TurnOutcomes` reads `derived` through `SessionOutcomesProvider`), so this
 * is the backstop that keeps a settled card from re-rendering every streaming
 * frame of a DIFFERENT turn's response.
 */
export const OutcomeCard = memo(function OutcomeCard({
  outcome,
  index,
  onOpen,
  icon,
  actionVariant = 'outline',
  className,
}: {
  outcome: Outcome;
  /** Position within its group — drives the stagger only. */
  index: number;
  onOpen: (outcome: Outcome) => void;
  /**
   * Override the glyph `OUTCOME_ICON` would pick from `kind`.
   *
   * Exists for callers outside the session transcript that want this exact row
   * but carry their own meaning — `setup-links/setup-link-button.tsx` renders a
   * key or a plug, and neither is derivable from an `OutcomeKind`. Omit it and
   * the kind decides, which is what every transcript card does.
   */
  icon?: Icon;
  /**
   * The action button's variant. Defaults to `outline`, which is right for the
   * transcript: an outcome row is a RECORD, and a filled button on every one of
   * them would turn a scannable list into a wall of calls to action.
   *
   * `default` (filled) is for a card the reader is BLOCKED on —
   * `setup-links/setup-link-button.tsx` is one: the turn cannot continue until
   * the key is entered or the app connected, so that row is genuinely a CTA
   * rather than a record of something already done.
   */
  actionVariant?: React.ComponentProps<typeof Button>['variant'];
  className?: string;
}) {
  const Glyph = icon ?? OUTCOME_ICON[outcome.kind];
  const tint = outcomeTint(outcome.status.tone);
  // Narrowed to a definite string rather than a boolean flag: `Link`'s `href`
  // is typed `Url`, which does not accept `undefined`, and TypeScript cannot
  // carry a `!!x` check on one variable across to another. Holding the value
  // itself is what makes the branch below type-safe.
  const linkHref = outcome.action.intent === 'link' ? outcome.action.href : undefined;

  return (
    <Item
      variant="muted"
      size="sm"
      data-testid={`outcome-card-${outcome.kind}`}
      data-outcome-id={outcome.id}
      style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * STAGGER_MS}ms` }}
      className={cn('border-border gap-3 border py-2.5 transition-colors', className)}
    >
      {/*
        The two `group-has-…` overrides are load-bearing, not noise. `ItemMedia`
        ships `group-has-[[data-slot=item-description]]/item:self-start` and
        `…:translate-y-0.5`, which top-align the media the moment a description
        exists — correct for a text avatar, wrong for a `size-9` tile beside two
        short lines, which reads as a tile that slipped upward.

        They must be written WITH the same variant prefix. `tailwind-merge`
        keys on modifier + utility, so a bare `self-center` is a DIFFERENT key
        from `group-has-[…]:self-start` and loses the cascade instead of
        replacing it.
      */}
      <ItemMedia
        className={cn(
          'group-has-[[data-slot=item-description]]/item:translate-y-0',
          'group-has-[[data-slot=item-description]]/item:self-center',
        )}
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-sm ring-1',
            tint.ring,
            tint.bg,
          )}
        >
          <Glyph weight="fill" className={cn('size-5', tint.fg)} />
        </span>
      </ItemMedia>

      {/*
        Two lines, one idea each. The title is the agent's own words and nothing
        else; every reference and the status live in one muted line beneath it.

        No status chip. The tinted ring on the tile already says "this one wants
        you" in colour, and a boxed uppercase mono badge saying it again was the
        loudest thing in a row that is meant to be scannable.

        `outcome.description` is deliberately NOT rendered. For most kinds it was
        filler I wrote ("Ready to open or download"), and for a change request it
        restated the title. The detail belongs in the modal, which has room; the
        card is a pointer, not the document.
      */}
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="w-full">
          <span className="truncate">{truncateOutcomeTitle(outcome.title)}</span>
        </ItemTitle>
        <ItemDescription className="truncate text-xs">{outcomeMetaLine(outcome)}</ItemDescription>
      </ItemContent>

      <ItemActions>
        {linkHref ? (
          <Button asChild variant={actionVariant} size="sm" className="active:scale-[0.96]">
            <Link href={linkHref} target="_blank" rel="noopener noreferrer">
              {outcome.action.label}
            </Link>
          </Button>
        ) : (
          <Button
            variant={actionVariant}
            size="sm"
            className="active:scale-[0.96]"
            onClick={() => onOpen(outcome)}
          >
            {outcome.action.label}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
});
