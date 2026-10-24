'use client';

import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from 'react';

import { SessionWelcome } from '../../session/thread/session-welcome';
import { agentsInSpace, listSpaces } from '@kortix/sdk';
import { useProjectConfig, useProjectName } from '@kortix/sdk/react';

import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { agentHref } from '../../internal/lib/capability-tab-routes';
import { useActiveDomain } from '../../internal/stores/active-domain-store';
import { useUiLink } from '../../providers/ui-provider';
import {
  HOME_GREETINGS,
  HOME_GREETING_STORAGE_KEY,
  greetingIndexFor,
  spaceBefore,
} from './home-greeting';

// Lazy: keeps the space home's heavy embeds (App preview, Files viewer, the
// room panel) out of the project-home compile graph until a space is active.
// Dev-mode Turbopack compiles everything a route imports eagerly, and this
// component is reachable from the barrel that ~44 routes import.
const SpaceHome = lazy(() =>
  import('../space/space-home').then((m) => ({ default: m.SpaceHome })),
);

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
 * ## Where the column sits: dead centre
 *
 * `m-auto` on the column, in a scroller that is a flex column: centred on
 * both axes, the same distance from the top edge as from the bottom. #7103
 * had pinned the group to the page midline (composer's lower edge on the
 * half-way line, heading stacking up, the lower half empty ballast); Marko
 * saw it on dev and asked why it was "not dead center anymore" (2026-09-04).
 * With nothing under the composer any more the column is short, and a short
 * block reads as centred only when it IS centred — anchored to the midline
 * it sits visibly high. When the container is shorter than the column the
 * auto margins resolve to zero and the scroller scrolls from the top, so
 * nothing is ever unreachable.
 *
 * Shared by the project index page AND the instant session shell's empty
 * state, so a brand-new session opens onto the identical surface.
 */
export function ProjectHomeWelcomeBody({
  projectId,
  composer,
  sentTurn,
  onPickSuggestion,
}: {
  projectId: string;
  /** The composer input rendered in the hero position, directly under the heading. */
  composer?: ReactNode;
  /**
   * A message this column has just sent, standing IN PLACE OF the heading while
   * it is in flight.
   *
   * The heading asks what is next; once that is answered it is the wrong thing
   * for the column to still be saying, and the answer itself is the right one.
   * Swapping rather than stacking keeps the column roughly the same height, so
   * the composer does not slide down the page at the keypress.
   *
   * It is a SLOT rather than a second layout because the composer must keep its
   * exact position in this tree — see `ProjectHome` on the upload handles a
   * remount destroys.
   */
  sentTurn?: ReactNode;
  /** When provided, starter-prompt chips render directly below the composer. */
  onPickSuggestion?: (text: string) => void;
}) {
  // One source for the project name — see `useProjectName`'s doc comment.
  const name = useProjectName(projectId) ?? '';
  // The active space (the sidebar's Spaces selection). When one is chosen the
  // home is that space's home: the heading names the space, its description
  // reads as the space's brief, and the composer below already starts only this
  // space's agents.
  const [activeDomain] = useActiveDomain(projectId);
  const config = useProjectConfig(projectId);
  // Declared or only referenced by an agent; a stale selection (the space was
  // removed) is no space.
  const space = activeDomain
    ? listSpaces(config).find((candidate) => candidate.name === activeDomain)
    : undefined;
  const spaceLabel = space ? space.label || space.name : null;
  const spaceAgents = space ? agentsInSpace(space.name, config?.agents ?? []) : [];
  const Link = useUiLink();
  const tSpaces = useTranslations('spaces');
  // One word, not two. The name sits inside the sentence in `text-foreground`
  // while the rest is muted, so the fallback has to read as a NAME in that
  // slot — "this project" is a description wearing a name's highlight, and it
  // stretches the line for a case where we know the least.
  const displayName = spaceLabel ?? (name.trim() || 'it');
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
        `m-auto` — centred on both axes (see the header). `py-8` is symmetric,
        so it cannot bias the centre; it is breathing room for a short
        container, where the auto margins have gone to zero. `shrink-0` so a
        short container scrolls the column rather than compressing it.
        `gap-10` separates the ask group from whatever a host puts beneath it.
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
          {spaceLabel && !sentTurn ? (
            <div className="flex items-center gap-2 px-4">
              <span className="bg-foreground size-1.5 rounded-full" aria-hidden />
              <span className="text-muted-foreground text-sm">
                In <span className="text-foreground font-medium">{spaceLabel}</span> space
              </span>
              {spaceAgents.length ? (
                <span role="group" className="ml-auto flex items-center gap-1" aria-label={tSpaces('agents')}>
                  {spaceAgents.map((name) => (
                    <Link
                      key={name}
                      href={agentHref(projectId, name)}
                      className="rounded-sm"
                      aria-label={tSpaces('openAgent', { name })}
                    >
                      <AgentMark slug={name} />
                    </Link>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
          <h1
            className="text-muted-foreground w-full px-4 text-2xl tracking-tight text-balance"
            hidden={!!sentTurn}
          >
            {greeting.before}{' '}
            <span className="text-foreground">{displayName}</span>
            {spaceBefore(greeting.after) ? ' ' : ''}
            {greeting.after}
          </h1>
          {space?.description && !sentTurn ? (
            <p className="text-muted-foreground w-full px-4 text-sm text-pretty">
              {space.description}
            </p>
          ) : null}

          {/* The sent message takes the heading's slot — same column, same rail,
              so the bubble the instant shell paints a moment later is already
              the width it will be there. */}
          {sentTurn ? <div className="w-full px-4">{sentTurn}</div> : null}

          {composer ? <div className="flex w-full flex-col gap-4">{composer}</div> : null}

          {/* A space's home is a channel: its room beside what is bound to
              it, then the blocks it declares. Without a space the home keeps
              its plain composer-only column. */}
          {space && !sentTurn ? (
            <Suspense fallback={null}>
              <SpaceHome projectId={projectId} space={space} />
            </Suspense>
          ) : null}
        </div>

        {/* Nothing under the composer unless a space is active (Marko,
            2026-09-02: "just have the chat input there & that's it"). An
            active space renders its home there: its room, what is bound to
            it, its blocks. The setup steps stay reachable from Customize. */}
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
