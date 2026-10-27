'use client';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import Link from '@/components/site-link';
import { DitherField } from '@/features/marketing/kit/dither-field';
import { useLocalizedUiCatalog } from '@kortix/ui/i18n';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { cn } from '@kortix/ui';
import { m, useReducedMotion, type Transition } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { TEAMS, type TeamId } from './use-case-teams';

/** One library use case, as the server hands it over. */
export type UseCaseItem = { slug: string; url: string; title: string; team: TeamId };

/**
 * Use cases (Paper "Kortix 2", E3Y-0, in the page theme): a ruler of teams, then the
 * team's promise on the left and one finished exchange on the right — what you
 * asked, and what Kortix came back with on which model.
 *
 * Every team that has a use case in the library (content/use-cases) gets a
 * column on the ruler. Under each team's promise, its real use cases — the
 * titles — link through to the write-ups.
 */

const COPY = {
  eyebrow: 'Outcomes',
  title: 'What Kortix delivers,',
  titleMuted: 'end to end, for every team.',
  you: 'You',
};

/** Teams the ruler shows at once: seven from lg, three on narrow screens. */
const VISIBLE_LG = 7;
const VISIBLE_SM = 3;
/** Ticks across the whole rule, rail to rail (about the board's 9px pitch). */
const TICKS = 140;

/**
 * Ticks are drawn 32px tall. Like the chat minimap's dashes, the focus (the
 * hovered tick, else the selected one) stands tallest and its nearest
 * neighbours step down to the resting rule, the same on both sides:
 *   focus 32px · next 20px (rest +25%) · one further 17.6px (rest +10%) · rest 16px.
 * Brightness keeps the minimap's falloff, dimming geometrically to a floor.
 */
const REST_SCALE = 0.5; // 16px of 32
const NEIGHBOUR_LIFT = [1.25, 1.1]; // distance 1, distance 2, × the rest height
function tickScale(distance: number): number {
  if (distance === 0) return 1;
  return REST_SCALE * (NEIGHBOUR_LIFT[distance - 1] ?? 1);
}
function tickOpacity(distance: number): number {
  if (distance <= 0) return 1;
  return Math.max(0.16, 0.7 * 0.86 ** distance);
}

/** Titles listed under a team before "See all". */
const LISTED = 4;

const SLIDE: Transition = { duration: 0.32, ease: [0.77, 0, 0.175, 1] };

