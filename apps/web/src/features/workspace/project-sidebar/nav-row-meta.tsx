'use client';

import { capabilityTabHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import { useAppsRowVisible } from '@/features/workspace/project-sidebar/footer/project-apps-nav';
import { useRoomsRowVisible } from '@/features/workspace/project-sidebar/footer/project-rooms-nav';
import { filesRow } from '@/features/workspace/project-sidebar/footer/files-nav-label';
import {
  CustomizeGlyph,
  useProjectNavRows,
} from '@/features/workspace/project-sidebar/project-settings-nav';
import { useTranslations } from '@/i18n/use-translations';
import type { SidebarNavItemId } from '@/stores/sidebar-nav-store';
import { AppWindowIcon, ChatsTeardropIcon, FoldersIcon, HardDrivesIcon } from '@phosphor-icons/react';
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
  const roomsVisible = useRoomsRowVisible(projectId);

  // Memoized on the gates, not rebuilt per render: the Customize sidebar
  // modal memoizes its rows on this object, and a fresh one per render would
  // re-render every row on every drag frame.
  return useMemo(() => {
    const base = `/projects/${projectId}`;
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
      ...(appsVisible
        ? {
            apps: {
              label: tI18nComplete.raw('text89dd748442c1'),
              icon: <AppWindowIcon />,
              href: `${base}/apps`,
            },
          }
        : {}),
      ...(roomsVisible
        ? {
            rooms: {
              label: t('rooms'),
              icon: <ChatsTeardropIcon />,
              href: `${base}/rooms`,
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
  }, [t, tI18nComplete, projectId, customizeTab, appsVisible, roomsVisible, filesTarget]);
}
