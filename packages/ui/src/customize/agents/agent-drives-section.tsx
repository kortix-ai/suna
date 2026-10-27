'use client';

import type { AgentMount, DriveEntry, FolderLevel } from '@kortix/sdk';
import { useAgentMounts, useProjectMounts } from '@kortix/sdk/react';
import { CaretRightIcon, FolderSimpleIcon, HardDrivesIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useDriveFolder, useFolderAccess, useProjectDrive, useShareFolder, useUnshareFolder } from '../../files/drives/use-drives';
import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import Hint from '../../primitives/hint';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast } from '../../primitives/toast';
import { ManageButton } from '../sections/view/agent-editor-access-fields';
import { EditorList } from '../sections/view/agent-editor-primitives';
import { CapabilityPageShell } from '../shared/capability-page-shell';

/**
 * Drives as mounts, ONE component in two modes (Marko, 2026-10-27: "folder
 * mount based, exactly", "one component, agent-based or project-wide"):
 *
 *  - **Project** (Project admin → Drives): the folders EVERY new session
 *    mounts, the ones shared with everyone in the project.
 *  - **Agent** (Access → Drives): what a new session of this agent mounts,
 *    its own folders plus the project's.
 *
 * Each row is one folder a new session mounts: where
 * it appears (`/drives/...`), which Files folder it is, who it comes through
 * (this agent, or everyone in the project) and whether it is read-only. The
 * list is the server's own plan (`GET /drives/:id/agents/:name/mounts`, the
 * functions a session boot runs), so it never guesses.
 *
 * Mounting, changing the level and unmounting share or unshare the folder
 * with the agent at once, the same grant Files > Share makes; they do not
 * wait for the page's Save. A folder that comes through the project is
 * changed in Files, where its sharing lives.
 */