/** "How we chase down overdue invoices" → "Chase down overdue invoices". */
function shortTitle(title: string): string {
  const s = title.replace(/^How we\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function UseCasesSection({ items, linkable }: { items: UseCaseItem[]; linkable: boolean }) {
  const copy = useLocalizedUiCatalog(COPY);
  const allTeams = useLocalizedUiCatalog(TEAMS);
  const reduced = useReducedMotion();

  // A team with nothing in the library has nothing to show.
  const teams = allTeams.filter((t) => items.some((item) => item.team === t.id));
  const [selected, setSelected] = useState(() =>
    Math.max(0, teams.findIndex((t) => t.id === 'engineering')),
  );
  /** Pointer position along the rule, 0–1; null when the pointer is away. */
  const [pointer, setPointer] = useState<number | null>(null);
  // Under review: how the team's use cases are listed. `?uc=list|columns|none`
  // (default `list`). Delete the losers once one is chosen.
  const [linksVariant, setLinksVariant] = useState<LinksVariant>('list');
  useEffect(() => {
    const uc = new URLSearchParams(window.location.search).get('uc');
    if (uc === 'list' || uc === 'columns' || uc === 'none') setLinksVariant(uc);
  }, []);

  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const isLg = useIsLg();

  if (teams.length === 0) return null;
  const team = teams[Math.min(selected, teams.length - 1)];
  const teamItems = items.filter((item) => item.team === team.id);
  // The window of seven keeps the selected team as close to the middle as the
  // ends of the list allow; it slides when the selection moves.
  const shown = Math.min(isLg ? VISIBLE_LG : VISIBLE_SM, teams.length);
  const start = Math.max(0, Math.min(selected - Math.floor(shown / 2), teams.length - shown));
  /** Centre of the selected team's column, as a fraction of the rule. */
  const selectedAt = (selected - start + 0.5) / shown;
  // Idle, the glow sits under the selection; under the pointer it follows it.
  const focusAt = pointer ?? selectedAt;
  const focusTick = Math.round(focusAt * (TICKS - 1));
  const hoveredColumn = pointer === null ? null : start + Math.min(shown - 1, Math.floor(pointer * shown));

  const fractionOf = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  };

  const select = (i: number, focus = false) => {
    const to = (i + teams.length) % teams.length;
    setSelected(to);
    if (focus) tabRefs.current[to]?.focus();
  };

  // Arrow keys move along the ruler (WAI-ARIA tabs), so the row is one stop.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowLeft: selected - 1,
      Home: 0,
      End: teams.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    select(moves[event.key], true);
  };

  return (
    <section id="use-cases" className="bg-background text-foreground relative z-20 border-y py-12 lg:py-16">
      {/* The page rails, redrawn above this band's background. */}
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 left-4 w-px lg:left-17" />
      <div aria-hidden className="bg-border pointer-events-none absolute inset-y-0 right-4 w-px lg:right-17" />

      <div className="flex flex-col items-center gap-5 px-8 pb-14 text-center">
        <p className="bg-foreground/8 text-foreground w-fit rounded-sm px-2 py-1 font-mono text-xs font-medium uppercase">
          {copy.eyebrow}
        </p>
        <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
          {copy.title}
          <span className="text-muted-foreground block">{copy.titleMuted}</span>
        </h2>
      </div>

      {/* The ruler runs rail to rail. Seven team names sit over one
          continuous rule; the window of names slides with the selection. The
          rule glows around the focus like the session minimap, and any point
          on it — name or ticks — selects the team in that column. */}
      <div className="kx-rail-fade border-b px-4 pb-9 lg:px-17">
        <div
          onPointerMove={(event) => setPointer(fractionOf(event))}
          onPointerLeave={() => setPointer(null)}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('[role="tab"]')) return;
            select(start + Math.min(shown - 1, Math.floor(fractionOf(event) * shown)));
          }}
          className="hit-area-y-2 relative cursor-pointer"
        >
          <div className="overflow-hidden">
            <m.div
              initial={false}
              animate={{ x: `${-(start / teams.length) * 100}%` }}
              transition={reduced ? { duration: 0 } : SLIDE}
              style={{ width: `${(teams.length / shown) * 100}%` }}
            >
              <div
                role="tablist"
                aria-label={copy.eyebrow}
                onKeyDown={onKeyDown}
                className="grid"
                style={{ gridTemplateColumns: `repeat(${teams.length}, minmax(0, 1fr))` }}
              >
                {teams.map((t, i) => {
                  const lit = i === (hoveredColumn ?? selected);
                  return (
                    <button
                      key={t.id}
                      ref={(node) => {
                        tabRefs.current[i] = node;
                      }}
                      type="button"
                      role="tab"
                      id={`use-case-tab-${t.id}`}
                      aria-selected={i === selected}
                      aria-controls="use-case-panel"
                      tabIndex={i === selected ? 0 : -1}
                      onClick={() => select(i)}
                      className={cn(
                        'outline-ring cursor-pointer truncate rounded-sm px-2 py-1 text-sm transition-colors duration-moderate focus-visible:outline-2',
                        lit ? 'text-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </m.div>
          </div>

          <div aria-hidden className="mt-5 flex h-8 items-end justify-between">
            {Array.from({ length: TICKS }, (_, i) => {
              const distance = Math.abs(i - focusTick);
              return (
                <span
                  key={i}
                  style={{
                    opacity: tickOpacity(distance),
                    transform: `scaleY(${tickScale(distance)})`,
                  }}
                  className={cn(
                    'h-8 w-px origin-bottom transition-[opacity,transform] duration-fast ease-out motion-reduce:transition-[opacity]',
                    distance === 0 ? 'bg-foreground' : 'bg-muted-foreground',
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div
        role="tabpanel"
        id="use-case-panel"
        aria-labelledby={`use-case-tab-${team.id}`}
        className="grid grid-cols-1 gap-10 px-8 pt-8 lg:grid-cols-2 lg:gap-16 lg:px-28"
      >
        <div className="relative py-2">
          {/* The copy swaps in place when the team changes: no fade, slide
              or blur, so the headline reads at once. */}
          <div className="flex h-full flex-col justify-between gap-8">
              <div className="flex flex-col gap-4">
                <h3 className="text-foreground text-2xl font-medium tracking-tight text-balance lg:text-3xl">
                  {team.headline}
                </h3>
                <p className="text-muted-foreground max-w-md text-base leading-relaxed">{team.body}</p>
              </div>

              {/* The team's real use cases, from the library. Never chips or
                  pills: plain text links. */}
              <div className="flex max-w-md flex-col items-start gap-5">
                <UseCaseLinks items={teamItems.slice(0, LISTED)} linkable={linkable} variant={linksVariant} />
              </div>
          </div>
        </div>

        {/* One finished exchange on a dithered field: what you asked, and
            what Kortix came back with on which model. */}
        <div className="border-border bg-card relative flex h-96 items-center justify-center self-start overflow-hidden border p-6 sm:p-10">
          <div aria-hidden className="text-foreground pointer-events-none absolute inset-0 opacity-40">
            <DitherField />
          </div>
          {/* Static on purpose: switching team swaps the text in place, with
              no enter or exit motion. */}
          <div className="relative flex w-full max-w-md flex-col gap-3">
            <div className="bg-background/95 border-border rounded-md border px-5 py-4">
              <p className="text-foreground text-sm font-medium">{copy.you}</p>
              <p className="text-muted-foreground mt-1 text-base leading-snug text-pretty">{team.prompt}</p>
            </div>
            <div className="bg-background/95 border-border flex items-center gap-4 rounded-md border px-5 py-4">
              <span className="bg-foreground text-background flex size-10 shrink-0 items-center justify-center rounded-md">
                <KortixLogo size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-base font-medium">{team.result}</span>
                <span className="text-muted-foreground mt-0.5 block truncate text-sm">{team.detail}</span>
              </span>
              <span className="bg-foreground/8 text-foreground shrink-0 rounded-sm px-2 py-1 font-mono text-xs font-medium uppercase">
                {team.model}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

type LinksVariant = 'list' | 'columns' | 'none';

/**
 * The team's use cases as plain text links.
 *  - list: rows with hairlines between them only (none above the first or
 *    below the last), the title left and an arrow right (Buio's menu rows).
 *  - columns: two columns of bare links, no rules.
 *  - none: nothing; only the "All use cases" link under it.
 */
function UseCaseLinks({
  items,
  linkable,
  variant,
}: {
  items: { slug: string; title: string; url: string }[];
  linkable: boolean;
  variant: LinksVariant;
}) {
  if (variant === 'none' || items.length === 0) return null;
  const label = (item: { title: string }) => shortTitle(item.title);

  if (variant === 'columns') {
    return (
      <ul className="grid w-full grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.slug}>
            {linkable ? (
              <Link
                href={item.url}
                className="text-muted-foreground hover:text-foreground outline-ring rounded-sm text-sm transition-colors duration-moderate focus-visible:outline-2"
              >
                {label(item)}
              </Link>
            ) : (
              <span className="text-muted-foreground text-sm">{label(item)}</span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="w-full divide-y">
      {items.map((item) => (
        <li key={item.slug}>
          {linkable ? (
            <Link
              href={item.url}
              className="text-muted-foreground hover:text-foreground outline-ring group/row flex items-center justify-between gap-4 py-3 text-sm transition-colors duration-moderate focus-visible:outline-2"
            >
              {label(item)}
              <ArrowUpRightIcon
                aria-hidden
                className="size-3.5 shrink-0 opacity-0 transition-opacity duration-moderate group-hover/row:opacity-100 group-focus-visible/row:opacity-100"
              />
            </Link>
          ) : (
            <span className="text-muted-foreground flex py-3 text-sm">{label(item)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** lg and up (1024px), tracked live so the ruler's window resizes with the page. */
function useIsLg(): boolean {
  const [isLg, setIsLg] = useState(true);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 64rem)');
    const sync = () => setIsLg(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return isLg;
}
