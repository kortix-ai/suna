'use client';

import { ProjectNavRow } from '../../../internal/layout/project-nav-row';

import { useTranslations } from '../../../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useUiPathname } from '../../../providers/ui-provider';
import { useCallback } from 'react';

import { CountBadge } from '../../../primitives/count-badge';
import { useProjectNavRows } from '../../../internal/layout/project-settings-nav';
import { useProjectDrive } from '../../../files/drives/use-drives';
import { getProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { FoldersIcon, HardDrivesIcon } from '@phosphor-icons/react';

import { filesRow } from '../../../internal/layout/files-nav-label';

/**
 * Top-level file entry, decided by `useProjectNavRows` (the same rule the
 * More menu and the Customize row read). With Volumes on it is Drive, the
 * shared folders, for every member: what each person sees follows folder
 * access, and the row carries their open conflict count. The repo browser is
 * then Customize → Repo, admins only. With Volumes off it is Files, the repo
 * browser, for a caller with `project.file.read` (editor-tier since IAM v1).
 * Absent until the probe answers.
 *
 * A real `<Link prefetch>`, not `router.push`. The button form could not be
 * prefetched, so every click paid for the route's RSC payload AND its JS chunk
 * cold — the bulk of a 5-6s open. `prefetch` needs `files/loading.tsx` to have
 * something to cache, because the project layout awaits cookies() and the
 * route is therefore dynamic. Note this is production-only behaviour: Next
 * disables Link prefetching under `next dev`.
 *
 * `HoverPrefetchLink`, not a bare `<Link>`: prefetching on mount made every
 * session open pay a full dynamic render of /files (2 requests, ~26KB) that
 * nobody asked for. The prefetch now starts on hover/focus/touch, which still
 * lands well before the click.
 *
 * Connectors / Skills / Commands used to sit beside this entry, one row each,
 * plus a Customize row below them. They are tabs of one `(capabilities)`
 * layout, so four rows bought nothing over one: ProjectCustomizeNavItem
 * replaced them and moved to the top of the panel, under New session.
 */
export function ProjectFilesNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const target = useProjectNavRows(projectId).files;
  const queryClient = useQueryClient();
  const tDrives = useTranslations('drives');
  const drive = useProjectDrive(projectId, target === 'drive');
  const conflicts = target === 'drive' ? (drive.data?.openConflicts ?? 0) : 0;
  const isActive =
    !!pathname &&
    (target === 'drive'
      ? /^\/projects\/[^/]+\/drive(\/|$)/
      : /^\/projects\/[^/]+\/files(\/|$)/
    ).test(pathname);

  // The Files view cannot pick a git ref (`resolveFilesRef`,
  // `project-layout/resolve-files-ref.ts`) until it knows the project's
  // default branch — one request, `qk.project.summary(id)` — unless a
  // per-project version selection is already persisted. Cold, that read
  // alone gates every other read on the page (branches, the file list,
  // change requests, file-content previews) behind ~1s nobody needed to
  // spend: this same intent signal already arms the ROUTE prefetch above
  // (`HoverPrefetchLink`), so arming the DATA prefetch alongside it means
  // `ref` is usually already resolvable by the time `ProjectFilesView`
  // mounts. Same key + same `contract('config')` options as that view's own
  // query, so this warms one cache slot rather than issuing a second fetch.
  const prefetchSummary = useCallback(() => {
    if (!projectId) return;
    void queryClient.prefetchQuery({
      queryKey: qk.project.summary(projectId),
      queryFn: () => getProject(projectId),
      ...contract('config'),
    });
  }, [projectId, queryClient]);

  // No project id means no valid href. The old onClick already no-op'd in this
  // case, so rendering a dead button was never useful.
  const row = target && projectId ? filesRow(projectId, target) : null;
  if (!row) return null;
  const { label, href } = row;

  return (
    <ProjectNavRow
      active={isActive}
      label={t(label)}
      href={href}
      prefetch

      onMouseEnter={prefetchSummary}
      onFocus={prefetchSummary}
      onTouchStart={prefetchSummary}
    >
      {label === 'drive' ? <HardDrivesIcon /> : <FoldersIcon />}
      {t(label)}
      {conflicts > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CountBadge
            count={conflicts}
            tone="conflict"
            aria-label={tDrives('conflictCount', { count: conflicts })}
          />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
