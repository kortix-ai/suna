'use client';

/**
 * The project's GitHub repository cannot be reached (KRTX-2955): the Kortix
 * GitHub App was uninstalled or suspended on the GitHub owner, or the
 * repository was removed from it. The API stores that on the project's git
 * connection (`status: 'error'`, `last_error_code: <reason>`), so every
 * surface reads it off the project detail it already loads, and offers the
 * one fix: reconnect GitHub.
 *
 * Three placements share these parts: the Git settings banner, the sidebar
 * footer alert (project-wide), and the session page's start failure.
 */

import {
  getProjectDetail,
  getProjectGitConnectionState,
  repositoryDisconnectedReason,
  type ProjectGitConnection,
  type RepositoryDisconnectedReason,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { PlugsIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { useTranslations } from '../i18n';
import { customizePath } from '../lib/routes';
import { Button } from '../primitives/button';
import { InfoBanner } from '../primitives/info-banner';
import Loading from '../primitives/loading';
import { errorToast } from '../primitives/toast';
import { UiLink as Link } from '../providers/ui-provider';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
} from './sidebar/footer/sidebar-alert';

export interface RepositoryDisconnect {
  reason: RepositoryDisconnectedReason;
  /** GitHub owner (org or user), e.g. `acme`. */
  owner: string;
  /** `owner/name`. */
  repository: string;
}

/** The disconnect a git connection records, or null when it is healthy. */
export function repositoryDisconnectOf(
  connection: Pick<ProjectGitConnection, 'status' | 'last_error_code' | 'repo_owner' | 'repo_name'> | null | undefined,
): RepositoryDisconnect | null {
  const reason = repositoryDisconnectedReason(connection);
  if (!reason || !connection) return null;
  const owner = connection.repo_owner ?? '';
  return { reason, owner, repository: connection.repo_name ? `${owner}/${connection.repo_name}` : owner };
}

/** Reads the project detail the shell already caches; no extra request. */
export function useRepositoryDisconnect(projectId: string | null | undefined): RepositoryDisconnect | null {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    ...contract('config'),
  });
  return repositoryDisconnectOf(data?.git_connection);
}

/** The cause and who fixes it, in the viewer's language. */
export function RepositoryDisconnectText({ disconnect }: { disconnect: RepositoryDisconnect }) {
  const t = useTranslations('repositoryDisconnected');
  return <>{t(`reasons.${disconnect.reason}`, { owner: disconnect.owner, repository: disconnect.repository })}</>;
}

/**
 * Opens the GitHub App install page for the project's account. The link is
 * minted on click (it carries a 30-minute install state), and a missing link
 * falls back to the project's Git settings.
 */
export function ReconnectGitHubButton({ projectId, className }: { projectId: string; className?: string }) {
  const t = useTranslations('repositoryDisconnected');
  const [pending, setPending] = useState(false);
  const reconnect = async () => {
    setPending(true);
    try {
      const state = await getProjectGitConnectionState(projectId);
      if (state.install_url) window.open(state.install_url, '_blank', 'noopener,noreferrer');
      else window.location.assign(customizePath(projectId, 'settings?section=git'));
    } catch {
      errorToast(t('reconnectError'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Button size="sm" className={className} disabled={pending} onClick={() => void reconnect()}>
      {pending ? <Loading className="size-3.5 shrink-0" /> : null}
      {t('reconnect')}
    </Button>
  );
}

/** The inline alert: Git settings and the session page. */
export function RepositoryDisconnectedBanner({
  projectId,
  disconnect,
  fallbackMessage,
}: {
  projectId: string;
  disconnect: RepositoryDisconnect | null;
  /** The API's own sentence, for a caller that has no git connection to read. */
  fallbackMessage?: string;
}) {
  const t = useTranslations('repositoryDisconnected');
  return (
    <InfoBanner
      tone="warning"
      icon={PlugsIcon}
      title={t('title')}
      action={<ReconnectGitHubButton projectId={projectId} />}
    >
      {disconnect ? <RepositoryDisconnectText disconnect={disconnect} /> : fallbackMessage}
    </InfoBanner>
  );
}

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
          <Link href={customizePath(projectId, 'settings?section=git')}>{t('openSettings')}</Link>
        </Button>
      </SidebarAlertActions>
    </SidebarAlert>
  );
}

/** Project-wide: the sidebar footer shows it on every project page. */
export function ProjectRepositoryDisconnectedAlert({ projectId }: { projectId: string }) {
  return <ProjectRepositoryDisconnectedAlertView projectId={projectId} disconnect={useRepositoryDisconnect(projectId)} />;
}
