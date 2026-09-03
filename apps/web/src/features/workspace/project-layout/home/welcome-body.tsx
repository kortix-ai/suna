'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';

import { IdentityConfetti } from '@/components/ui/identity-confetti';
import { SessionWelcome } from '@/features/session/session-welcome';
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
 * ## Where the column sits: the BOTTOM of the top half
 *
 * Cut the viewport in two. The ask group is pinned to the bottom edge of the
 * upper half, so the composer's lower edge sits on the page's midline and the
 * heading stacks up from there; the lower half is empty ballast. Not centred
 * within the half — that put the group a quarter of the way down, which read
 * as floating (Jay, 2026-09-03: "it should be running to the extremely bottom
 * side" of the upper section). Anchored to the midline it reads as a fixed
 * position rather than a fraction of whatever the viewport happens to be.
 *
 * This layout was tried once before and reverted, for two reasons that were
 * true then and are not true now. Both are worth keeping on record:
 *
 * 1. The slot under the composer used to hold the setup checklist or the
 *    starter band, and the column was nearly as tall as the top half. Centring
 *    inside a half is only distinguishable from pinning to the top while the
 *    content is much shorter than that half, so the maths put it flush against
 *    the top edge with the whole bottom half dead. That slot is now empty by
 *    decision (see the comment at the bottom of the JSX), the column is a
 *    heading plus a composer, and the half is comfortably taller than it.
 * 2. The reason it was introduced — the column sliding when the checklist was
 *    dismissed — is also gone, because there is nothing left to dismiss. It is
 *    here now for the position, not to stop a slide.
 *
 * The two halves are `basis-1/2` flex children of the scroller. The upper one
 * is `shrink-0` so it grows past its half when the container is shorter than
 * the content — a phone in landscape, or the on-screen keyboard halving the
 * viewport — and the lower one is plain `shrink` ballast that gives its space
 * back first. Once the ballast is gone the scroller scrolls, with nothing
 * unreachable above the column: the top margin is the auto one, and it
 * resolves to zero when free space is negative, so the column simply starts
 * at the top.
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
 * For EVERY workspace: an emoji or glyph burst when one was chosen, the chalk
 * initial tile otherwise (`IdentityConfetti` resolves the face the same way
 * `EntityAvatar` does). #7079 had gated letter-only workspaces out; Marko put
 * the press back for all of them on 2026-09-03.
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
  // Every workspace name is pressable, whatever it wears. #7079 gated the
  // burst on a chosen emoji/glyph so a letter-only project would not throw
  // its own initial; Marko reversed that on 2026-09-03 ("bring it back") —
  // the press is the payoff, and the chalk initial tile is that project's
  // face everywhere else in the app, so it is the right thing to throw.
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
        The upper half. `basis-1/2` of the scroller, `shrink-0` so it is never
        squashed below its content, and a flex column so the ask group can
        `mt-auto` itself to the bottom edge of THIS half — the page's midline.
        See the component header for why it is pinned there and not centred.
      */}
      <div className="flex shrink-0 basis-1/2 flex-col">
        {/*
          Left-aligned, one edge. Every block in this column — the heading and the
          composer card — starts at the same x, so the eye has a single rail to
          run down instead of a centred axis it has to re-find on every line.

          No `items-center` anywhere: each child is `w-full` and aligns itself.
          Centring a column whose children all span it does nothing except hide
          which rule is actually doing the work.

          `gap-10` separates the ask group from whatever a host puts beneath it.
          Nothing does today (see the comment below the group), so it currently
          has one child and does no work. Every gap inside the group is owned by
          the group.

          `mx-auto mt-auto` — horizontally centred, vertically pushed to the
          bottom of the upper half, so the composer ends on the page's midline.
          No bottom margin: the ballast half below is the only thing under it.

          `py-8`: the bottom half is breathing room between the composer and
          the midline, and the top half keeps the heading off the container's
          edge when the half is short and the auto margin has gone to zero.

          `shrink-0` so a short container scrolls the column rather than
          compressing it.
        */}
        <div className="mx-auto mt-auto flex w-full max-w-3xl shrink-0 flex-col gap-10 py-12 sm:px-4">
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
      {/* The lower half: empty ballast. `basis-1/2` so the upper half is a
          half and not the whole, and `shrink` (the default) so it is the first
          thing to give way when the viewport is shorter than the content. */}
      <div className="basis-1/2" aria-hidden />
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
