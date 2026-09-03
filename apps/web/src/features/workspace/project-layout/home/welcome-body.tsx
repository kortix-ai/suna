'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';

import { IdentityConfetti } from '@/components/ui/identity-confetti';
import { SessionWelcome } from '@/features/session/session-welcome';
import { resolveConfettiFace } from '@/lib/confetti-identity';
import { useProjectIcon, useProjectName } from '@kortix/sdk/react';
import {
  HOME_GREETINGS,
  HOME_GREETING_STORAGE_KEY,
  greetingIndexFor,
  spaceBefore,
} from './home-greeting';

/**
 * The project-home empty state: ONE centred column.
 *
 * The ask group — heading, composer, starter chips — is one block, and the
 * setup checklist is its sibling directly beneath. That is the whole layout.
 *
 * It used to be two: the ask group centred with `m-auto`, and the setup row
 * pinned to the bottom of the viewport in its own `shrink-0` band. Those two
 * had no relationship to each other and no shared alignment — the setup row
 * read as something that had fallen off the page rather than as the next
 * thing to do. One column with one gap gives the checklist a reason to be
 * where it is, and gives both blocks the same left and right edges.
 *
 * ## Where the column sits: centred
 *
 * `m-auto`. Plainly centred on both axes, which is where it started.
 *
 * It was briefly centred in the TOP HALF instead, against a half-height
 * ballast element, to stop the column sliding when the setup checklist was
 * dismissed. That was the wrong fix for two reasons, and it is worth writing
 * down so nobody reaches for it again:
 *
 * 1. It solved a problem that no longer exists. The slot below the composer is
 *    now ALWAYS occupied — the checklist while there are open steps, the
 *    starter prompts once there are not (`ProjectHomeSections`). The column's
 *    height barely changes across that swap, so the slide it was compensating
 *    for is gone at the source.
 * 2. Centring inside a half is only distinguishable from pinning to the top
 *    while the content is much shorter than that half. With the starter band
 *    in the slot the content is nearly as tall as the top half, so the maths
 *    put it flush against the top edge with the whole bottom half left empty.
 *    A rule that degrades into "jammed at the top" the moment content grows is
 *    not a layout rule, it is a coincidence.
 *
 * `shrink-0` stays. It has nothing to do with the centring: it stops the
 * column being squashed when the container is shorter than the content — a
 * phone in landscape, or the on-screen keyboard halving the viewport — so the
 * overflow scrolls instead. Auto margins resolve to zero once free space is
 * negative, so the column simply starts at the top and scrolls, with nothing
 * unreachable above it.
 *
 * Shared by the project index page AND the instant session shell's empty
 * state, so a brand-new session opens onto the identical surface.
 *
 * The workspace's name in the heading is a button: pressing it throws confetti
 * made of that workspace's own icon (`components/ui/identity-confetti.tsx`) out
 * of the word itself. It is the one playful thing on this screen, and it is
 * deliberately silent at rest — see the button's own comment for why it carries
 * no hover treatment.
 *
 * ONLY when the workspace wears an icon someone picked — an emoji or a glyph.
 * With neither, `resolveConfettiFace` degrades to the chalk initial tile, and
 * throwing thirty-eight copies of the letter already sitting in the heading is
 * not a celebration. Those workspaces render the name as plain text, so there
 * is no pointer and no tooltip offering a payoff that would fall flat.
 */
