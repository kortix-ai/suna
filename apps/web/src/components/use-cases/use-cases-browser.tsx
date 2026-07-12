'use client';

import { useMemo, useState } from 'react';

import { UseCaseCard } from '@/components/use-cases/use-case-card';
import { EmptyState } from '@/features/layout/section/empty-state';
import type { Post } from '@/lib/blog';
import { cn } from '@/lib/utils';

const ALL = 'All';

/** Tag-filter bar + responsive grid of use-case cards. The archetype (first tag)
 * drives the filter; "All" shows everything. */
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
      <div className="mb-8 flex flex-wrap items-center gap-2">
        {filters.map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            onClick={() => setActive(tag)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
              active === tag
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
            )}
          >
            {tag}
            <span className="tabular-nums opacity-50">{count}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="No use cases yet"
          description="Case studies and use cases are on the way. Check back soon."
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((post) => (
            <UseCaseCard key={post.slug} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
