'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  TAG_TO_TEAM,
  TEAMS,
  type TeamId,
} from '@/features/marketing/landing-sections/use-case-teams';
import type { Post } from '@/lib/blog';
import { cn } from '@kortix/ui';
import { EmptyState } from '@kortix/ui/empty-state';
import { ArrowRightIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';

type Filter = TeamId | 'all' | 'other';

/** Four use cases a first-time reader should open, one per kind of team. */
const START_HERE = ['ar-chaser', 'error-triage', 'churn-risk', 'contract-review'];

const OTHER = { id: 'other' as const, label: 'More' };

function teamOf(post: Post): TeamId | 'other' {
  return TAG_TO_TEAM[post.data.tags[0] ?? ''] ?? 'other';
}

function labelOf(team: TeamId | 'other'): string {
  return team === 'other' ? OTHER.label : (TEAMS.find((t) => t.id === team)?.label ?? OTHER.label);
}

/** One use case as a text card: team, the title, two lines of description. */
function UseCaseTile({ post }: { post: Post }) {
  return (
    <Link
      href={post.url}
      className="group bg-background outline-ring flex h-full flex-col gap-3 p-6 focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      <span className="text-muted-foreground text-xs">{labelOf(teamOf(post))}</span>
      <h3 className="text-foreground group-hover:text-muted-foreground duration-normal text-base font-medium text-pretty transition-colors ease-out">
        {post.data.title}
      </h3>
      {post.data.description ? (
        <p className="text-muted-foreground line-clamp-2 text-sm text-pretty">
          {post.data.description}
        </p>
      ) : null}
    </Link>
  );
}

function TileGrid({
  posts,
  cols = 'sm:grid-cols-2 xl:grid-cols-3',
}: {
  posts: Post[];
  cols?: string;
}) {
  // Hairlines per card (top and left on the grid, right and bottom on each
  // card), so a short last row leaves blank space instead of a grey block.
  return (
    <ul className={cn('grid grid-cols-1 border-t border-l', cols)}>
      {posts.map((post) => (
        <li key={post.slug} className="border-r border-b">
          <UseCaseTile post={post} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The use-case catalog as a marketplace: filters on the left (search, then
 * every team with its count), the results on the right. With no filter the
 * right side opens with four picks, then a tile per team, then every use case
 * grouped by team.
 */
export function UseCasesBrowser({ posts }: { posts: Post[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const map = new Map<TeamId | 'other', number>();
    for (const post of posts) map.set(teamOf(post), (map.get(teamOf(post)) ?? 0) + 1);
    return map;
  }, [posts]);
  const teams = useMemo(
    () => [
      ...TEAMS.filter((t) => counts.get(t.id)).map((t) => ({ id: t.id, label: t.label })),
      ...(counts.get('other') ? [OTHER] : []),
    ],
    [counts],
  );

  const q = query.trim().toLowerCase();
  const visible = posts.filter(
    (post) =>
      (filter === 'all' || teamOf(post) === filter) &&
      (!q ||
        `${post.data.title} ${post.data.description ?? ''} ${post.data.tags.join(' ')}`
          .toLowerCase()
          .includes(q)),
  );
  const browsing = filter === 'all' && !q;
  const starters = START_HERE.map((slug) => posts.find((p) => p.slug === slug)).filter(
    (p): p is Post => !!p,
  );

  const filterButton = (id: Filter, label: string, count: number) => (
    <li key={id}>
      <button
        type="button"
        aria-pressed={filter === id}
        onClick={() => setFilter(id)}
        className={cn(
          'outline-ring duration-normal flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ease-out focus-visible:outline-2',
          filter === id
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {label}
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </button>
    </li>
  );

  return (
    <div className="grid grid-cols-1 gap-10 lg:grid-cols-[15rem_1fr] lg:gap-12">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <label className="bg-background focus-within:outline-ring flex items-center gap-2 rounded-md border px-3 py-2 focus-within:outline-2">
          <MagnifyingGlassIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search use cases"
            aria-label="Search use cases"
            className="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
          />
        </label>
        <p className="text-muted-foreground mt-8 px-3 text-xs">Team</p>
        <ul className="mt-2 flex flex-col" aria-label="Filter by team">
          {filterButton('all', 'All use cases', posts.length)}
          {teams.map((t) => filterButton(t.id, t.label, counts.get(t.id) ?? 0))}
        </ul>
      </aside>

      <div className="min-w-0">
        {browsing ? (
          <div className="flex flex-col gap-16">
            <section aria-labelledby="start-here">
              <h2 id="start-here" className="text-foreground text-lg font-medium tracking-tight">
                Start here
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Four use cases that show what agents on Kortix do.
              </p>
              <div className="mt-6">
                <TileGrid posts={starters} cols="sm:grid-cols-2 xl:grid-cols-4" />
              </div>
            </section>

            <section aria-labelledby="by-team">
              <h2 id="by-team" className="text-foreground text-lg font-medium tracking-tight">
                Browse by team
              </h2>
              <ul className="mt-6 grid grid-cols-2 border-t border-l sm:grid-cols-3 xl:grid-cols-4">
                {teams.map((t) => (
                  <li key={t.id} className="border-r border-b">
                    <button
                      type="button"
                      onClick={() => setFilter(t.id)}
                      className="group bg-background outline-ring flex w-full flex-col gap-1 p-5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2"
                    >
                      <span className="text-foreground group-hover:text-muted-foreground duration-normal flex items-center gap-1.5 text-sm font-medium transition-colors ease-out">
                        {t.label}
                        <ArrowRightIcon className="size-3.5" aria-hidden />
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {counts.get(t.id)} use {counts.get(t.id) === 1 ? 'case' : 'cases'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {teams.map((t) => {
              const group = posts.filter((post) => teamOf(post) === t.id);
              return (
                <section key={t.id} aria-labelledby={`team-${t.id}`}>
                  <h2
                    id={`team-${t.id}`}
                    className="text-foreground text-lg font-medium tracking-tight"
                  >
                    {t.label}{' '}
                    <span className="text-muted-foreground tabular-nums">{group.length}</span>
                  </h2>
                  <div className="mt-6">
                    <TileGrid posts={group} />
                  </div>
                </section>
              );
            })}
          </div>
        ) : visible.length > 0 ? (
          <section aria-live="polite">
            <p className="text-muted-foreground text-sm tabular-nums">
              {visible.length} use {visible.length === 1 ? 'case' : 'cases'}
              {filter !== 'all' ? ` in ${labelOf(filter)}` : ''}
            </p>
            <div className="mt-6">
              <TileGrid posts={visible} />
            </div>
          </section>
        ) : (
          <EmptyState
            title="No use case matches"
            description="Try another word, or clear the team filter."
          />
        )}
      </div>
    </div>
  );
}
