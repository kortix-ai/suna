'use client';

import { uiRoutes } from '../../lib/routes';
import { capabilityTabHref } from '../../internal/lib/capability-tab-routes';
import { useAppsRowVisible } from './footer/project-apps-nav';
import { filesRow } from '../../internal/layout/files-nav-label';
import {
  CustomizeGlyph,
  useProjectNavRows,
} from '../../internal/layout/project-settings-nav';
import { useTranslations } from '../../i18n';
import type { SidebarNavItemId } from '../../internal/stores/sidebar-nav-store';
import { AppWindowIcon, FoldersIcon, HardDrivesIcon } from '@phosphor-icons/react';
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
  const { customize: customizeTab, files: filesTarget } = useProjectNavRows(projectId);
  const appsVisible = useAppsRowVisible(projectId);

  // Memoized on the gates, not rebuilt per render: the Customize sidebar
  // modal memoizes its rows on this object, and a fresh one per render would
  // re-render every row on every drag frame.
  return useMemo(() => {
    const appsHref = uiRoutes().apps(projectId);
    const files = filesTarget ? filesRow(projectId, filesTarget) : null;
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
      ...(appsVisible && appsHref
        ? {
            apps: {
              label: tI18nComplete.raw('text89dd748442c1'),
              icon: <AppWindowIcon />,
              href: appsHref,
            },
          }
        : {}),
      ...(files
        ? {
            files: {
              label: t(files.label),
              icon: files.label === 'drive' ? <HardDrivesIcon /> : <FoldersIcon />,
              href: files.href,
            },
          }
        : {}),
    };
  }, [t, tI18nComplete, projectId, customizeTab, appsVisible, filesTarget]);
}
