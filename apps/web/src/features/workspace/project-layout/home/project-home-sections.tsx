'use client';

import { useQuery } from '@tanstack/react-query';

import { useProjectCans } from '@/lib/use-project-can';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { ProjectSetupChecklist } from './setup-checklist';
import { PROJECT_SETUP_TILES, PROJECT_SETUP_TILE_ACTIONS, setupTileHref } from './setup-tiles';

/**
 * The IAM gate in front of the setup checklist. It answers one question —
 * which setup steps may this person even see — and hands the survivors to
 * `ProjectSetupChecklist`, which owns everything else.
 */
export function ProjectHomeSections({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  // One batched probe for every leaf the tiles name — not one hook per tile,
  // which would fan out six `/effective` GETs on a page that already fires
  // several.
  //
  // Hide only on a denial we actually RECEIVED (`allowed === false`), the same
  // optimistic-while-loading rule `CustomizeIndexPage` and the sidebar's
  // Customize row use: a slow probe must never blink a step away from someone
  // who does have access. It is also what lets the checklist paint at full
  // height on the first frame instead of growing a round-trip later.
  const caps = useProjectCans(projectId, PROJECT_SETUP_TILE_ACTIONS);
  const tiles = PROJECT_SETUP_TILES.filter((tile) =>
    tile.actions.every((action) => caps[action]?.allowed !== false),
  );

  // Resolves the project's account_id for the "Invite your team" step, which
  // routes into the account hub's Access tab. Same queryKey the pending access
  // requests bell uses — React Query dedupes against that cache entry when
  // both are mounted, and this is the only fetch when this component renders
  // alone (e.g. inside the instant session shell, which has no project-detail
  // query of its own).
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = projectDetailQuery.data?.project?.account_id;

  // Every step denied — render nothing rather than a band that still reserves
  // its gap in the column.
  if (tiles.length === 0) return null;

  return (
    <ProjectSetupChecklist
      projectId={projectId}
      className={className}
      steps={tiles.map((tile) => ({
        key: tile.key,
        title: tile.title,
        href: setupTileHref(tile, projectId, accountId),
      }))}
    />
  );
}
