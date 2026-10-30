'use client';

/**
 * The project's GitHub repository cannot be reached (KRTX-2955). The shared
 * parts live in `internal/components/repository-disconnected.tsx`; this file
 * adds the project-wide sidebar footer alert and keeps the public deep export.
 */

import { PlugsIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../i18n';
import {
  ReconnectGitHubButton,
  RepositoryDisconnectText,
  useRepositoryDisconnect,
  type RepositoryDisconnect,
} from '../internal/components/repository-disconnected';
import { adminPath } from '../lib/routes';
import { Button } from '../primitives/button';
import { UiLink as Link } from '../providers/ui-provider';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
} from './sidebar/footer/sidebar-alert';

export * from '../internal/components/repository-disconnected';

/** Presentational sidebar alert, renderable under renderToStaticMarkup. */
export function ProjectRepositoryDisconnectedAlertView({
  projectId,
  disconnect,
  defaultOpen = false,
}: {
  projectId: string;
  disconnect: RepositoryDisconnect | null;
  defaultOpen?: boolean;
}) {
  const t = useTranslations('repositoryDisconnected');
  const [open, setOpen] = useState(defaultOpen);
  if (!disconnect) return null;
  return (
    <SidebarAlert
      tone="warning"
      icon={<PlugsIcon className="size-4" />}
      label={t('title')}
      open={open}
      onOpenChange={setOpen}
    >
      <SidebarAlertBody>
        <SidebarAlertText>
          <RepositoryDisconnectText disconnect={disconnect} />
        </SidebarAlertText>
      </SidebarAlertBody>
      <SidebarAlertActions>
        <ReconnectGitHubButton projectId={projectId} className="w-full" />
        <Button asChild size="sm" variant="ghost" className="w-full">
          <Link href={adminPath(projectId, 'git')}>{t('openSettings')}</Link>
        </Button>
      </SidebarAlertActions>
    </SidebarAlert>
  );
}

/** Project-wide: the sidebar footer shows it on every project page. */
export function ProjectRepositoryDisconnectedAlert({ projectId }: { projectId: string }) {
  return <ProjectRepositoryDisconnectedAlertView projectId={projectId} disconnect={useRepositoryDisconnect(projectId)} />;
}
