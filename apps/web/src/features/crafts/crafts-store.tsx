'use client';

import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import { AddCraftModal } from './add-craft-modal';
import { CraftBuildCard, CraftCard } from './crafts-card';
import { CRAFTS, craftRepoSlug } from './crafts-catalog';
import { CraftInstallModal } from './install-modal';

/**
 * The project-scoped crafts store (`/projects/[id]/crafts`) — search, one
 * flat grid, and the dashed "Grow your crafts" card. UI phase: data is the
 * static `CRAFTS` catalog; Install is a toast. The `projectId` scopes the
 * store to one project — the real install flow will target it in the
 * functionality phase.
 */
export function CraftsStore({ projectId }: { projectId: string }) {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const open = CRAFTS.find((craft) => craft.id === openId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CRAFTS;
    return CRAFTS.filter(
      (craft) =>
        craft.title.toLowerCase().includes(q) ||
        craft.description.toLowerCase().includes(q) ||
        craftRepoSlug(craft).toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div data-crafts-store className="mx-auto w-full max-w-6xl space-y-8 px-4 pt-8 pb-16 sm:px-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">Crafts</h1>
          <p className="text-muted-foreground text-sm text-balance">
            Open-source crafts you can install into this project — pick one, install it, review
            what it delivers.
          </p>
        </div>
        <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
          {filtered.length} of {CRAFTS.length} crafts
        </p>
      </header>

      <div className="space-y-4">
        <InputGroupSearch className="sm:max-w-xs">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            variant="popover"
            placeholder="Search crafts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupSearchClear
            onClick={() => setQuery('')}
            className={cn(!query && 'pointer-events-none opacity-0')}
          />
        </InputGroupSearch>

        {filtered.length === 0 ? (
          <div className="bg-popover flex flex-col items-center rounded-md border px-4 py-10 text-center">
            <p className="text-foreground text-sm font-medium">No crafts match</p>
            <p className="text-muted-foreground mt-1 text-xs">Clear the search to see all crafts.</p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((craft) => (
              <li key={craft.id}>
                <CraftCard craft={craft} onOpen={() => setOpenId(craft.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-foreground text-sm font-medium">Make your own</h2>
        <CraftBuildCard onClick={() => setAdding(true)} />
      </section>

      <AddCraftModal open={adding} onOpenChange={setAdding} />

      {open ? (
        <CraftInstallModal
          craft={open}
          open
          onOpenChange={(next) => {
            if (!next) setOpenId(null);
          }}
        />
      ) : null}
    </div>
  );
}
