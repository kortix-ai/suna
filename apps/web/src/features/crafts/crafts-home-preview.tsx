'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { useCrafts, useProjectCrafts } from '@kortix/sdk/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { errorToast } from '@/components/ui/toast';
import { AddCraftModal } from './add-craft-modal';
import { CraftBuildCard, CraftCard } from './crafts-card';
import { CraftInstallModal } from './install-modal';

/**
 * The project-home crafts preview — the installable card grid, plus the dashed
 * "Grow your crafts" card and the "View all crafts" link. `glass` cards over
 * the wallpaper keep the row quiet. Five crafts + the build card fill a 3x2
 * grid.
 *
 * The label is "Install a craft", an instruction rather than an introduction:
 * this grid sits under the craft-run report, so by the time a reader reaches
 * it they have already met their crafts and the only open question is what
 * they can add. Cards already installed keep their green Installed pill.
 *
 * Renders nothing until the store has loaded. A skeleton grid directly under
 * the composer would draw the eye to furniture on the one screen whose job is
 * to get out of the way.
 *
 * Layout shares the composer card's box edge-for-edge: the hero container is
 * `max-w-[52rem]`, and both children here are `w-full` with no side insets —
 * the hero composer strips its shell's gutter and `max-w-210` cap via
 * `parentClassName` (see the call sites), so card and grid fill the same
 * 52rem box exactly. `mt-8` is the tighter sibling gap; the run report above
 * carries the `mt-10` that keeps clear air below the input.
 */
export function CraftsHomePreview({ projectId }: { projectId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const store = useCrafts();
  const installedQuery = useProjectCrafts(projectId);

  const crafts = useMemo(() => store.data?.crafts ?? [], [store.data]);
  const installedSlugs = useMemo(
    () => new Set((installedQuery.data?.crafts ?? []).map((entry) => entry.slug)),
    [installedQuery.data],
  );
  const open = crafts.find((craft) => craft.craft_id === openId) ?? null;
  const storeHref = `/projects/${projectId}/crafts`;

  // Nothing to install and nothing loaded — the panel would be a heading over
  // one dashed card. The store page is still one click away from the sidebar.
  if (crafts.length === 0) return null;

  return (
    <div data-crafts-preview className="mt-8 w-full space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Install a craft
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
        {crafts.slice(0, 5).map((craft) => (
          <CraftCard
            key={craft.craft_id}
            craft={craft}
            installed={installedSlugs.has(craft.slug)}
            onOpen={() => setOpenId(craft.craft_id)}
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
          projectId={projectId}
          installed={installedSlugs.has(open.slug)}
          installing={installedQuery.install.isPending}
          onInstall={async (craftId) => {
            try {
              const result = await installedQuery.install.mutateAsync(craftId);
              return result.session_id;
            } catch (error) {
              errorToast(
                error instanceof Error ? error.message : 'Could not start the install session',
              );
              return null;
            }
          }}
          open
          onOpenChange={(next) => {
            if (!next) setOpenId(null);
          }}
        />
      ) : null}
    </div>
  );
}
