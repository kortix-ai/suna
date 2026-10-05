'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

export type TocItem = { title: ReactNode; url: string; depth: number };

/** "On this page" — the article's headings, with the current section highlighted
 * as you scroll. Ids come from the MDX headings (fumadocs slugs). */
export function UseCaseToc({ items }: { items: TocItem[] }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [active, setActive] = useState('');

  useEffect(() => {
    const ids: string[] = [];
    for (const item of items) {
      const id = item.url.replace(/^#/, '');
      if (id) ids.push(id);
    }
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
    <nav aria-label={tI18nComplete.raw('textb5658fc8edda')}>
      <p className="text-foreground mb-3 text-sm font-medium">
        {tI18nComplete.raw('textb5658fc8edda')}
      </p>
      <ul className="border-border space-y-1 border-l">
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
                    : 'text-muted-foreground hover:text-foreground border-transparent',
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
