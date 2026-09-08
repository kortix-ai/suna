'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Button } from '@/components/ui/marketing/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import { TemplateCard } from './template-card';
import { TemplateShell } from './template-shell';
import { type Template, countLabel, templateMatchesQuery } from './templates-catalog';

/**
 * The PUBLIC catalog — `/templates`.
 *
 * Identity and the way in live in the pinned rail (headline, description,
 * search, the sign-up action); the templates themselves fill the wide column.
 * A visitor arriving from search reads what this is without scrolling, and the
 * grid still gets the full width a card grid needs.
 *
 * The rows arrive from the server render, so the entire catalog is in the HTML
 * a crawler reads, and search filters what is already there — no fetch, no
 * loading state, no pagination. The curated catalog is small by construction,
 * and a round trip per keystroke would buy nothing while costing the instant
 * feel.
 *
 * Every card is a LINK to `/templates/<slug>`, never a button that opens the
 * install modal: installing needs a project, and a public visitor has none. The
 * detail page carries the install action.
 */
export function PublicTemplatesExplore({
  templates,
  headline,
  description,
}: {
  templates: Template[];
  /** The page's `h1`. Passed in so the metadata and the page cannot drift. */
  headline: string;
  description: string;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () => (query ? templates.filter((template) => templateMatchesQuery(template, query)) : templates),
    [templates, query],
  );

  return (
    <TemplateShell
      crumbs={[{ label: 'Templates' }]}
      sidebar={
        <>
          <div className="space-y-2">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              {headline}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
              {description}
            </p>
          </div>

          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              variant="popover"
              placeholder="Search templates"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <InputGroupSearchClear
              onClick={() => setQuery('')}
              className={cn(!query && 'pointer-events-none opacity-0')}
            />
          </InputGroupSearch>

          <Button asChild className="w-full">
            <Link href="/auth">Start free to install</Link>
          </Button>
        </>
      }
    >
      {/* The count doubles as the search result line, so a filtered grid never
          leaves the visitor guessing how much it narrowed. */}
      <p className="text-muted-foreground mb-4 text-sm tabular-nums">
        {countLabel(visible.length, 'template')}
        {query ? ` for “${query}”` : ''}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          title={query ? 'No template matches' : 'No templates published yet'}
          description={
            query
              ? 'Try a different word, or clear the search to see the whole catalog.'
              : 'The public catalog is curated. Check back soon.'
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {visible.map((template) => (
            <li key={template.slug}>
              <TemplateCard template={template} href={`/templates/${template.slug}`} />
            </li>
          ))}
        </ul>
      )}
    </TemplateShell>
  );
}
