'use client';

import { ArrowRightIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { useProjectSubprojects, useSubprojects } from '@kortix/sdk/react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { errorToast } from '@/components/ui/toast';
import { AuthorSubprojectModal } from './author-subproject-modal';
import { SubprojectInstallModal } from './install-modal';
import { subprojectsHref } from './subproject-runs';
import { SubprojectBuildCard, SubprojectCard } from './subprojects-card';

/**
 * The project-home subprojects preview — the installable card grid, plus the dashed
 * "Grow your subprojects" card and the "View all subprojects" link. `glass` cards over
 * the wallpaper keep the row quiet. Five subprojects + the build card fill a 3x2
 * grid.
 *
 * The label is "Install a subproject", an instruction rather than an introduction:
 * this grid sits under the subproject-run report, so by the time a reader reaches
 * it they have already met their subprojects and the only open question is what
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
export function SubprojectsHomePreview({ projectId }: { projectId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const store = useSubprojects();
  const installedQuery = useProjectSubprojects(projectId);

  const subprojects = useMemo(() => store.data?.subprojects ?? [], [store.data]);
  const installedSlugs = useMemo(
    () => new Set((installedQuery.data?.subprojects ?? []).map((entry) => entry.slug)),
    [installedQuery.data],
  );
  const open = subprojects.find((subproject) => subproject.subproject_id === openId) ?? null;
  const storeHref = subprojectsHref(projectId);

  // Nothing to install and nothing loaded — the panel would be a heading over
  // one dashed card. The store is still reachable, at Customize → Marketplace.
  if (subprojects.length === 0) return null;

  return (
    <div data-subprojects-preview className="mt-8 w-full space-y-2.5">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Install a subproject
        </p>
        <HoverPrefetchLink
          href={storeHref}
          className="group text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors duration-150"
        >
          View all subprojects
          <ArrowRightIcon
            className="size-3 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden
          />
        </HoverPrefetchLink>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {subprojects.slice(0, 5).map((subproject) => (
          <SubprojectCard
            key={subproject.subproject_id}
            subproject={subproject}
            installed={installedSlugs.has(subproject.slug)}
            onOpen={() => setOpenId(subproject.subproject_id)}
            glass
            compact
          />
        ))}
        {/* Grow, not add: the home grid has room for one door, and describing
            a subproject is the one that needs no repo. "Add a subproject" lives in the
            store, which "View all subprojects" above already reaches. */}
        <SubprojectBuildCard glass onClick={() => setAuthoring(true)} />
      </div>

      <AuthorSubprojectModal projectId={projectId} open={authoring} onOpenChange={setAuthoring} />

      {open ? (
        <SubprojectInstallModal
          subproject={open}
          projectId={projectId}
          installed={installedSlugs.has(open.slug)}
          installing={installedQuery.install.isPending}
          onInstall={async (subprojectId) => {
            try {
              const result = await installedQuery.install.mutateAsync(subprojectId);
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
