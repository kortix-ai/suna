'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useMemo, useState, type ReactNode } from 'react';

import { UseCaseCard, UseCaseFeatured } from '@/components/use-cases/use-case-card';
import { EmptyState } from '@/features/layout/section/empty-state';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

const ALL = 'All';

/**
 * The use-case catalog in the /blog layout (after Polar's blog): the page
 * title, the archetype filter as one row of plain text buttons, the first
 * visible use case as the lead, a hairline, then the rest in a three-column
 * grid.
 */
export function UseCasesBrowser({ posts, title }: { posts: Post[]; title: ReactNode }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const allLabel = tI18nComplete.raw('texta52ace420f21');
  const tags = useMemo(
    () => [ALL, ...new Set(posts.map((post) => post.data.tags[0]).filter(Boolean))],
    [posts],
  );

  const [active, setActive] = useState(ALL);
  const visible = active === ALL ? posts : posts.filter((post) => post.data.tags[0] === active);
  const [lead, ...rest] = visible;

  return (
    <div>
      {title}
      <div
        className="mt-10 flex flex-wrap gap-x-6"
        role="group"
        aria-label={tI18nComplete.raw('text56b46fc5bc85')}
      >
        {tags.map((tag) => {
          const isActive = active === tag;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActive(tag)}
              className={cn(
                'outline-ring flex min-h-11 items-center rounded-sm text-left text-sm focus-visible:outline-2 lg:min-h-9',
                'duration-moderate transition-colors',
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tag === ALL ? allLabel : tag}
            </button>
          );
        })}
      </div>

      {lead ? (
        <>
          <div className="mt-16 lg:mt-24">
            <UseCaseFeatured post={lead} />
          </div>
          {rest.length > 0 ? (
            <ul className="mt-16 grid grid-cols-1 gap-x-6 gap-y-16 border-t pt-16 sm:grid-cols-2 lg:mt-24 lg:grid-cols-3 lg:pt-24">
              {rest.map((post) => (
                <li key={post.slug}>
                  <UseCaseCard post={post} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="mt-16">
          <EmptyState
            title={tI18nComplete.raw('text40db06073883')}
            description={tI18nComplete.raw('text18d7a47acb40')}
          />
        </div>
      )}
    </div>
  );
}
