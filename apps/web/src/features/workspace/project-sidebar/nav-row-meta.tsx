'use client';

import {
  capabilityTabHref,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { repoNavLabel } from '@/features/workspace/project-sidebar/footer/files-nav-label';
import {
  CustomizeGlyph,
  useCapabilityTab,
} from '@/features/workspace/project-sidebar/project-settings-nav';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan, useProjectPageCans } from '@/lib/use-project-can';
import type { SidebarNavItemId } from '@/stores/sidebar-nav-store';
import { useFeatureFlag } from '@kortix/sdk/react';
import {
  AlarmIcon,
  AppWindowIcon,
  FoldersIcon,
  GitBranchIcon,
} from '@phosphor-icons/react';
import { useMemo, type ReactNode } from 'react';

export interface NavRowMeta {
  label: string;
  icon: ReactNode;
  href: string;
}

/**
 * Label, glyph, destination and availability of every customizable nav row,
 * read through the same gates the sidebar rows use. A row this project does
 * not offer (flag off, permission denied) is absent from the result, so the
 * Customize sidebar modal and the More menu never list a dead row.
 */
export function useNavRowMeta(projectId: string): Partial<Record<SidebarNavItemId, NavRowMeta>> {
  const t = useTranslations('sidebar');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const customizeTab = useCapabilityTab(projectId);
  const reminders = useFeatureFlag(projectId, 'reminders');
  const volumes = useFeatureFlag(projectId, 'drives');
  // KRTX-2444: Review merged into the Repo page, so there is no Review row.
  // The Repo row opens for a review-only viewer too — `project.file.read` is
  // editor-tier, but plain members hold `project.review.read` (floor-tier)
  // and land on the merged page's review section. Optimistic while the files
  // probe loads, like every row.
  const canReview = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_REVIEW_READ).allowed === true;
  const canReadFiles = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_FILE_READ];
  const filesLabel = repoNavLabel(volumes.enabled);
  const filesListed = canReadFiles.allowed || canReadFiles.isLoading || canReview;

  // Memoized on the gates, not rebuilt per render: the Customize sidebar
  // modal memoizes its rows on this object, and a fresh one per render would
  // re-render every row on every drag frame.
  return useMemo(() => {
    const base = `/projects/${projectId}`;
    return {
      ...(customizeTab
        ? {
            customize: {
              label: t('customize'),
              icon: <CustomizeGlyph />,
              href: capabilityTabHref(projectId, customizeTab),
            },
          }
        : {}),
      apps: {
        label: tI18nComplete.raw('text89dd748442c1'),
        icon: <AppWindowIcon />,
        href: `${base}/apps`,
      },
      ...(reminders.enabled
        ? { reminders: { label: t('reminders'), icon: <AlarmIcon />, href: `${base}/reminders` } }
        : {}),
      ...(filesListed
        ? {
            files: {
              label: t(filesLabel),
              icon: filesLabel === 'repo' ? <GitBranchIcon /> : <FoldersIcon />,
              href: `${base}/files`,
            },
          }
        : {}),
    };
  }, [
    t,
    tI18nComplete,
    projectId,
    customizeTab,
    reminders.enabled,
    filesListed,
    filesLabel,
    // `canReview` rides in through `filesListed`; listing it here too would be
    // an unnecessary dep (eslint react-hooks/exhaustive-deps).
  ]);
}
