'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { SessionWelcome } from '@/features/session/session-welcome';
import { useProjectName } from '@kortix/sdk/react';
import { ProjectHomeSections } from './project-home-sections';
import { StarterPromptChips } from './starter-prompt-chips';

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
 * The trade this makes, deliberately: the composer's vertical position now
 * depends on whether the checklist is present. That is why the checklist
 * animates its height in and out rather than appearing — see
 * `ProjectSetupChecklist`.
 *
 * Shared by the project index page AND the instant session shell's empty
 * state, so a brand-new session opens onto the identical surface.
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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // One source for the project name — see `useProjectName`'s doc comment.
  const name = useProjectName(projectId) ?? '';
  // One word, not two. The name sits inside the sentence in `text-foreground`
  // while the rest is muted, so the fallback has to read as a NAME in that
  // slot — "this project" is a description wearing a name's highlight, and it
  // stretches the line for a case where we know the least.
  const displayName = name.trim() || 'it';

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
      */}
      <div className="m-auto flex w-full max-w-3xl flex-col gap-10 px-2 py-8 sm:px-4">
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
          <h1 className="text-muted-foreground w-full px-4 text-3xl leading-[1.2] tracking-tight text-pretty max-sm:text-2xl">
            Give <span className="text-foreground">{displayName}</span>{' '}
            {tI18nHardcoded.raw(
              'autoFeaturesCoWorkerProjectLayoutProjectHomeJsxTextSomething18ab9904',
            )}
          </h1>

          {composer || onPickSuggestion ? (
            <div className="flex w-full flex-col gap-4">
              {composer}
              {/*{onPickSuggestion ? <StarterPromptChips onPick={onPickSuggestion} /> : null}*/}
            </div>
          ) : null}
        </div>

        <ProjectHomeSections projectId={projectId} />
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