export function ProjectHomeWelcomeBody({
  projectId,
  composer,
  onPickSuggestion,
}: {
  projectId: string;
  /** The composer input rendered in the hero position, directly under the heading. */
  composer?: ReactNode;
  /** When provided, starter-prompt chips render directly below the composer. */
  onPickSuggestion?: (text: string) => void;
}) {
  // One source for the project name — see `useProjectName`'s doc comment.
  const name = useProjectName(projectId) ?? '';
  // The SAME `qk.project.detail(projectId)` entry `useProjectName` reads, so
  // the name in this heading and the icon thrown out of it cannot come from
  // two caches that have diverged — and it costs no extra request.
  const icon = useProjectIcon(projectId);
  // Only an icon someone CHOSE is worth throwing. `resolveConfettiFace` falls
  // through to the chalk initial tile when a project has neither emoji nor
  // glyph, and a burst of the same letter the heading is already showing reads
  // as noise, not as a celebration. Those projects get plain text instead — no
  // pointer, no tooltip promising a payoff that would not land. Gated on the
  // resolver rather than on `icon?.icon` so this can never disagree with the
  // face `EntityAvatar` draws, including the unknown-glyph fall-through.
  const wearsChosenIcon =
    resolveConfettiFace({ glyph: icon?.icon_glyph, emoji: icon?.icon, label: name }).kind !==
    'initial';
  // `id` is the remount key: `IdentityConfetti` fires on mount, so a second
  // press needs a second mount. `origin` is captured per press rather than
  // fixed, because the word moves — the heading rewraps with the viewport and
  // with the length of the name.
  const [burst, setBurst] = useState<{ id: number; origin: { x: number; y: number } } | null>(null);
  // One word, not two. The name sits inside the sentence in `text-foreground`
  // while the rest is muted, so the fallback has to read as a NAME in that
  // slot — "this project" is a description wearing a name's highlight, and it
  // stretches the line for a case where we know the least.
  const displayName = name.trim() || 'it';
  // Variant 0 on the server and through hydration; the stored visit count
  // picks the real one before first paint. See `home-greeting.ts`.
  const [greeting, setGreeting] = useState(HOME_GREETINGS[0]);
  useLayoutEffect(() => {
    try {
      const stored = window.localStorage.getItem(HOME_GREETING_STORAGE_KEY);
      // A layout effect on purpose: the swap has to land before first paint,
      // and the value cannot be read during render (no window on the server).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGreeting(HOME_GREETINGS[greetingIndexFor(stored)]);
      const n = Number.parseInt(stored ?? '', 10);
      window.localStorage.setItem(
        HOME_GREETING_STORAGE_KEY,
        String(Number.isFinite(n) && n >= 0 ? n + 1 : 1),
      );
    } catch {
      // Storage blocked (private mode, an in-app WebView): variant 0 stays.
    }
  }, []);

  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/*
        Left-aligned, one edge. Every block in this column — the heading, the
        composer card, the checklist panel — starts at the same x, so the eye
        has a single rail to run down instead of a centred axis it has to
        re-find on every line.

        No `items-center` anywhere: each child is `w-full` and aligns itself.
        Centring a column whose children all span it does nothing except hide
        which rule is actually doing the work.

        `gap-10` has exactly two children to separate: the ask group and the
        checklist. Every gap inside each group is owned by that group.

        `m-auto` — centred on both axes. See this component's header for the
        half-height ballast this replaced, and why that approach collapsed into
        "pinned to the top" the moment the slot below always had content in
        it.

        `py-8` is symmetric, so it cannot bias the centre. It is breathing room
        for the case where the container is short and the auto margins have
        gone to zero.

        `shrink-0` so a short container scrolls the column rather than
        compressing it.
      */}
      <div className="m-auto flex w-full max-w-3xl shrink-0 flex-col gap-10 py-8 sm:px-4">
        <div className="flex w-full flex-col gap-6">
          {/*
            `w-full` with no `max-w`: the line runs the full column and breaks
            where the column ends, which is the composer's own right edge.

            `px-4` is not decoration — it is what puts this line on the same
            rail as everything under it. The composer card sits at the column
            edge but insets its own text by `px-2` twice (14.72px), and the
            checklist header insets its title by `pl-4` (14.72px). A heading
            flush at x0 would be the only text in the column NOT on that rail,
            which on a left-aligned layout is the one misalignment you cannot
            un-see.

            `text-pretty` rather than `text-balance` — balance evens out a
            centred block, and this one is ragged-right by design; pretty just
            keeps the last line off a single orphan word.
          */}
          <h1 className="text-muted-foreground w-full px-4 text-3xl leading-[1.2] tracking-tight text-balance max-sm:text-2xl">
            {greeting.before}{' '}
            {/*
              A real <button>, not a <span> with an onClick: this is the only
              interactive thing in the heading, and it has to be reachable by
              keyboard and announced as pressable. A button is phrasing content,
              so nesting it in an <h1> is valid, and its text still counts
              toward the heading's accessible name — the sentence reads intact.

              `inline` overrides the UA's `inline-block`, which is what keeps
              this byte-identical to the <span> it replaces: an inline-block
              cannot break across lines, so a two-word workspace name would
              suddenly refuse to wrap and push the line ragged.

              NO hover or press treatment, and that is the decision, not an
              omission. This heading is on screen every time a workspace is
              opened — the top rung of the motion ladder, where the budget is
              none. A permanent affordance in a hero line would also be visual
              noise on every load for a control nobody needs to find. The
              pointer cursor and the tooltip are the whole invitation.
            */}
            {wearsChosenIcon ? (
              <button
                type="button"
                title="Throw some confetti"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setBurst((current) => ({
                    id: (current?.id ?? 0) + 1,
                    // Canvas fractions, measured against the viewport, because
                    // the confetti canvas is portalled to <body> at `fixed
                    // inset-0`. Centre of the word, so the burst comes out of
                    // the name rather than from somewhere near it.
                    origin: {
                      x: (rect.left + rect.width / 2) / window.innerWidth,
                      y: (rect.top + rect.height / 2) / window.innerHeight,
                    },
                  }));
                }}
                className="text-foreground focus-visible:ring-ring inline cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              >
                {displayName}
              </button>
            ) : (
              // Same colour, no affordance: the name still carries the
              // sentence's one highlight, it just is not pressable.
              <span className="text-foreground">{displayName}</span>
            )}
            {spaceBefore(greeting.after) ? ' ' : ''}
            {greeting.after}
          </h1>

          {/* Keyed on the press count, so each press is a fresh mount and a
              fresh burst. Rendered here rather than inside the <h1> because a
              canvas is not phrasing content; it portals to <body> anyway, so
              its position in this tree has no visual effect. */}
          {burst ? (
            <IdentityConfetti
              key={burst.id}
              label={name}
              emoji={icon?.icon}
              glyph={icon?.icon_glyph}
              origin={burst.origin}
            />
          ) : null}

          {composer ? <div className="flex w-full flex-col gap-4">{composer}</div> : null}
        </div>

        {/* Nothing under the composer, on purpose (Marko, 2026-09-02: "just
            have the chat input there & that's it"). The "Get started" setup
            checklist (`ProjectHomeSections`) and the "Start with" starter
            prompts (`StarterPromptBand`) both used to fill this slot; both
            components still exist for hosts that want them, and the setup
            steps stay reachable from Customize. `onPickSuggestion` stays on
            the props so those hosts keep their contract. */}
      </div>
    </div>
  );
}

/** The wallpaper behind the hero. Pointer-transparent and inert — it is
 *  scenery, and nothing in it is reachable. */
export function ProjectHomeWallpaper() {
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      <SessionWelcome />
    </div>
  );
}
