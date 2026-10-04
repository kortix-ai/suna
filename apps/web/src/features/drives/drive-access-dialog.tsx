'use client';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { useAccountMembers } from '@/features/accounts/hub/use-account-members';
import { useAuth } from '@/features/providers/auth-provider';
import {
  useDriveGrants,
  useRemoveDriveGrant,
  useSetDriveSubjectGrant,
} from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { XIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { DriveAccess, DriveGrantRecord, DriveRecord } from './drive-model';

/** The project's agents that start sessions (subagents never own one). */
export function useProjectSessionAgents(projectId: string) {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const agents = (detail.data?.config?.agents ?? []) as Array<{
    name: string;
    mode?: string | null;
  }>;
  return {
    isLoading: detail.isLoading,
    names: agents.filter((agent) => agent.mode !== 'subagent').map((agent) => agent.name),
  };
}

/**
 * Who a drive reaches, for whoever manages it.
 *
 * - A company drive (account owner or admin): this project, people, and this
 *   project's agents. Each grant mounts the drive in the matching sessions.
 * - Your personal drive: people you share it with (read or write), and the
 *   agents you let write all of it in your sessions (by default agents only
 *   write its From agents folder).
 */
export function DriveAccessDialog({
  drive,
  projectId,
  open,
  onOpenChange,
}: {
  drive: DriveRecord;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('drives');
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('accessTitle', { name: drive.name })}</ModalTitle>
          <ModalDescription>
            {drive.kind === 'personal'
              ? t('accessPersonalDescription')
              : t('accessCompanyDescription')}
          </ModalDescription>
        </ModalHeader>
        {open ? <DriveAccessBody drive={drive} projectId={projectId} /> : null}
      </ModalContent>
    </Modal>
  );
}

