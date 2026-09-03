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
import { SubprojectCard } from './subprojects-card';
import { countLabel, subprojectMatchesQuery, type Subproject } from './subprojects-catalog';

/**
 * The PUBLIC catalogue grid — `/marketplace`.
 *
 * The rows arrive from the server render, so the whole grid is in the HTML a
 * crawler reads and the search filters what is already there. No fetch, no
 * loading state, no pagination: the curated catalogue is small by construction
 * (`loadPublicSubprojects` asks for at most 100).
 *
 * Every card is a LINK to `/marketplace/<slug>`, never a button that opens the
 * install modal. Installing needs a project, and a public visitor has none — so
 * `installed` is left at its default `false` and the detail page carries the
 * sign-up CTA instead. This surface must never claim a subproject is installed.
 */
export function PublicSubprojectsGrid({ subprojects }: { subprojects: Subproject[] }) {
  const [query, setQuery] = useState('');
  const visible = query
    ? subprojects.filter((subproject) => subprojectMatchesQuery(subproject, query))
    : subprojects;

  return (
    <div>
      <div className="border-border/60 mb-8 flex flex-wrap items-center justify-between gap-3 border-b pb-6 sm:mb-10">
        <InputGroupSearch className="w-full sm:max-w-xs">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            variant="popover"
            placeholder="Search subprojects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupSearchClear
            onClick={() => setQuery('')}
            className={cn(!query && 'pointer-events-none opacity-0')}
          />
        </InputGroupSearch>
        <span className="text-muted-foreground text-xs tabular-nums">
          {countLabel(visible.length, 'subproject')}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title={query ? 'No subproject matches' : 'No subprojects published yet'}
          description={
            query
              ? 'Try a different word, or clear the search to see the whole catalogue.'
              : 'The public catalogue is curated. Check back soon.'
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((subproject) => (
            <li key={subproject.subproject_id}>
              <SubprojectCard subproject={subproject} href={`/marketplace/${subproject.slug}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
