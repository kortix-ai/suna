'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { AddCraftModal } from './add-craft-modal';
import { CraftBuildCard, CraftCard } from './crafts-card';
import { CRAFTS } from './crafts-catalog';
import { CraftInstallModal } from './install-modal';

/**
 * The project-home crafts preview — the card grid under the composer, plus
 * the dashed "Grow your crafts" card and the "View all crafts" link. `glass`
 * cards over the wallpaper keep the row quiet. Five crafts + the build card
 * fill a 3x2 grid.
 *
 * Layout shares the composer card's box edge-for-edge: the hero container is
 * `max-w-[52rem]`, and both children here are `w-full` with no side insets —
 * the hero composer strips its shell's gutter and `max-w-210` cap via
 * `parentClassName` (see the call sites), so card and grid fill the same
 * 52rem box exactly. `mt-10` on top of the parent's `space-y-4` keeps clear
 * air below the input.
 */
export function CraftsHomePreview({ projectId }: { projectId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const open = CRAFTS.find((craft) => craft.id === openId) ?? null;
  const storeHref = `/projects/${projectId}/crafts`;

  return (
    <div data-crafts-preview className="mt-10 w-full space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Meet your crafts
        </p>
        <HoverPrefetchLink
          href={storeHref}
          className="group text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors duration-150"
        >
          View all crafts
          <ArrowRightIcon
            className="size-3 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
        </HoverPrefetchLink>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {CRAFTS.slice(0, 5).map((craft) => (
          <CraftCard
            key={craft.id}
            craft={craft}
            onOpen={() => setOpenId(craft.id)}
            glass
            compact
          />
        ))}
        {/* The add affordance, not a browse link — "View all crafts" above
            already goes to the store. */}
        <CraftBuildCard glass onClick={() => setAdding(true)} />
      </div>

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