export function AgentDrivesSection({
  projectId,
  agentName,
  repositoryAccess = true,
}: {
  projectId: string;
  /** Absent: the project's mounts (Project admin). */
  agentName?: string;
  /** Whether sessions of the agent get the project repository at /workspace. Agent mode only. */
  repositoryAccess?: boolean;
}) {
  const t = useTranslations('agentMounts');
  const drive = useProjectDrive(projectId);
  const driveId = drive.data?.driveId ?? null;
  const agentPlan = useAgentMounts(agentName ? driveId : null, agentName ?? '');
  const projectPlan = useProjectMounts(agentName ? null : driveId);
  const plan = agentName ? agentPlan : projectPlan;
  const showRepository = !!agentName && repositoryAccess;
  const root = useFolderAccess(driveId, '/');
  // Mounting needs `manage` on the folder; someone who holds it at the top holds it below.
  const canMount = root.data?.access === 'manage';
  const [picking, setPicking] = useState(false);

  let body;
  if (drive.isLoading || plan.isLoading) {
    body = (
      <EditorList>
        {[0, 1].map((i) => (
          <li key={i} className="flex min-h-12 items-center gap-3 px-4 py-2">
            <Skeleton className="h-4 w-48 rounded-sm" />
          </li>
        ))}
      </EditorList>
    );
  } else if (drive.isError || plan.isError || !driveId || !plan.data) {
    body = (
      <ErrorState
        size="sm"
        title={t('loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void plan.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (plan.data.mounts.length === 0 && !showRepository) {
    body = (
      <EmptyState media={<EmptyArt icon={HardDrivesIcon} />} title={t('emptyTitle')} description={t('emptyDescription')} />
    );
  } else {
    body = (
      <div className="space-y-3">
        <EditorList>
          {showRepository ? (
            <li className="flex min-h-12 items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate font-mono text-sm">/workspace</span>
                <span className="text-muted-foreground block truncate text-xs">{t('repository')}</span>
              </span>
              <span className="text-muted-foreground shrink-0 text-xs">{t('readWrite')}</span>
            </li>
          ) : null}
          {plan.data.mounts.map((mount) => (
            <MountRow key={mount.path} driveId={driveId} agentName={agentName} mount={mount} />
          ))}
        </EditorList>
        {plan.data.skipped.length > 0 ? (
          <p className="text-muted-foreground text-xs text-pretty">
            {t('skipped', { slots: plan.data.slots, list: plan.data.skipped.join(', ') })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <CapabilityPageShell
      title={t('title')}
      description={agentName ? t('lead') : t('projectLead')}
      action={
        <>
          {canMount && driveId ? (
            <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => setPicking(true)}>
              <PlusIcon className="size-3.5 shrink-0" />
              {t('mount')}
            </Button>
          ) : null}
          <ManageButton href={(id) => uiRoutes().drive(id)} />
        </>
      }
    >
      <div data-testid="drive-mounts">{body}</div>
      {driveId ? (
        <FolderPicker
          open={picking}
          onOpenChange={setPicking}
          driveId={driveId}
          agentName={agentName}
          mounted={new Set(plan.data?.mounts.map((m) => m.path))}
        />
      ) : null}
    </CapabilityPageShell>
  );
}

/** The level a mount gives: read only, or read and write. `manage` mounts read and write. */
const levelValue = (level: FolderLevel): 'read' | 'write' => (level === 'read' ? 'read' : 'write');

/** Who a mount is shared with: the agent, or everyone in the project. */
const principalOf = (agentName: string | undefined) =>
  agentName ? ({ principalType: 'agent', principalId: agentName } as const) : ({ principalType: 'project' } as const);

function MountRow({ driveId, agentName, mount }: { driveId: string; agentName?: string; mount: AgentMount }) {
  const t = useTranslations('agentMounts');
  const share = useShareFolder();
  const unshare = useUnshareFolder();
  const access = useFolderAccess(driveId, mount.path, !!mount.grantId);
  const canChange = !!mount.grantId && access.data?.access === 'manage';
  const [confirming, setConfirming] = useState(false);
  const pending = share.isPending || unshare.isPending;

  const setLevel = async (level: FolderLevel) => {
    try {
      await share.mutateAsync({ driveId, path: mount.path, ...principalOf(agentName), level });
    } catch {
      errorToast(t('changeFailed'));
    }
  };
  const unmount = async () => {
    try {
      await unshare.mutateAsync({ driveId, grantId: mount.grantId! });
      setConfirming(false);
    } catch {
      errorToast(t('changeFailed'));
    }
  };

  const who = mount.via === 'agent' ? t('viaAgent') : t('viaProject');
  return (
    <li className="flex min-h-12 items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate font-mono text-sm">{mount.mountPath}</span>
        <span className="text-muted-foreground block truncate text-xs">{t('from', { path: mount.path, who })}</span>
      </span>
      {canChange ? (
        <>
          <Select value={levelValue(mount.level)} onValueChange={(v) => void setLevel(v as FolderLevel)} disabled={pending}>
            <SelectTrigger size="sm" className="w-36 shrink-0" aria-label={t('levelFor', { path: mount.path })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="read">{t('readOnly')}</SelectItem>
              <SelectItem value="write">{t('readWrite')}</SelectItem>
            </SelectContent>
          </Select>
          <Hint label={t('unmountLabel', { path: mount.path })}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('unmountLabel', { path: mount.path })}
              onClick={() => setConfirming(true)}
              disabled={pending}
            >
              <XIcon className="size-4" />
            </Button>
          </Hint>
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            title={t('unmountTitle', { path: mount.mountPath })}
            description={agentName ? t('unmountDescription', { agent: agentDisplayName(agentName) }) : t('unmountProjectDescription')}
            confirmLabel={t('unmount')}
            confirmVariant="destructive"
            isPending={unshare.isPending}
            onConfirm={() => void unmount()}
          />
        </>
      ) : (
        <span className="text-muted-foreground shrink-0 text-xs">{mount.readOnly ? t('readOnly') : t('readWrite')}</span>
      )}
    </li>
  );
}

/** Pick a folder in Files and the level, then mount it for the agent. */
function FolderPicker({
  open,
  onOpenChange,
  driveId,
  agentName,
  mounted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  driveId: string;
  agentName?: string;
  mounted: ReadonlySet<string>;
}) {
  const t = useTranslations('agentMounts');
  const [path, setPath] = useState('/');
  const [level, setLevel] = useState<'read' | 'write'>('write');
  const folder = useDriveFolder(open ? driveId : null, path);
  const share = useShareFolder();
  // Personal folders under /Users are their owners' to share, never a mount to pick here.
  const dirs = (folder.data?.entries ?? []).filter(
    (e: DriveEntry) => e.type === 'dir' && !(path === '/' && /^\/?Users$/.test(e.path)),
  );
  const crumbs = path.split('/').filter(Boolean);

  const close = (next: boolean) => {
    if (share.isPending) return;
    if (!next) setPath('/');
    onOpenChange(next);
  };
  const mount = async () => {
    try {
      await share.mutateAsync({ driveId, path, ...principalOf(agentName), level });
      close(false);
    } catch {
      errorToast(t('changeFailed'));
    }
  };

  return (
    <Modal open={open} onOpenChange={close}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('pickerTitle')}</ModalTitle>
          <ModalDescription>{agentName ? t('pickerDescription', { agent: agentDisplayName(agentName) }) : t('pickerProjectDescription')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <nav aria-label={t('pickerPath')} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <button type="button" className="text-muted-foreground hover:text-foreground rounded-sm" onClick={() => setPath('/')}>
              {t('pickerRoot')}
            </button>
            {crumbs.map((name, i) => (
              <span key={i} className="flex items-center gap-1">
                <CaretRightIcon aria-hidden className="text-muted-foreground size-3" />
                <button
                  type="button"
                  className={i === crumbs.length - 1 ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}
                  onClick={() => setPath(`/${crumbs.slice(0, i + 1).join('/')}`)}
                >
                  {name}
                </button>
              </span>
            ))}
          </nav>
          <EditorList className="max-h-72 overflow-y-auto">
            {folder.isLoading ? (
              <li className="flex min-h-10 items-center px-4 py-2">
                <Skeleton className="h-4 w-40 rounded-sm" />
              </li>
            ) : dirs.length === 0 ? (
              <li className="text-muted-foreground px-4 py-3 text-sm">{t('pickerEmpty')}</li>
            ) : (
              dirs.map((entry: DriveEntry) => {
                const next = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
                return (
                  <li key={next}>
                    <button
                      type="button"
                      onClick={() => setPath(next)}
                      className="hover:bg-hover flex min-h-10 w-full items-center gap-2 px-4 py-2 text-left text-sm"
                    >
                      <FolderSimpleIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                      <span className="text-foreground min-w-0 flex-1 truncate">{entry.name}</span>
                      {mounted.has(next) ? <span className="text-muted-foreground text-xs">{t('alreadyMounted')}</span> : null}
                      <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                    </button>
                  </li>
                );
              })
            )}
          </EditorList>
        </ModalBody>
        <ModalFooter className="flex items-center justify-between gap-2">
          <Select value={level} onValueChange={(v) => setLevel(v as 'read' | 'write')}>
            <SelectTrigger size="sm" className="w-36" aria-label={t('levelFor', { path })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">{t('readOnly')}</SelectItem>
              <SelectItem value="write">{t('readWrite')}</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => void mount()} disabled={path === '/' || share.isPending} aria-busy={share.isPending}>
            {path === '/' ? t('pickerChoose') : t('pickerMount', { path })}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
