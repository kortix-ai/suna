'use client';

import { Button } from '@kortix/ui/button';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useFolderAccess } from '@kortix/ui/files';
import { cn } from '@kortix/ui';
import { goalHref } from '@kortix/ui/workspace';
import type { ProjectGoal } from '@kortix/sdk';
import { LinkIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useMemo, useState, type ReactNode } from 'react';

import { FolderAccessDialog, GrantAvatar } from '@/features/drives/folder-access-dialog';
import { AdminOpens } from '@/features/drives/folder-access-panel';
import { folderAudience } from '@/features/drives/folder-audience';
import { useAuth } from '@/features/providers/auth-provider';
import { useTranslations } from '@/i18n/use-translations';

/**
 * Who can open a goal, and the way to change it. A goal is its folder in
 * Files, so its audience is the folder's: the person it belongs to, project
 * admins, and any agent the folder is shared with. One flat list, each row
 * the principal and its access on the right. Manage access opens the folder's
 * access dialog in place; Copy link copies its page (`/goals/<goal_id>`).
 */
export function GoalShareModal({
  projectId,
  goal,
  open,
  onOpenChange,
}: {
  projectId: string;
  goal: ProjectGoal;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('goals');
  const td = useTranslations('drives');
  const { user } = useAuth();
  const access = useFolderAccess(goal.driveId, goal.folder, open);
  const audience = useMemo(() => folderAudience(access.data?.grants ?? []), [access.data]);
  const canManage = access.data?.access === 'manage' && !!access.data?.grantable;
  const [managing, setManaging] = useState(false);

  const copyLink = async () => {
    const path = goalHref(projectId, goal);
    try {
      await navigator.clipboard.writeText(path ? new URL(path, window.location.origin).toString() : window.location.href);
      successToast(t('linkCopied'));
    } catch {
      errorToast(t('linkCopyError'));
    }
  };

  let body: ReactNode;
  if (access.isError) {
    body = <p className="text-muted-foreground text-sm">{t('shareLoadError')}</p>;
  } else if (access.isLoading || !access.data) {
    body = (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
    );
  } else if (!access.data.grantable) {
    body = <p className="text-muted-foreground text-sm text-pretty">{td('notGrantable')}</p>;
  } else {
    const everyone = audience.everyoneGrant ?? audience.inheritedEveryone;
    // Admins say something only on a person's own folder, or where nobody else is named.
    const showAdmins = !!audience.owner || (!everyone && audience.named.length === 0);
    body = (
      <>
      <ul className="-mx-2 flex flex-col" data-testid="goal-share-audience">
        {audience.owner ? (
          <ShareRow
            avatar={<GrantAvatar type="user" label={audience.owner.label} />}
            label={audience.owner.principalId === user?.id ? td('you') : audience.owner.label}
            role={t('shareOwner')}
          />
        ) : null}
        {everyone ? (
          <ShareRow
            avatar={<GrantAvatar type="project" label={td('everyoneInProject')} />}
            label={td('everyoneInProject')}
            role={td(`level.${everyone.level}`)}
          />
        ) : null}
        {audience.named.map((n) => (
          <ShareRow
            key={`${n.type}:${n.id}`}
            avatar={<GrantAvatar type={n.type} label={n.label} />}
            label={n.type === 'agent' ? td('agentLabel', { name: n.label }) : n.label}
            role={td(`level.${n.level}`)}
          />
        ))}
        {audience.inherited
          .filter((g) => g.principalType !== 'project' && g !== audience.owner)
          .map((g) => (
            <ShareRow
              key={g.grantId}
              muted
              avatar={<GrantAvatar type={g.principalType} label={g.label} />}
              label={g.principalType === 'agent' ? td('agentLabel', { name: g.label }) : g.label}
              meta={td('inheritedFrom', { path: g.path })}
              role={td(`level.${g.level}`)}
            />
          ))}
        {showAdmins ? (
          <ShareRow
            avatar={
              <span className="text-muted-foreground flex size-[22px] shrink-0 items-center justify-center">
                <ShieldCheckIcon className="size-4" aria-hidden />
              </span>
            }
            label={td('folderInfo.projectAdmins')}
            meta={audience.owner ? td('folderInfo.adminsOpenRecorded') : undefined}
            role={t('shareAdminsRole')}
          />
        ) : null}
      </ul>
      {audience.owner ? <AdminOpens driveId={goal.driveId} path={goal.folder} /> : null}
      </>
    );
  }

  return (
    <>
      <Modal open={open} onOpenChange={onOpenChange}>
        <ModalContent className="sm:max-w-md" data-testid="goal-share">
          <ModalHeader>
            <ModalTitle>{t('shareTitle')}</ModalTitle>
            <ModalDescription className="line-clamp-2 text-pretty">{goal.record.title}</ModalDescription>
          </ModalHeader>
          <ModalBody className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs font-medium">{t('shareAccessLabel')}</p>
            {body}
          </ModalBody>
          <ModalFooter className="flex-row justify-between sm:justify-between">
            {/* The link names the goal by its id: it opens for everyone the API lets read the goal. */}
            <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => void copyLink()} data-testid="goal-share-copy">
              <LinkIcon className="size-3.5 shrink-0" aria-hidden />
              {t('copyLink')}
            </Button>
            {access.data?.grantable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  setManaging(true);
                }}
                data-testid="goal-share-manage"
              >
                {canManage ? td('manageFolderAccess') : td('viewFolderAccess')}
              </Button>
            ) : null}
          </ModalFooter>
        </ModalContent>
      </Modal>
      <FolderAccessDialog driveId={goal.driveId} projectId={projectId} path={goal.folder} open={managing} onOpenChange={setManaging} />
    </>
  );
}

/** One principal: its avatar, its name (and a note under it), and its access on the right. */
function ShareRow({ avatar, label, meta, role, muted }: { avatar: ReactNode; label: string; meta?: string; role: string; muted?: boolean }) {
  return (
    <li className="flex min-h-10 items-center gap-2.5 rounded-md px-2 py-1.5">
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('truncate text-sm', muted ? 'text-muted-foreground' : 'text-foreground')}>{label}</span>
        {meta ? <span className="text-muted-foreground truncate text-xs">{meta}</span> : null}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs">{role}</span>
    </li>
  );
}
