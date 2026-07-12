'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

export type TocItem = { title: ReactNode; url: string; depth: number };

/** "On this page" — the article's headings, with the current section highlighted
 * as you scroll. Ids come from the MDX headings (fumadocs slugs). */
export function UseCaseToc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState('');

  useEffect(() => {
    const ids = items.map((item) => item.url.replace(/^#/, '')).filter(Boolean);
    if (ids.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: '-88px 0px -70% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  if (!items || items.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <p className="text-foreground mb-3 text-sm font-medium">On this page</p>
      <ul className="space-y-1 border-l border-border">
        {items.map((item) => {
          const id = item.url.replace(/^#/, '');
          const isActive = active === id;
          return (
            <li key={item.url}>
              <a
                href={item.url}
                style={{ paddingLeft: `${Math.max(0, item.depth - 2) * 12 + 12}px` }}
                className={cn(
                  '-ml-px block border-l py-1 text-sm leading-snug transition-colors',
                  isActive
                    ? 'border-foreground text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {item.title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
