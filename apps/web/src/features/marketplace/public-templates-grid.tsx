'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { EmptyState } from '@/features/layout/section/empty-state';
import { cn } from '@/lib/utils';
import { TemplateCard } from './template-card';
import { type MarketplaceTemplate, countLabel, templateMatchesQuery } from './templates-catalog';

/**
 * The PUBLIC catalog grid — `/marketplace`.
 *
 * The rows arrive from the server render, so the whole grid is in the HTML a
 * crawler reads and the search filters what is already there. No fetch, no
 * loading state, no pagination: the curated catalog is small by construction.
 *
 * Every card is a LINK to `/marketplace/<slug>`, never a button that opens the
 * install modal. Installing needs a project, and a public visitor has none —
 * the detail page carries the sign-up CTA instead.
 */
export function PublicTemplatesGrid({ templates }: { templates: MarketplaceTemplate[] }) {
  const [query, setQuery] = useState('');
  const visible = query
    ? templates.filter((template) => templateMatchesQuery(template, query))
    : templates;

  return (
    <div>
      <div className="border-border/60 mb-8 flex flex-wrap items-center justify-between gap-3 border-b pb-6 sm:mb-10">
        <InputGroupSearch className="w-full sm:max-w-xs">
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
        <span className="text-muted-foreground text-xs tabular-nums">
          {countLabel(visible.length, 'template')}
        </span>
      </div>

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
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((template) => (
            <li key={template.slug}>
              <TemplateCard template={template} href={`/marketplace/${template.slug}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
