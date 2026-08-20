'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/marketing/button';
import { UseCaseCard } from '@/components/use-cases/use-case-card';
import { EmptyState } from '@/features/layout/section/empty-state';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

const ALL = 'All';

/**
 * Archetype filter + the use-case catalog grid.
 *
 * The count renders on every chip, not just the active one — showing it
 * conditionally changes a chip's width on click, which reflows the whole row
 * under the cursor.
 */
export function UseCasesBrowser({ posts }: { posts: Post[] }) {
  const filters = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of posts) {
      const tag = post.data.tags[0];
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [
      { tag: ALL, count: posts.length },
      ...[...counts.entries()].map(([tag, count]) => ({ tag, count })),
    ];
  }, [posts]);

  const [active, setActive] = useState(ALL);
  const visible = active === ALL ? posts : posts.filter((post) => post.data.tags[0] === active);

  return (
    <div>
      <div
        className="border-border/60 mb-10 flex flex-wrap items-center gap-1.5 border-b pb-6 sm:mb-12"
        role="group"
        aria-label="Filter use cases by type"
      >
        {filters.map(({ tag, count }) => {
          const isActive = active === tag;
          return (
            <Button
              key={tag}
              type="button"
              size="sm"
              variant={isActive ? 'secondary' : 'ghost'}
              aria-pressed={isActive}
              className="rounded-full border capitalize shadow-none"
              onClick={() => setActive(tag)}
            >
              {tag}
              {isActive && <span className={cn('tabular-nums')}>{count}</span>}
            </Button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No use cases yet"
          description="Case studies and use cases are on the way. Check back soon."
        />
      ) : (
        // No card borders: whitespace separates the cells, so the vertical gap
        // is deliberately larger than the horizontal one.
        <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-3">
          {visible.map((post) => (
            <UseCaseCard key={post.slug} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
