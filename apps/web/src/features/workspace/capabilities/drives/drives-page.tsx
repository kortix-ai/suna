'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { SubjectRow, useProjectSessionAgents } from '@/features/drives/drive-access-dialog';
import { DRIVE_KIND_ICON } from '@/features/drives/drive-icons';
import { type DriveRecord, canManageDrive, formatBytes } from '@/features/drives/drive-model';
import { driveMountPath } from '@/features/drives/drive-mount';
import { EmptyState } from '@/features/layout/section/empty-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { agentHref } from '@/features/workspace/capabilities/shared/capability-tab-routes';
import {
  useDriveAvailability,
  useDrives,
  useSetDriveSubjectGrant,
} from '@/hooks/drives/use-drives';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { HardDrivesIcon } from '@phosphor-icons/react';
import Link from 'next/link';

/**
 * Customize → Drives: which drives this project's sessions and agents may
 * use. A drive holds files (the Drive page); here a project connects to it.
 *
 * - Company drives: on for every session of the project, or only for some of
 *   its agents, read-only or read-write. Account owners and admins change it.
 * - Agent drives: one per agent, mounted in every session of that agent.
 * - Personal drives are not connected here: each person's own drive mounts
 *   in the sessions they start.
 */
export function DrivesCapabilityPage({ projectId }: { projectId: string }) {
  const t = useTranslations('drives');
  const availability = useDriveAvailability(projectId);
  const drives = useDrives(projectId, availability.enabled);
  const agents = useProjectSessionAgents(projectId);
  const list = drives.data ?? [];
  const company = list.filter((drive) => drive.kind === 'company');
  const agentDrives = list.filter((drive) => drive.kind === 'agent');

  return (
    <CapabilityPageShell
      title={t('customizeTitle')}
      description={t('customizeDescription')}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href={`/projects/${projectId}/drive`}>{t('openDrive')}</Link>
        </Button>
      }
    >
      {!availability.enabled && !availability.isLoading ? (
        <EmptyState
          icon={HardDrivesIcon}
          title={t('unavailableTitle')}
          description={t('unavailableDescription')}
        />
      ) : drives.isLoading || availability.isLoading ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      ) : (
        <div className="space-y-8">
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">{t('companyDrives')}</h2>
              <p className="text-muted-foreground text-xs text-pretty">
                {t('customizeCompanyHint')}
              </p>
            </div>
            {company.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noCompanyDrives')}</p>
            ) : (
              company.map((drive) => (
                <CompanyDriveCard
                  key={drive.driveId}
                  drive={drive}
                  projectId={projectId}
                  agents={agents.names}
                />
              ))
            )}
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">{t('agentDrives')}</h2>
              <p className="text-muted-foreground text-xs text-pretty">{t('customizeAgentHint')}</p>
            </div>
            {agentDrives.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noAgentDrives')}</p>
            ) : (
              <ul className="bg-popover divide-y rounded-md border">
                {agentDrives.map((drive) => (
                  <AgentDriveRow key={drive.driveId} drive={drive} projectId={projectId} />
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-1">
            <h2 className="text-sm font-medium">{t('myDrives')}</h2>
            <p className="text-muted-foreground text-xs text-pretty">
              {t('customizePersonalHint')}
            </p>
          </section>
        </div>
      )}
    </CapabilityPageShell>
  );
}

function CompanyDriveCard({
  drive,
  projectId,
  agents,
}: {
  drive: DriveRecord;
  projectId: string;
  agents: string[];
}) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const setGrant = useSetDriveSubjectGrant();
  const manage = canManageDrive(drive);
  const fail = () => errorToast(t('grantFailed'));
  const KindIcon = DRIVE_KIND_ICON.company;
  const agentAccess = (name: string) =>
    drive.agentGrants?.find((g) => g.agentName === name)?.access ?? null;

  return (
    <article className="bg-popover space-y-3 rounded-md border p-4">
      <header className="flex items-center gap-2.5">
        <KindIcon className="text-muted-foreground size-4 shrink-0" />
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{drive.name}</p>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">
          {driveMountPath(drive)}
        </span>
        {typeof drive.sizeBytes === 'number' ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {formatBytes(drive.sizeBytes, locale)}
          </span>
        ) : null}
      </header>
      <SubjectRow
        label={t('customizeAllSessions')}
        description={
          drive.projectAccess ? t('customizeAllSessionsOn') : t('customizeAllSessionsOff')
        }
        access={drive.projectAccess ?? null}
        disabled={!manage || setGrant.isPending}
        onChange={(access) =>
          setGrant.mutate(
            { driveId: drive.driveId, subject: { type: 'project', projectId }, access },
            { onError: fail },
          )
        }
      />
      {agents.length ? (
        <div className="space-y-2 border-t pt-3">
          <p className="text-muted-foreground text-xs">{t('customizeOnlyAgents')}</p>
          {agents.map((name) => (
            <SubjectRow
              key={name}
              label={name}
              access={agentAccess(name)}
              disabled={!manage || setGrant.isPending}
              onChange={(access) =>
                setGrant.mutate(
                  {
                    driveId: drive.driveId,
                    subject: { type: 'agent', projectId, agentName: name },
                    access,
                  },
                  { onError: fail },
                )
              }
            />
          ))}
        </div>
      ) : null}
      {manage ? null : <p className="text-muted-foreground text-xs">{t('grantAdminOnly')}</p>}
    </article>
  );
}

function AgentDriveRow({ drive, projectId }: { drive: DriveRecord; projectId: string }) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const KindIcon = DRIVE_KIND_ICON.agent;
  return (
    <li className="flex items-center gap-2.5 px-4 py-2.5">
      <KindIcon className="text-muted-foreground size-4 shrink-0" />
      <Link
        href={`${agentHref(projectId, drive.agentName ?? drive.name)}?section=drive`}
        className="min-w-0 flex-1 truncate text-sm hover:underline"
      >
        {drive.name}
      </Link>
      {drive.openConflicts ? (
        <span className="text-kortix-orange shrink-0 text-xs">
          {t('conflictCount', { count: drive.openConflicts })}
        </span>
      ) : null}
      <span className="text-muted-foreground shrink-0 text-xs">
        {typeof drive.fileCount === 'number' ? t('fileCount', { count: drive.fileCount }) : null}
        {typeof drive.sizeBytes === 'number' ? ` · ${formatBytes(drive.sizeBytes, locale)}` : null}
      </span>
    </li>
  );
}
