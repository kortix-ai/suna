'use client';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { useFolderAccess, useFolderPrincipals, useShareFolder, useUnshareFolder } from '@/hooks/drives/use-drives';
import { useTranslations } from '@/i18n/use-translations';
import type { FolderGrant, FolderLevel, FolderPrincipalType } from '@kortix/sdk';
import { RobotIcon, UserIcon, UsersFourIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

const LEVELS: FolderLevel[] = ['read', 'write', 'manage'];

function PrincipalIcon({ type }: { type: FolderPrincipalType }) {
  const cls = 'text-muted-foreground size-4 shrink-0';
  if (type === 'agent') return <RobotIcon className={cls} />;
  if (type === 'group') return <UsersThreeIcon className={cls} />;
  if (type === 'project') return <UsersFourIcon className={cls} />;
  return <UserIcon className={cls} />;
}

/**
 * Who has access to one folder of Files, like the access dialog of any other
 * Kortix resource: people, teams, agents and everyone in the project, each at
 * read, write or manage. A grant covers the folder and everything below it;
 * grants made on a folder above show as inherited and are changed there.
 */
export function FolderAccessDialog({
  driveId,
  path,
  open,
  onOpenChange,
}: {
  driveId: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('drives');
  const access = useFolderAccess(driveId, path, open);
  const principals = useFolderPrincipals(driveId, open);
  const share = useShareFolder();
  const unshare = useUnshareFolder();
  const [pick, setPick] = useState<string>('');
  const [level, setLevel] = useState<FolderLevel>('write');

  const canManage = access.data?.access === 'manage' && access.data.grantable;
  const grants = access.data?.grants ?? [];
  const own = grants.filter((g) => !g.inherited);
  const inherited = grants.filter((g) => g.inherited);
  const name = path === '/' ? t('files') : path.split('/').filter(Boolean).pop();

  const options = useMemo(() => {
    const p = principals.data;
    if (!p) return [] as Array<{ value: string; label: string; type: FolderPrincipalType }>;
    return [
      { value: 'project:', label: t('everyoneInProject'), type: 'project' as const },
      ...p.people.map((x) => ({ value: `user:${x.id}`, label: x.label, type: 'user' as const })),
      ...p.teams.map((x) => ({ value: `group:${x.id}`, label: x.label, type: 'group' as const })),
      ...p.agents.map((x) => ({ value: `agent:${x.id}`, label: t('agentLabel', { name: x.label }), type: 'agent' as const })),
    ];
  }, [principals.data, t]);

  const submit = (principalType: FolderPrincipalType, principalId: string | undefined, lvl: FolderLevel) =>
    share.mutate(
      { driveId, path, principalType, ...(principalId ? { principalId } : {}), level: lvl },
      {
        onSuccess: () => successToast(t('shared')),
        onError: (err) => errorToast(err instanceof Error ? err.message : t('shareFailed')),
      },
    );

  const add = () => {
    if (!pick) return;
    const [type, id] = pick.split(':') as [FolderPrincipalType, string];
    submit(type, id || undefined, level);
    setPick('');
  };

  const row = (g: FolderGrant) => (
    <li key={g.grantId} className="flex min-w-0 items-center gap-2 py-1.5">
      <PrincipalIcon type={g.principalType} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{g.principalType === 'agent' ? t('agentLabel', { name: g.label }) : g.label}</p>
        {g.inherited ? (
          <p className="text-muted-foreground truncate text-xs">{t('inheritedFrom', { path: g.path })}</p>
        ) : g.system && g.principalType === 'user' ? (
          <p className="text-muted-foreground truncate text-xs">{t('ownFolder')}</p>
        ) : null}
      </div>
      {canManage && !g.inherited && !(g.system && g.principalType === 'user') ? (
        <>
          <Select
            value={g.level}
            onValueChange={(v) => submit(g.principalType, g.principalType === 'project' ? undefined : g.principalType === 'agent' ? g.label : g.principalId, v as FolderLevel)}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {t(`level.${l}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('removeAccess', { name: g.label })}
            disabled={unshare.isPending}
            onClick={() =>
              unshare.mutate({ driveId, grantId: g.grantId }, { onError: () => errorToast(t('shareFailed')) })
            }
          >
            <XIcon />
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground shrink-0 text-xs">{t(`level.${g.level}`)}</span>
      )}
    </li>
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="sm:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('shareTitle', { name: name ?? '' })}</ModalTitle>
          <ModalDescription>{t('shareDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          {access.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              {canManage ? (
                <div className="flex items-center gap-2">
                  <Select value={pick} onValueChange={setPick}>
                    <SelectTrigger className="min-w-0 flex-1" aria-label={t('addAccess')}>
                      <SelectValue placeholder={t('addAccess')} />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={level} onValueChange={(v) => setLevel(v as FolderLevel)}>
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {t(`level.${l}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" size="sm" disabled={!pick || share.isPending} onClick={add}>
                    {t('share')}
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {access.data?.grantable === false ? t('notGrantable') : t('viewOnlyAccess')}
                </p>
              )}
              <ul className="divide-y">
                {own.map(row)}
                {inherited.map(row)}
                {grants.length === 0 ? <li className="text-muted-foreground py-2 text-sm">{t('noGrants')}</li> : null}
              </ul>
            </>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