function DriveAccessBody({ drive, projectId }: { drive: DriveRecord; projectId: string }) {
  const t = useTranslations('drives');
  const { user } = useAuth();
  const grants = useDriveGrants(drive.driveId);
  const members = useAccountMembers(drive.accountId, true);
  const agents = useProjectSessionAgents(projectId);
  const setGrant = useSetDriveSubjectGrant();
  const removeGrant = useRemoveDriveGrant();
  const [pick, setPick] = useState<string>('');
  const [pickAccess, setPickAccess] = useState<DriveAccess>('read');

  const list = useMemo(() => grants.data ?? [], [grants.data]);
  const people = list.filter((g) => g.type === 'user');
  const projectGrant = list.find((g) => g.type === 'project' && g.projectId === projectId) ?? null;
  const otherProjects = list.filter((g) => g.type === 'project' && g.projectId !== projectId);
  const agentGrant = (name: string) =>
    list.find((g) => g.type === 'agent' && g.projectId === projectId && g.agentName === name) ??
    null;
  const candidates = (members.data ?? []).filter(
    (m) =>
      m.user_id !== drive.ownerUserId &&
      m.user_id !== user?.id &&
      !people.some((g) => g.userId === m.user_id),
  );
  const personal = drive.kind === 'personal';
  const busy = setGrant.isPending || removeGrant.isPending;
  const fail = () => errorToast(t('grantFailed'));

  const remove = (grant: DriveGrantRecord) =>
    removeGrant.mutate({ driveId: drive.driveId, grantId: grant.grantId }, { onError: fail });

  return (
    <ModalBody className="space-y-5">
      {grants.isLoading ? (
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-8 w-full rounded-md" />
          <Skeleton className="h-8 w-full rounded-md" />
        </div>
      ) : (
        <>
          {!personal ? (
            <section className="space-y-2">
              <h3 className="text-muted-foreground text-xs font-medium">
                {t('accessThisProject')}
              </h3>
              <SubjectRow
                label={t('grantTitle')}
                description={
                  projectGrant
                    ? t('grantDescription', { path: drive.mountPath ?? '' })
                    : t('grantDescriptionOff')
                }
                access={projectGrant ? projectGrant.access : null}
                disabled={busy}
                onChange={(access) =>
                  setGrant.mutate(
                    { driveId: drive.driveId, subject: { type: 'project', projectId }, access },
                    { onError: fail },
                  )
                }
              />
              {otherProjects.map((grant) => (
                <GrantRow
                  key={grant.grantId}
                  label={grant.projectName ?? t('unknownProject')}
                  access={grant.access}
                  disabled={busy}
                  onRemove={() => remove(grant)}
                />
              ))}
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">{t('accessPeople')}</h3>
            <p className="text-muted-foreground text-xs text-pretty">
              {personal ? t('accessPeoplePersonalHint') : t('accessPeopleCompanyHint')}
            </p>
            {people.map((grant) => (
              <div key={grant.grantId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {grant.userEmail ?? grant.userId}
                </span>
                <AccessSelect
                  value={grant.access}
                  disabled={busy}
                  onChange={(access) =>
                    setGrant.mutate(
                      {
                        driveId: drive.driveId,
                        subject: { type: 'user', userId: grant.userId! },
                        access,
                      },
                      { onError: fail },
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('removeAccess', { name: grant.userEmail ?? '' })}
                  disabled={busy}
                  onClick={() => remove(grant)}
                >
                  <XIcon className="size-4 shrink-0" />
                </Button>
              </div>
            ))}
            {members.isError ? (
              <p className="text-muted-foreground text-xs">{t('membersUnavailable')}</p>
            ) : candidates.length ? (
              <div className="flex items-center gap-2">
                <Select value={pick} onValueChange={setPick}>
                  <SelectTrigger aria-label={t('addPerson')} className="min-w-0 flex-1">
                    <SelectValue placeholder={t('addPerson')} />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.email ?? m.user_id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <AccessSelect value={pickAccess} disabled={busy} onChange={setPickAccess} />
                <Button
                  type="button"
                  size="sm"
                  disabled={!pick || busy}
                  onClick={() =>
                    setGrant.mutate(
                      {
                        driveId: drive.driveId,
                        subject: { type: 'user', userId: pick },
                        access: pickAccess,
                      },
                      { onSuccess: () => setPick(''), onError: fail },
                    )
                  }
                >
                  {t('share')}
                </Button>
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">{t('accessAgents')}</h3>
            <p className="text-muted-foreground text-xs text-pretty">
              {personal ? t('accessAgentsPersonalHint') : t('accessAgentsCompanyHint')}
            </p>
            {agents.names.map((name) => {
              const grant = agentGrant(name);
              return personal ? (
                <div key={name} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  <Switch
                    checked={!!grant}
                    disabled={busy}
                    aria-label={t('agentFullWrite', { name })}
                    onCheckedChange={(on) =>
                      setGrant.mutate(
                        {
                          driveId: drive.driveId,
                          subject: { type: 'agent', projectId, agentName: name },
                          access: on ? 'write' : null,
                        },
                        { onError: fail },
                      )
                    }
                  />
                </div>
              ) : (
                <SubjectRow
                  key={name}
                  label={name}
                  access={grant ? grant.access : null}
                  disabled={busy}
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
              );
            })}
          </section>
        </>
      )}
    </ModalBody>
  );
}

function AccessSelect({
  value,
  disabled,
  onChange,
}: {
  value: DriveAccess;
  disabled?: boolean;
  onChange: (access: DriveAccess) => void;
}) {
  const t = useTranslations('drives');
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as DriveAccess)}
    >
      <SelectTrigger aria-label={t('accessLabel')} className="w-40 shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="write">{t('accessWrite')}</SelectItem>
        <SelectItem value="read">{t('accessRead')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** On/off plus access for one subject (this project, one agent). */
export function SubjectRow({
  label,
  description,
  access,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  access: DriveAccess | null;
  disabled?: boolean;
  onChange: (access: DriveAccess | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={access !== null}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={(on) => onChange(on ? 'write' : null)}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{label}</p>
        {description ? (
          <p className="text-muted-foreground text-xs text-pretty">{description}</p>
        ) : null}
      </div>
      {access ? <AccessSelect value={access} disabled={disabled} onChange={onChange} /> : null}
    </div>
  );
}

function GrantRow({
  label,
  access,
  disabled,
  onRemove,
}: {
  label: string;
  access: DriveAccess;
  disabled?: boolean;
  onRemove: () => void;
}) {
  const t = useTranslations('drives');
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {access === 'read' ? t('accessRead') : t('accessWrite')}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('removeAccess', { name: label })}
        disabled={disabled}
        onClick={onRemove}
      >
        <XIcon className="size-4 shrink-0" />
      </Button>
    </div>
  );
}
