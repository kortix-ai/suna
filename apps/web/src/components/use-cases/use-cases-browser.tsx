'use client';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { localizeUiCatalog } from '@kortix/ui/i18n';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  TAG_TO_TEAM,
  TEAMS,
  type TeamId,
} from '@/features/marketing/landing-sections/use-case-teams';
import type { Post } from '@/lib/blog';
import { cn } from '@kortix/ui';
import { UseCaseCover } from './use-case-card';
import { EmptyState } from '@kortix/ui/empty-state';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';

type Filter = TeamId | 'all' | 'other';

/** Three use cases a first-time reader should open, one per kind of team. */
const START_HERE = ['ar-chaser', 'error-triage', 'churn-risk'];

const sourceOTHER = { id: 'other' as const, label: 'More' };

function teamOf(post: Post): TeamId | 'other' {
  return TAG_TO_TEAM[post.data.tags[0] ?? ''] ?? 'other';
}

function labelOf(
  team: TeamId | 'other',
  tMarketing: import('@/i18n/translator').UiTranslator,
): string {
  const { OTHER } = localizeUiCatalog(
    { OTHER: sourceOTHER },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
  return team === 'other' ? OTHER.label : (TEAMS.find((t) => t.id === team)?.label ?? OTHER.label);
}

/**
 * One use case as a blog-style card (as on /blog): a wide cover, then team,
 * the title and two lines of description. The whole card is the link.
 */
function UseCaseTile({ post }: { post: Post }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Link
      href={post.url}
      className="group outline-ring flex h-full flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
    >
      <UseCaseCover post={post} className="aspect-video w-full shrink-0" />
      <span className="text-muted-foreground mt-5 text-xs">{labelOf(teamOf(post), tMarketing)}</span>
      <h3 className="text-foreground group-hover:text-muted-foreground duration-normal mt-2 text-base font-medium text-pretty transition-colors ease-out">
        {post.data.title}
      </h3>
      {post.data.description ? (
        <p className="text-muted-foreground mt-2 line-clamp-2 text-sm text-pretty">
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
  return (
    <ul className={cn('grid grid-cols-1 gap-x-6 gap-y-16', cols)}>
      {posts.map((post) => (
        <li key={post.slug}>
          <UseCaseTile post={post} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The use-case catalog as a marketplace: filters on the left (search, then
 * every team with its count), the results on the right. With no filter the
 * right side opens with three picks, then every use case grouped by team.
 */
export function UseCasesBrowser({ posts }: { posts: Post[] }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');
  const { OTHER } = localizeUiCatalog(
    { OTHER: sourceOTHER },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );

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
          <MagnifyingGlassIcon weight="fill" className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tMarketing('textb84315d486a8')}
            aria-label={tMarketing('textb84315d486a8')}
            className="placeholder:text-muted-foreground w-full bg-transparent text-sm outline-none"
          />
        </label>
        <p className="text-muted-foreground mt-8 px-3 text-xs">{tMarketing('text5985039f106d')}</p>
        <ul className="mt-2 flex flex-col" aria-label={tMarketing('text29ec8e9091cf')}>
          {filterButton('all', tMarketing('texta6a0a46ebeee'), posts.length)}
          {teams.map((t) => filterButton(t.id, t.label, counts.get(t.id) ?? 0))}
        </ul>
      </aside>

      <div className="min-w-0">
        {browsing ? (
          <div className="flex flex-col gap-16">
            <section aria-labelledby="start-here">
              <h2 id="start-here" className="text-foreground text-lg font-medium tracking-tight">
                {tMarketing('text2adc964c0847')}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">{tMarketing('textdc8df43d2f44')}</p>
              <div className="mt-6">
                <TileGrid posts={starters} cols="sm:grid-cols-2 xl:grid-cols-3" />
              </div>
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
              {visible.length} {tMarketing('texta3b142af6e97')}
              {visible.length === 1 ? 'case' : 'cases'}
              {filter !== 'all' ? ` in ${labelOf(filter, tMarketing)}` : ''}
            </p>
            <div className="mt-6">
              <TileGrid posts={visible} />
            </div>
          </section>
        ) : (
          <EmptyState
            title={tMarketing('texta43f1924db10')}
            description={tMarketing('text9f4a8be5c188')}
          />
        )}
      </div>
    </div>
  );
}
